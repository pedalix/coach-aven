# Design

## Context

What exists (`ingest-learning-loop`, on the canary): the daemon re-derives the loop from the tenant checkout on every
build; `attribution({learn: true})` shows the ranked question groups (`questions[]`: `{group, units, value, guess,
form}`) and the day's audit sample (`audits[]`: unit ids); evidence is a person's ledger line (`annotations.ts`:
`owner`, the tenant's owner literal, or `human:<id>`, with `answer`, `guess`, `conf`, `rung`, `audit`) or a line of
`labels.jsonl`. The tenant checkout (`src/sources/tenant.ts`) is a shallow clone on the ingest host — `fetch --depth 1`
+ `reset --hard FETCH_HEAD` before every build, read-only by convention; the sandbox's own clone is the one that commits.
The sources tools are one static table (`snapshot/plain/sources-mcp.mjs`) answered over the replica: on the bot's
worker thread (`hostrouter.ts`), forwarded verbatim to the daemon's `/mcp/<slug>` (`daemonclient.ts`), or by `orch
sources serve`. A host tool call knows its session's project and conversation (`HostCaller`), not the person whose
message the turn answers. Whoever ingests a project holds `data/<slug>/.lock` (`lock.ts`).

## Decisions

### D1. Two tools, one table, served by the writer only

`ask` and `answer` join the `sources` table (the next minor), so every face lists the same tools with the same schemas — but
only the process that ingests the project (the lock holder: the daemon, or the bot's poller) has a **writer**
(`{ask, answer}`) to serve them with. `handleMessage(msg, dbPath, writer?)` routes the two to the writer and everything
else to the replica as today; a face without a writer — the stdio server, `orch sources serve` — answers the two with
`error: not served on this face`, so the `sources-remote-access` promise "no tool may write" holds.

Which face has a writer follows the two switches of `docs/runtime-config.md` → *Sources daemon*, and they are
independent, so an installation has one of three shapes: **the bot ingests** (neither switch) — the bot's channel router
hands the two to the writer in its own process; **the bot forwards** (`sources.daemon` on the project) — the daemon,
which holds the lock, hands them to its own writer; and **a same-host daemon without forwarding** (`SOURCES_DAEMON=1` on
the bot, no `sources.daemon` on the project) — the daemon ingests and the bot answers from the replica it writes, holding
no lock, no writer and no path to the daemon. That third shape is a read-only face like the other two: the channel route
answers the two with `not served on this face` and names `sources.daemon` as the fix, since the daemon is reachable only
by forwarding. Nothing is guessed from the lock file: a face serves the two when it was built with a writer, and only the
lock holder builds one.

This is a deliberate departure from two parity promises — `sources-remote-access` "identical inputs, outputs" over HTTP
and `host-tools` "identical to the stdio server's" over the channel — which the tools added since joined silently (the
lists there still end at `stuck`). Both get a MODIFIED delta in this change: parity holds for every tool except `ask` and
`answer`, which a read-only face answers with `not served on this face`; the parity test of task 5.1 proves the rest.

Why not a second server: the agent already knows `sources`; a second name means a second registration, a second
prompt paragraph and a second forwarding path for two tools.

### D2. The numbered post is host data, not tenant data

A post is a numbering of question ids and audit unit ids together with what the loop said at that moment — the guess,
each unit's confidence and rung instance, the covered units. It is data about a conversation, not a decision, so it
lives beside the pins (`data/<slug>/attribution/asks.jsonl`: append-only, one line per post, pruned after seven days)
and never in the tenant repo. It survives a bot restart and a lost session, because the person's reply arrives as a new
turn, possibly hours later. The evidence line records the post's guess, confidence and rung — what the machine proposed
when it **asked** — not the loop's say at answer time: a build in between may have moved them, and the honest `guess` is
the one the person saw.

Ids. A post id is short, per project and carries the day (`q20261016-2`): the person may see it in the agent's message.
A question id is the loop's group id (a client-day, a key, a case, with its chunk), an audit id is `audit:<unit id>`;
both are stable within a day. The **answer id** written to the ledger is the question's, not the post's —
`q:<day>:<group>` and `audit:<day>:<unit>` — so a question posted twice in one day and answered twice is one
observation (`answerOfLine` reads the field as is).

What `ask` returns per item: `{n, id, kind: question | audit, unit: fragment | item, form, guess, units: […]}`. A
fragment unit is `{id, day, title, minutes}`, the title as `att_fragments` holds it — the `attribution` readout's own
heading, under its own rule ("titles carry no message text"). An item unit is **structural fields only**: `{id, day,
type, source, container, sender, case, hint}` — exactly what the item readout (`attribution({unit: 'item'})`) shows and
what the tenant-tooling path builds its posts from today; the `hint` is the floor's (a host, a key prefix, a domain, a
cue letter), never a quote. Not the store's `subject` column, although it reads like a heading: for a Teams channel
reply the normaliser derives it from the parent's **body** (`re: <the parent's first 60 characters>…`,
`msgraph/normalise.ts`), and `att_items` has no subject column precisely because the readout never needed one — a
subject in the post would be a new exposure, on disk in `asks.jsonl` and in the tool's reply. A `subject` MAY ride on an
item only when the store marks the row's subject as the mail's own, never a derived one; no such marker exists today
(`messages.subject` holds a mail's subject, a channel post's subject and the derived `re:` line alike), so the first
version shows no item subject at all — marking mail subjects at normalise time is a follow-up (6.4), and it is what would
make the run titles' rule exact too (a run's title today joins its messages' subjects). What the person reads is the
agent's chat message, worded from the agent's own `get` of the ref under the tenant's prompt; the post on disk and the
tool's reply carry structure only, and never a message body, a transcript line or a reply text. `questions` not in
today's queue are listed as unknown; `max` caps the total (default 5); the order is the caller's, audits after
questions.

### D3. Mechanical resolution; judgement goes back to the agent

`answer({post, text})` resolves the reply with a fixed grammar and nothing else — no model, no fuzzy matching beyond the
grammar — because the person's words become evidence lines signed with their id, and a line must be what they said, not
what a model took them to mean:

- items are addressed by number: `1 yes`, `1: yes`, `2 — shop`, `1-3 ok`, `1,4 none`, one per line or separated by
  commas or semicolons;
- a confirm word (`yes`, `y`, `ok`, `👍`, `да`, `ja`, `sì`, `oui`, `+`) confirms the item's guess — for a `confirm`
  item only (a `choose` item has no guess); a reject word (`no`, `n`, `нет`, `nein`, `-`) alone resolves nothing: the
  loop needs a label, and "no" without one is a follow-up question;
- a label: an exact id of the label space, else a token that matches exactly one entry by its last segment or its
  registry name (case-folded), else a special label by word (`none`, `personal`, `unregistered`);
- anything else — a sentence, a name two initiatives share, a number the post does not have — comes back as
  `unresolved: [{n, text}]`, and an item the reply does not mention is untouched.

The agent then asks again or, when the meaning is plain, passes structured items against the same post
(`answer({post, items: [{question: n | id, label}]})`, `[{question, confirm: true}]`). **`post` is required in both
forms**: the post is the one source of a line's guess, confidence, rung and day (D2) and of its answer id (D5), and the
rationale names its item — without a post there is no recorded guess to be honest about, no day for `q:<day>:<group>`
and nothing for `agent-read reply to <post>#n` to point at. An answer a person volunteers before anything was asked goes
through `ask` first: it writes host data only, costs nothing and pins what the machine said at that moment; a call with
`items` and no `post` is refused as malformed and writes nothing. Both forms are attested the same way (D4) and write the
same lines, but the line says which it was — `rationale: "reply to q20261016-2#3: \"shop\""` against `rationale:
"agent-read reply to q20261016-2#3"` — so a reader of the ledger can tell which answers had a model between the person
and the line.

### D4. Attestation: only the platform says who answered

A line's decider is `human:<person_id>`, and the platform alone decides which person. The chain: the chat driver
normalises the author of the message the turn answers (`actor.user` — the Slack user id; Teams' `from.id` with its
`aadObjectId`); the turn engine records it as the session's **turn actor** while that turn runs (routines, dreams and
dispatched turns have none); the host router stamps it on every sources call as `params._meta.actor` (`{platform,
user, aad?, email?}`), overwriting whatever the agent sent (`HostCaller` gains `actor()`, read per call: the caller is
fixed when the session opens, the actor changes per turn); the writer maps it against the people file of the checkout
it serves — an identity of the platform user id first (`slack:<user id>`, `msgraph:<aad object id>`; a new identity
form for Slack, matched like any other key), else the e-mail when the driver could look it up (Slack `users.info` with
`users:read.email`, cached per user; a Teams UPN through Graph where permitted). The daemon trusts `_meta.actor`
because only the bot reaches `/mcp/<slug>` (the bearer) and the bot always overwrites it; `_meta` is where MCP puts
request metadata, so the forwarded message stays a plain tools/call.

No mapping → **refused**, nothing written, the reply naming the identity to add. Not "recorded as unattested": an
unattested line in `fragments.jsonl` would still **decide** the fragment for the plan (any line does; an unknown decider
reads as `model`) while being no evidence — the very machine-line state the one-writer contract exists to avoid — and
a silent non-evidence line looks as if it worked. A refusal is loud and cheap: the person adds themselves to the people
file once. A turn without an actor (a routine answering its own question) is refused the same way: an answer is
recorded only in a turn a person started.

The agent passes no `by`: the input schema has none and the writer ignores one. Who may answer: anyone the people file
knows — the turn already passed the drive gate (`gates.ts`); a tenant that wants fewer answerers lists fewer people. An
`answerers` list in attribution.json is a follow-up if a team tenant needs it.

### D5. Lines, recompute in the call, read-your-writes

Per answered question, one line per covered unit (the post's units; a group holds at most twelve):

- fragment — `{id, kind, start, end, refs, attributions: [{initiative: <label>, share: 1}], decided_by:
  "human:<id>", rationale, decided_at, status: "decided", answer, guess, conf, rung, audit?}`; kind, window and refs
  copied from the plan's row (`att_fragments`) so the line stands on its own as the tenant CLI's lines do; a special
  label is written as the single attribution, which is how the loop already reads such a line;
- item — `{ref, task: "t1-item", label, by: "human:<id>", answer, guess, conf, rung, audit?, at}`.

Appended to the checkout's files (created when missing), one append per call, never rewriting or reordering a line.
Then the writer runs the build's derived steps without the pullers: the ledger text is in both fingerprints
(`derived_fingerprint`, `att:fingerprint`), so the initiative index, the plan, item mode and the loop recompute exactly
as a build would, and the replica is published — about half a second on the home store, a second more with item mode.
The reply is read from the fresh tables: `decided` (lines written), `already` (idempotent skips), `calibration`
(instances whose mean moved or that are demoted now), `questions_left` and `audits_left` for today, `unresolved`,
`refused` (a label outside the space, with the nearest ids). The agent's next `attribution({learn: true})` therefore
shows the units as `answered` — no "wait for the next build", and the person can be told what their answer moved.

Idempotence: before writing, the writer reads the live ledger; a unit that already has a person's live line with the
same answer id and label is skipped (`already`); a different label is a correction and gets a line (a person's later
line wins). The same reply sent twice — the agent retried, the person pasted it again — writes nothing the second time.

Label space: `labelSpace(registry, admin)` of the checkout as the loop reads it — the registry's ids (no alias, no
split), the admin buckets, the three special labels. A label outside it is refused per item and never learned: a
one-answer key type (family, thread, host, app) would spread a typo to every later unit of its key.

Serialization: the writer runs `answer` as a job on the project's pass queue (the ticker's `pulling` set), so a pass in
flight finishes first and the next tick skips a project whose answer is in flight; a wait beyond the call's budget
(`SOURCES_CALL_MS`) answers `busy` and writes nothing — the call is idempotent, the agent retries.

### D6. One writer, and a person's line is final

While `learn.writer` is `platform`, the tenant's tooling must not write the two ledger files — a documented contract;
the platform refuses nothing (it cannot see the sandbox). The layer's defence is in the parse (`annotations.ts`
`parseFragments`, read by the plan, the initiative index, the loop and the lab alike): per id, a line by a machine
(`rule`, `model`, an unknown literal) never replaces a live line a person decided; a person's later line does (a
correction supersedes), and so does a person's `superseded`. This is the fix for the known limitation "a later ledger
line still replaces a person's", and the first of the two contracts `docs/attribution.md` lists before live.
`labels.jsonl` already works this way (`parseLabels`), so the two ledgers end up under one rule.

### D7. The checkout as a writer's clone

With `SOURCES_TENANT_WRITE=1` in the ingest process's env, `syncTenant` becomes: `fetch --depth 1 origin <ref>` as
today; with local commits, `rebase --onto FETCH_HEAD <previous head>` then `push origin HEAD:refs/heads/<branch>`;
without, `reset --hard FETCH_HEAD` as today.

**The push target is a branch name, resolved once per pass, right after the fetch.** With `sources.tenant.ref` it is
that name — the key names a branch to track (`types.ts` says so), and it must come back from `ls-remote origin
refs/heads/<ref>`: a tag or a commit id tracks fine but is no push target. Without it, today's fetch asks for `HEAD`
(`fetchArgs`: `t.ref ?? 'HEAD'`), and a push to the same word would not fail — `git push origin HEAD:HEAD` creates a
branch literally named `HEAD` on the tenant repo (verified on a bare repo: `* [new branch] HEAD -> HEAD`; the qualified
`HEAD:refs/heads/HEAD` does the same), which the next `fetch origin HEAD` then follows instead of the default branch:
every answer would land on a stray branch no clone of the default branch ever sees, the checkout would diverge silently
and the pull would still log `(rebased, pushed)`. So without `ref` the writer resolves the remote's default branch with
`git ls-remote --symref origin HEAD` (first line `ref: refs/heads/<name>\tHEAD`), under the same one-shot token header as
the fetch — not `git symbolic-ref refs/remotes/origin/HEAD`: that ref is whatever the clone recorded, stale after a
rename of the default branch, never updated by a `fetch origin HEAD`, and absent altogether after a `clone --branch`.
The name must pass `check-ref-format --branch` (which refuses `HEAD`) and is kept with the pass's checkout state
(`TenantSync.pushRef`). **When the resolution fails** — no `ref:` line (a detached or unborn remote HEAD), a `ref` the
remote has no branch for, an `ls-remote` that errors — the pass has no push target: it logs that, pushes nothing, and
the writer **refuses `answer`** for the project until a pass resolves one, naming the cure (`set sources.tenant.ref`)
and writing nothing, so the checkout stays exactly as read-only as today instead of accumulating commits that could
never be pushed. An unpushed commit from an earlier pass keeps its retry — the rebase needs no target, only the push
does. A test over a bare remote pins that it never gains a ref named `HEAD`, with and without `ref`.

A rebase conflict can only be in a ledger file — the platform commits nothing else — and is
resolved mechanically: the remote's file, then the local commits' lines re-appended (append-only, so the order between
the two sides is immaterial, except for one id decided on both sides, which the one-writer contract rules out). Anything
else (a rebase that fails for another reason, a corrupt checkout) leaves the checkout at the remote and logs the dropped
lines in full — ids and labels, never message text — for an operator to replay. Without the flag the function issues
exactly today's git commands, and a test pins the sequence.

Commit and push per `answer` call: one commit (`attribution: <n> answers by human:<id> (<post>)`, the bot's own git
identity as `memjournal.ts` commits with), then a push with a token minted for that push — `getGitHubToken` scoped to
the tenant repo with the agent's permissions (`contents: write` ∩ granted), passed as the one-shot `http.extraheader`
exactly as the fetch passes its token, never stored in `.git/config` or a remote URL. A failed push (network, a
non-fast-forward) is logged and left to the next pull's rebase + push; the checkout is the truth meanwhile: the tables
already carry the answer and every build reads the checkout, not the remote. Considered and not taken: push-before-pull
on every pass — the same retry, but an unpushed commit stays invisible until the next pass, while the rebase makes the
state explicit in the pull's log line (`(rebased 1, pushed)`).

### D8. Gates, and what stays byte-identical

Per tenant: `learn.writer: "platform"` (`config.ts` `parseLearn`; absent = `"tenant"`; any other value fails the parse
at build time as the other `learn` keys do). The rules version ignores `learn`, so the pins of closed days are unchanged
by the key. `ask` works whenever the loop is on (it writes host data only); `answer` needs `writer: "platform"` **and**
the installation flag **and** a push target the last pass resolved (D7), and refuses otherwise naming the missing gate.
Per installation: `SOURCES_TENANT_WRITE=1`, documented in `docs/runtime-config.md` beside `SOURCES_DAEMON` — whose third
shape (D1: `SOURCES_DAEMON=1` without `sources.daemon`) leaves the bot with no writer at all, so there both tools answer
`not served on this face` and name `sources.daemon`, whatever the flag says. The base system prompt's sources paragraph
does not name the two tools — the golden prompt fixtures stay byte-identical and prod's sources project sees no changed
prompt; the tenant's routine prompt tells the review to use them, which is tenant data. `tools/list` grows by two for
every sources project (the table is static); every other tool's answer is unchanged (parity test over the same replica —
the parity the two MODIFIED deltas of D1 now promise with exactly these two exceptions).

## Risks / Trade-offs

- [The platform holds a write credential for tenant data] → the credential exists today (the App mints `contents:
  write` for every sandbox); what is new is a host process using it. Scoped per push to one repo; the flag names the
  installation that may; the platform writes two append-only files and nothing else; every write names a person in the
  commit message and in the line.
- [A model between the person and the line] → the mechanical path records only what the grammar resolved; the
  structured path marks its lines `agent-read`; audits — drawn on the loop's own decisions, never on answers — keep
  measuring precision honestly either way.
- [An answer during a pass] → serialized on the writer's queue; `busy` beyond the budget, nothing written.
- [Two people answer one question differently] → two person lines, the later wins (a correction); the loop counts the
  later. Nothing more to decide here.
- [Teams e-mail lookup] → best-effort; `msgraph:<aad object id>` in the people file is the dependable mapping.
- [The daemon's lock holder is a long-lived process with a write token in memory] → the token is minted per push and
  dropped after it; nothing is cached.

## Migration Plan

Merge: prod untouched (both gates off; the parse rule of D6 is prod-inert unless a prod tenant's ledger carries a
machine line after a person's for the same id — counted on the frozen corpora before merge, expected zero, the count
goes into the ledger row). Canary (the home tenant), after the tenant-tooling path has run for a few days: the daemon's
`.env` gets `SOURCES_TENANT_WRITE=1` (restart the daemon); the tenant sets `"writer": "platform"` and adds the owner's
`slack:<user id>` identity to its people file; the evening review posts an `ask`; the owner replies in the thread; the
answer commit appears in the tenant repo within the call; the next pull logs a fast-forward; `attribution({learn:
true})` counts the answer under `agreement`. Then the tenant's own tooling stops writing the two files (its CLI keeps
every other ledger). Rollback: remove the flag and the key — the checkout returns to fetch + hard reset at the next pull;
lines already pushed stay evidence; an unpushed commit is lost on the reset and said so in the log.
