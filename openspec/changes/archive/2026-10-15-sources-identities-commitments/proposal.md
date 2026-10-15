# Proposal

## Why

The owen-ops review still reads the store file for two steps: `identities --write` (who is who: deterministic merges of identities into people, yes/no questions for the rest) and `commitments extract` (the subject's promises from every recorder's next steps). Owen's doctrine (2026-10-14/15): no files in sandboxes, no exceptions, tenant logic tenant-independent. Both steps are deterministic and generic — people resolution is already the platform's (the store resolves identities from the tenant's people file) and next steps come from the platform's recorders — so they become platform readouts. Then the tenant's store loader goes and the owen-ops sandbox is recreated without its mount.

## What Changes

- **Identities readout** `identities()` in the sources table, computed in the store build from the store's observations (message authors, event and meeting attendees, task assignees/reporters) against the tenant's people file: deterministic **merges** (the same full name in any order; a mailbox that is the glued full name; a unique first name seen together with the person or under their domain/company), **questions** (a yes/no with the best guesses once the identity talked with the subject; "who is" for an unknown seen at least five times with the subject), most-seen first, and counts (mapped, candidates, dormant, system senders, opaque ids). Ported from the owen-ops collector with the same ids.
- **Commitments readout** `commitments({since, until})`: the window's calls with every recorder copy's next steps parsed per recorder (Granola "step (Owner)", Wispr "(Owner) step", Gemini "[Owner] step" until "Details"), unioned per call and deduped by normalised text, as proposed rows `{id: c-<hash(call|text)>, owner, to, what, call, provenance}` — `owner` is the subject when the step's owner is one of the subject's names or addresses (from the people file). Same ids as the owen-ops extractor.
- Both readouts need the tenant's attribution config (its `subject`); without it the tools say "not configured". Sources MCP 1.9.0.

## Capabilities

### Modified Capabilities
- `attribution`: identities and commitments readouts for the subject.

## Impact

`src/sources/identities/` (new: normalise, match, collect, observations), `src/sources/commitments.ts` (new), `src/sources/attribution/build.ts` (writes `att_identities`, schema unchanged: tables created if missing), `snapshot/plain/sources-mcp.mjs` (two tools), docs. Tenant side (owen-ops): `identities apply --json`, `commitments add --json`, prompt; then its store loader is deleted and the container recreated mount-free.
