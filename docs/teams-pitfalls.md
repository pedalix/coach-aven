# Microsoft Teams bot pitfalls — constraints, behaviours, and how the SDK / OSS handle them

> Research notes behind the Teams driver (OpenSpec `teams-chat-driver`), gathered 2026-10-16 from
> Microsoft's docs, the Teams SDK and open-source bot projects. Every fact carries its source; the
> closing checklist says which rules the driver already honours and which are still open. Read
> this before touching `src/chat/teams/` — the rules that are not in any API type live here.

Researched 2026-10-16 for the CoachAven Teams driver (`@microsoft/teams.apps` 2.1.0 → Bot Connector,
single-tenant Azure Bot). Primary sources are Microsoft Learn (msteams-platform docs, dated
2026-06…2026-10 unless noted), the Teams SDK docs/repo (`microsoft/teams.ts`), the installed
SDK code in `node_modules/@microsoft/teams.*@2.1.0`, and issue trackers of Microsoft's own bot
repos. Secondary sources (community Q&A, third-party integrations) are marked as such.

Abbreviations: **MS** = learn.microsoft.com, **SDK** = Teams SDK for TypeScript (teams.ts),
**Connector** = Bot Connector REST API (`{serviceUrl}/v3/...`).

Sources referenced repeatedly:

- [S1] Conversations with an agent (message size, splitting, update/delete, status-code table)
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/build-conversational-capability
  (the old `bots/how-to/update-and-delete-bot-messages` URL now redirects here)
- [S2] Format agent messages https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages
- [S3] Rate limiting https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit
- [S4] Channel and group conversations (mentions, threads) https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- [S5] Proactive messages https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- [S6] Format text in cards https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format
- [S7] Card types reference https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-reference
- [S8] Dialogs from bots https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/task-modules/task-modules-bots and https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/task-modules/invoking-task-modules
- [S9] Files https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
- [S10] Receive all messages (RSC) https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages
- [S11] Conversation events https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/subscribe-to-conversation-events
- [S12] Targeted messages https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/targeted-messages
- [S13] Streaming https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- [S14] SDK: Sending messages https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/sending-messages/overview
- [S15] SDK: Proactive messaging https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/sending-messages/proactive-messaging
- [S16] Universal Action model https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/universal-action-model and Teams view https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/work-with-universal-actions-for-adaptive-cards
- [S17] Bot concepts (15-second retry) https://learn.microsoft.com/en-us/microsoftteams/platform/bots/bot-concepts
- [S18] Deep links https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-teams
- [S19] Multi-geo serviceUrl blog (2021) https://devblogs.microsoft.com/microsoft365dev/updates-for-microsoft-teams-bots-in-multi-geo-environments/
- [S20] Bot Connector send/receive https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages
- [S21] SDK: Message reactions https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/in-depth-guides/message-reactions
- [S22] Agent 365 message handling (typing indicator numbers) https://learn.microsoft.com/en-us/microsoft-agent-365/developer/message-handling
- [S23] Shared & private channels https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels
- [S24] Apps for guests/external users https://learn.microsoft.com/en-us/microsoftteams/apps-external-users
- [S25] RSC overview https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent
- [S26] Suggested actions https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/suggested-actions
- [S27] Invoke 5-second rule (message-extension page, same rule for all invokes) https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/action-commands/respond-to-task-module-submit
- [S28] Legacy v3 text formats (archived) https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bots-text-formats
- [S29] Legacy v3 proactive REST examples (archived) https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bot-conversations/bots-conv-proactive
- [S30] OfficeDev/BotBuilder-MicrosoftTeams#126 "Activity resulted into multiple skype activities" https://github.com/OfficeDev/BotBuilder-MicrosoftTeams/issues/126
- [S31] Teams context / roster paging https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/get-teams-context
- [S32] Card actions https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions
- [S33] Designing cards (six primary actions) https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/design-effective-cards

---

## 1. Message and card limits

**Text / activity size**
- Bot message size limit is **~100 KB**, counted as UTF-16 and including text, image links,
  @-mentions and reactions; base64 images excluded. MS: "ensure that the size of the message
  itself is within **80 KB** to guarantee successful message delivery." Violation → **HTTP 413
  `RequestEntityTooLarge`, error code `MessageSizeTooBig`**, not retryable. [S1][S2]
- The widely quoted **28 KB** limit is for **Incoming Webhooks / Power Automate connector
  posts**, not bot messages: "ensure that the message size limit doesn't exceed 28 KB for
  Incoming Webhooks and 100 KB for a bot message." [S6]
- Streaming has its own size error: `403 ContentStreamNotAllowed "Message size too large"`.
  Informative updates ≤ 1 KB / 1000 chars. [S13]
- **Message splitting**: "when a text message and an attachment are sent in the same activity
  payload. Teams splits this activity into two separate activities… you do not receive the
  message ID in response, which is used to update or delete the message… It is recommended to
  send separate activities." It also counts as extra requests against the rate limit ("Message
  splitting at the service level results in higher than expected RPS"). [S1][S3]

**Adaptive Card payload / schema**
- "Teams platform supports **v1.6 or earlier** of Adaptive Card features for bot sent cards";
  mobile "supports Adaptive Cards up to version 1.6. Cards that use schema versions later than
  1.6 might not render correctly." [S7]
- Not supported in Teams: positive/destructive action styling; `isEnabled` on `Action.Submit`;
  file/image upload elements inside cards. [S7]
- **Actions**: "An Adaptive Card supports up to **six primary actions** to be viewed on the
  card. Any additional primary action is viewed in the overflow menu" (`mode: "secondary"`
  puts an action in the `…` overflow explicitly). Hero/thumbnail/list cards: max six buttons;
  "Hero and thumbnail cards with multiple actions are automatically split into multiple cards in
  a carousel"; carousels and list collections: max **10 cards per message**. [S6][S7][S33]
- Images: ≤ 1024×1024 px, < 1 MB, PNG/JPEG/GIF; animated GIF and SVG not supported; **redirecting
  image URLs are not supported**; host on a CDN. [S6][S7]
- Universal actions require card `version` ≥ 1.4 (Adaptive Cards spec) — the Teams page says
  "must be set to 1.5"; older clients won't render `Action.Execute` unless a `fallback`
  `Action.Submit` is present and wrapped in an `ActionSet`. [S16]

**TextBlock markdown subset (cards)**
- Supported in `TextBlock`, `Fact.Title`, `Fact.Value`: bold `**`, italic `_x_`, unordered and
  ordered lists, hyperlinks `[t](url)`. **Not supported: headers, tables, images, preformatted
  text (code), blockquotes.** "HTML isn't supported in Adaptive Cards." [S6]
- Line breaks: "use the `\r` or `\n` escape sequences for newlines **in lists**. Using `\n\n` in
  lists causes the next element in the list to be indented. If you require newlines elsewhere
  in the TextBlock, use `\n\n`." Rendering differs desktop vs iOS vs Android. [S6]
- Code in cards: use the `CodeBlock` element (v1.5; web/desktop only; shows first 10 lines then
  **Expand**; `\n` in `codeSnippet` is a line break — escape as `\\n` to show it literally).
  Tables in cards: the `Table` element (`showGridLines`). Emoji: supported as UTF-16; "If you
  use REST APIs, then set `charset=UTF-8`". Full-width card: `"msteams": {"width": "Full"}`. [S6]

**`textFormat` modes for plain messages**
- Default (`markdown` or unset) recognises only: `**bold**`, `*italic*`, `[link](url)` plus HTML
  `<b> <strong> <i> <em> <u> <s> <br> <hr> <a href> <img src>`. [S2]
- `extendedmarkdown` (opt-in, **per message**) adds fenced code blocks with syntax highlighting,
  KaTeX math, markdown images, `[#]` citations, **GFM tables**, task lists, headings (the doc's
  own example is `### Sprint update`) and "progressive rendering" when streaming. "It's opt-in
  because it's not fully backwards compatible with the default formatting behavior, and does
  not support arbitrary HTML." Recommended for LLM output; "Remove any usage of HTML". [S2]
- Legacy: `xml` = "basic HTML subset (no Markdown syntax)"; `plain` = raw text. [S2]
- Legacy v3 table (still the behaviour of default mode): "Text-only messages do not support
  table formatting"; headers not supported in text-only; lists render on desktop but not
  iOS/Android; `~~strike~~` desktop+iOS only. [S28]
- Picture messages: "In Markdown, the image size defaults to 256×256"; use
  `<img src height width>` to size. GCC-High/DoD: embed images as base64. [S1]

---

## 2. Edit / update rules

- API: `PUT {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` with a full
  activity; response `{ "id": "<activityId>" }`. "A bot can't update or delete messages sent by
  the user." You must cache the activity id returned by the original POST. [S1]
- SDK: `api.conversations.activities(conversationId).update(activityId, activity)`; also
  `send(new MessageActivityInput(text).withId(id))` routes through the update path
  (`ActivitySender.dispatch`: `if (payload.id) … updateActivity`, verified in
  `teams.apps@2.1.0/dist/activity-sender.js`). [S14]
- **Type changes**: the pre-2026 MS page said "It is not necessary for the new message to match
  the original in type. For example, if the original message contains an attachment, the new
  message can be a simple text message" (msteams-docs commit f5b5230, file
  `bots/how-to/update-and-delete-bot-messages.md`). Microsoft's own 2018 answer is more
  cautious and still the operative rule [S30]:
  > "The code is trying to update a message (1 card) to something that's going to become 2
  > messages (text + card). That's why it's giving the error 'Activity resulted into multiple
  > skype activities'. … message updates are restricted to instances that will not result in
  > splitting. In fact, I'd recommend only text->text or card->card updates, because
  > card->text or vice versa is also problematic. (It works, but you could see some ugly visual
  > artifacts until the thread is refreshed.)"
  The issue is still open (never "enabled"). So: **an update may carry text OR attachments, not
  both**; text↔card swaps work but may leave stale rendering until the client refreshes.
- Updating a card after a button press: use the inbound `replyToId` as the activity id. [S1]
- `Action.Execute` (universal actions): the **invoke response** card
  (`type: application/vnd.microsoft.card.adaptive`) "the client should display in place of the
  current one" — for the **invoking user only**; everyone else sees the new card only via
  `updateActivity` or the `refresh` mechanism (`userIds` ≤ **60** MRIs; `userIds: []` → manual
  "Refresh card" menu item; omitting `userIds` auto-refreshes only when the chat/channel has
  ≤ 60 members). `Action.Submit` cannot return a new card. [S16]
- **Targeted-message edits**: "Recipient data was included in an update or delete operation,
  where it is not allowed" → `400 Bad argument`; concrete wire error `BadArgument: Cannot edit
  Recipient of Targeted Message` (teams.ts#738, fixed: the SDK now strips `recipient` on
  targeted updates). Visibility cannot change; after **24 h** the message is gone and updates
  return `404 ActivityNotFoundInConversation`. [S12] https://github.com/microsoft/teams.ts/issues/738
- No documented age limit for editing normal bot messages. Failure codes: `404
  ActivityNotFoundInConversation` ("Message doesn't exist or it is deleted… Remove the ID if it
  was cached"), `404 ConversationNotFound`, and **`412 PreconditionFailed` "due to multiple
  concurrent operations on the same conversation" → retry with exponential backoff**. [S1]
- Channels vs 1:1: same API; the conversation id for a channel reply is
  `<channelId>;messageid=<rootId>` (see §4). Community reports of `400` when an id with a
  stray `;messageid=` suffix was used as the *activity* id (Power Automate thread) — keep
  activity ids and conversation ids separate. (secondary)
- Pacing: "Plain updates are subject to ordinary activity throttling rather than the streaming
  path's allowance, so pace them at a cadence measured in seconds rather than sending one per
  token." [S14]
- Alternative for 1:1 only: the **streaming API** (typing activities with `streaminfo`,
  `streamSequence` 1..n, final `message` without `streamSequence`), one stream per chat, 1 rps,
  **two-minute window from the first chunk** (`403 ContentStreamNotAllowed … exceeded streaming
  time`), each chunk must contain the previous text, final message may carry attachments /
  AI labels / feedback buttons. SDK `stream.emit()` coalesces at ~500 ms and after the window
  `stream.close()` finishes by updating the message in place. [S13][S14]
  teams.ts#687 (fixed): the SDK's final message wrongly carried `streamSequence`.
  https://github.com/microsoft/teams.ts/issues/687

---

## 3. Rate limits and 429s

Per bot per thread (a thread = one 1:1, one group chat, or one channel) [S3]:

| Operation | 1 s | 2 s | 30 s | 3600 s |
| --- | --- | --- | --- | --- |
| Send to conversation | 7 | 8 | 60 | 1800 |
| Create conversation | 7 | 8 | 60 | 1800 |
| Get conversation members | 14 | 16 | 120 | 3600 |
| Get conversations | 14 | 16 | 120 | 3600 |

- All bots per thread: send 14/1 s, 16/2 s; members/conversations 28/1 s, 32/2 s. [S3]
- "The global limit per app per tenant is **50 Requests Per Second**." "All requests are
  subject to the same rate limiting policy, including sending messages, channel enumerations,
  and roster fetches." Values "are subject to change" — always back off. [S3]
- `429 Throttled` "Also returns when to retry after" → "Retry using `Retry-After` header to
  determine the wait time in seconds… Otherwise, retry using exponential backoff with thread ID,
  if possible." Also retry **412, 502, 503, 504** with exponential backoff (jitter recommended);
  do **not** retry 400/401/403/404/413/500. [S1][S3]
- Special limits: tag mentions 2 messages / 5 s per bot per thread, ≤ 10 tags per message [S4];
  reactions **2 per second** [S21]; streaming 1 request/s and `429 "API calls quota exceeded"`
  [S13]; legacy non-paged `getMembers` throttled to 5 req/min [S3].
- **SDK 2.1.0 does not retry plain sends/updates** and surfaces raw axios errors
  (`err.response.status`, `err.response.data`, `err.response.headers['retry-after']`); only the
  streaming path retries (5 attempts, 500 ms→4 s, "a blind retry… the SDK does not read
  `Retry-After` or treat `429` specially"). Verified: no retry logic in
  `teams.common/dist/http/client.js`; `teams.apps/dist/utils/promises/retry.js` is used only by
  `http-stream.js`. [S14]
- Roster: use paged member retrieval (page 50–500, default 200); "Pagination isn't supported in
  chat conversations." [S31]

---

## 4. Reply chains, ids, serviceUrl

- Conversation id shapes (all from recorded payloads in MS docs): personal 1:1 `a:1qhNLq…`
  [S5]; group chat `19:…@unq.gbl.spaces` / `@thread.v2` [S18]; channel `19:…@thread.tacv2`
  (older `@thread.skype`); a **channel thread** is `19:…@thread.tacv2;messageid=<rootId>`.
  Activity/message ids are epoch-millisecond strings (`"1632474074231"`). The General channel id
  equals the team id. [S4][S18][S31]
- SDK helper `toThreadedConversationId(conversationId, messageId)` strips any existing
  `;messageid=` suffix then appends (`teams.apps/dist/utils/thread.js`); `app.reply(convId,
  rootMessageId, activity)` builds it for you. "Threads are only rendered visibly in Teams
  channels. In 1:1 chats, group chats, and meetings, messages appear flat; passing a thread root
  message ID has no visible effect." [S15]
- Posting a **new root** in a channel: `POST /v3/conversations` with `isGroup: true`,
  `channelData.channel.id`, `tenantId` and an `activity`; response `{ "id":
  "<channelId>;messageid=<rootId>", "activityId": "<id>" }`. [S29][S5]
- `replyToId`: Connector semantics are "reply = `POST …/activities/{activityId}`" with
  `replyToId` set to the inbound id [S20]. In the Teams SDK, `send()` posts into the same
  thread **without** a quote; `reply()` "automatically stamps a quoted reply entity" (visual
  quote); `quote(messageId, text)` / `addQuote()` quote arbitrary messages. [S4][S14]
- Ordering: "if the bot sends multiple messages in quick succession, the channel may not always
  render the messages in the proper sequence." [S20]
- Deep links [S18]: channel message
  `https://teams.microsoft.com/l/message/<channelId>/<messageId>?tenantId=…&groupId=…&parentMessageId=…&teamName=…&channelName=…&createdTime=…`;
  chat message `https://teams.microsoft.com/l/message/<chatId>/<messageId>?context={"contextType":"chat"}`
  where `chatId` must be the `19:…` id — "For one-on-one chats with bot, the incoming payload to
  bot contains the conversation ID in a:xxx format" (so a 1:1 bot chat deep link needs the 19:
  id from Graph, not the `a:` conversation id).
- **serviceUrl**: regional (`https://smba.trafficmanager.net/amer/`, `/emea/`, `/teams/`…). Rules:
  "For any reply to messages, use `serviceURL` from the incoming request"; for proactive sends
  use the stored one, else the global `https://smba.trafficmanager.net/teams/` (GCC/GCC-High/DoD
  have their own; calling the public host for a GCC tenant → `403 InvalidBotApiHost`). [S5][S1]
  Multi-geo: "the service URL for a tenant might change and so users in the same tenant might
  have different service URLs"; a newly created 1:1 "might receive a different serviceURL…
  depending on the user's preferred region"; "If the tenant or user URL changes, then both the
  old and new service URL will work." [S19]
- **SDK gotcha**: `app.send(conversationId, …)` / `app.reply(…)` use the **app-level**
  serviceUrl (`options.serviceUrl ?? process.env.SERVICE_URL ?? 'https://smba.trafficmanager.net/teams'`,
  `teams.apps/dist/app.js`), not a per-conversation one; inbound handling uses
  `activity.serviceUrl || token.serviceUrl`. Use `app.api.clone({ serviceUrl })` for stored URLs.
- Inbound requests carry `x-ms-conversation-id` and `x-ms-tenant-id` headers. [S1]

---

## 5. Proactive messaging

- Create a 1:1: `POST {serviceUrl}/v3/conversations` with `bot.id` (`28:<appId>`),
  `members: [{ id: <29:userId or aadObjectId> }]`, `channelData.tenant.id` (or `tenantId`).
  "You must supply the user ID and the tenant ID." Response `{ id: "a:1…" }` — "Create the
  conversation only once, and store the resulting `conversationId`." [S5][S29]
- Install requirement: "Ensure that the agent is installed in the personal scope… If the agent
  isn't installed… the agent returns a **403 `ForbiddenOperationException`**" ("Bot is not
  installed in user's personal scope"). `aadObjectId` works only in personal scope; "Teams
  doesn't support sending proactive messages using email or User Principal Name." `29:` user ids
  are per-bot ("You can't reuse the `userId` between agents"); `aadObjectId` is stable. [S5][S1]
- Other 403s to handle by **stopping and clearing cache** [S1][S5]:
  `BotNotInConversationRoster` (wait for `installationUpdate` add), `ConversationBlockedByUser`,
  `BotDisabledByAdmin`, `MessageWritesBlocked` subCode ("Thread is blocked from message writes" —
  user blocked/uninstalled; "Your agent receives a 403 response code for new messages posted"
  after uninstall).
- Group chats/teams: "the app that contains your agent must be first installed in that
  location… You can't create a new group chat or a new channel in a team with proactive
  messaging." Proactive install via Graph is the escape hatch (org catalog/Store apps only). [S5]
- Welcome etiquette: don't DM each member when installed in a team; skip welcome in teams > 100
  members, on rename, on member add. [S4]
- External / guest users: "Attempt to send a direct message from your agent to the external
  user: This functionality fails if the user is outside your tenant." "Apps in one-on-one chat
  with external users aren't supported." Guests can @mention the bot in channels and use its
  cards; bots preinstalled via app setup policy are not available to guests. [S23][S24]
- Rate: create-conversation shares the 7/s–1800/h per-thread table. [S3]

---

## 6. Mentions

- Inbound: `entities: [{ type: "mention", mentioned: { id, name }, text: "<at>Name</at>" }]`;
  the message `text` also contains `<at>…</at>`. "don't rely on the text in the message to
  retrieve any information about the user… use the `entities` object." Check
  `mentioned.id === activity.recipient.id` to know the bot was addressed. Bot id is
  `28:<MicrosoftAppId>`. [S4][S10][S11]
- SDK: `activity.stripMentionsText()` strips **all** mentions (open request to strip only the
  bot's: teams.ts#833); `stripMentionsText({ accountId })` filters. In 1:1 chats the client may
  still attach a mention entity. https://github.com/microsoft/teams.ts/issues/833
- Outbound: put `<at>Display Name</at>` in `text` **and** a `mention` entity whose `text` "must
  match the exact text in the message body"; `mentioned.id` may be the `29:` id, the Entra
  object id, or a UPN. SDK: `new MessageActivity('Hi <at>Name</at>').addMention(account)`.
  "they don't support `@everyone`"; "Channel and team mentions aren't supported in bot
  messages." Tag mentions: `mentioned.type: "tag"` with base64 tag id, channels only, not in
  shared/private channels, throttled (2 msgs/5 s). [S4][S6]
- In Adaptive Cards: `<at>Name</at>` in `TextBlock`/`FactSet` text plus
  `msteams.entities: [{ type: "mention", text: "<at>Name</at>", mentioned: { id, name } }]`;
  the mention counts toward the 100 KB bot limit. Card-based mentions work on web, desktop and
  mobile. [S6]

---

## 7. Dialogs (task modules), card actions, invoke timing

- **Invoke response deadline: five seconds.** "If the app doesn't respond within five seconds,
  the Teams client retries the request twice before it sends an error message **Unable to reach
  the app**. If the bot replies after the timeout, the response is ignored." "The app must defer
  any long-running actions after the bot replies to the invoke request." [S27]
  (Community answers claiming 10–15 s are unofficial.)
- `task/fetch` → SDK `app.on('dialog.open')` → return
  `{ task: { type: 'continue', value: { title, height, width, url | card, fallbackUrl } } }`.
  `height`/`width`: px or `small|medium|large` (≈20/50/60 % width, 20/50/66 % height). `url`
  domains must be in manifest `validDomains`; `url`/`fallbackUrl` must be HTTPS. Trigger from a
  card with `Action.Submit` + `data.msteams: { type: "task/fetch" }` (SDK `TaskFetchAction`), or
  a deep link. [S8]
- `task/submit` → `app.on('dialog.submit')` → no response, `{ task: { type: 'message', value } }`
  (pop-up text) or another `continue` (wizard). "It isn't possible to detect the `err` event
  [cancel] when a dialog is invoked from a bot." Last root action gets the primary (solid) style.
  Cards inside dialogs: Adaptive Cards v1.6 or earlier. [S8][S7]
- `Action.Execute` → `adaptiveCard/action` invoke (`card.action`); response body
  `{ statusCode, type, value }` with `type` ∈ `application/vnd.microsoft.card.adaptive` (replace
  card for invoker), `application/vnd.microsoft.activity.message` (toast string),
  `application/vnd.microsoft.error`, `…loginRequest` (401), `…preconditionFailed` (412); HTTP
  status must be 200 regardless. `Action.Submit` with `msteams.type: messageBack|imBack|invoke|
  signin` arrives as a **message** activity (`onCardButtonClicked`), not an invoke. [S16][S27][S32]
- `Action.OpenUrl` domains must be in `validDomains` or Teams shows "URL may lead to untrusted
  content". `conditionallyEnabled` / `isEnabled` work only with `Action.Submit`/`Action.Execute`
  (and `isEnabled` on Submit is unsupported in Teams). [S32][S7]
- Suggested actions: max **3** shown; 1:1 shows them as smart replies for the last message only;
  "not supported for chat bots with attachments". [S26]
- SDK 2.1 runs handlers concurrently — "It does not serialize turns" — and in TS the `card.action`
  route name is `card.action.<action>` when `SubmitData` sets `data.action`. [S14] and SDK
  executing-actions guide.

---

## 8. Files and inline images

- Two routes: **Graph** (all scopes) or the **bot file-consent API, personal scope only**
  ("They don't work in the `channel` or `groupchat` context"); manifest `"supportsFiles": true`.
  Not available in GCC-High/DoD/21Vianet. [S9]
- Receiving in 1:1: attachment `contentType: application/vnd.microsoft.teams.file.download.info`,
  `content.downloadUrl` ("The user can issue an HTTP GET directly from this URL"), `uniqueId`
  (OneDrive driveItem id), `fileType`. [S9]
- Sending in 1:1: `FileConsentCard` (`application/vnd.microsoft.teams.card.file.consent`, with
  `sizeInBytes`, `acceptContext`/`declineContext`) → `fileConsent/invoke` with
  `value.action: accept|decline` and `uploadInfo.uploadUrl` → `PUT` bytes (`Content-Range`) →
  confirm with `FileInfoCard` (`…card.file.info`); optionally delete the consent card. [S9]
- Inline images a user pastes arrive as `image/*` attachments whose `contentUrl` needs the
  **bot's bearer token** ("The Teams SDK handles authentication automatically"); outbound inline
  images may be `data:image/png;base64,…` `contentUrl`s. Channel files are SharePoint links
  (`channelData`/HTML attachment), fetch via Graph. [S9][S1]
- Teams AI v1 complaint: `TeamsAttachmentDownloader cannot download file attachments and audios`
  (microsoft/teams-sdk#1202, open). https://github.com/microsoft/teams-sdk/issues/1202

---

## 9. RSC, mention-less channel messages, installation events, app updates

- Default: "agents in group chats and channels only receive messages when they're directly
  @mentioned… your agent doesn't receive a message when the team or channel is mentioned, or when
  someone replies to a message from your agent without @mentioning it." [S4]
- RSC application permissions `ChannelMessage.Read.Group` (team channels) and
  `ChatMessage.Read.Chat` (group chats) in manifest `authorization.permissions.resourceSpecific`,
  plus `webApplicationInfo.id` = bot's Entra app id (`resource: https://RscBasedStoreApp`).
  Observed here (2026-10-30): after updating the catalog app to a new version (`Set-TeamsApp`), the
  team stopped receiving replies without a mention — Teams sent nothing — while Graph still read the
  channel's messages with the RSC grant; until then (2026-10-16 … 20) every such reply had arrived.
  A fresh install of the app in the team brought them back (a personal reinstall did not).
  "After you update the permissions, install or upgrade the app in the target team or group chat.
  The team or chat owner must consent." Who may consent: "Team: A team owner or member • Chat: A
  chat member"; tenant-wide switches live in the Entra admin center (teams) / Graph (chats), so
  an admin can block RSC. Still filter on `recipient.id` to prioritise @mentions. Personal-scope
  RSC is limited to `ChatMessageReadReceipt.Read.Chat`. [S10][S25]
- Graph change-notification subscriptions on `/channels/{id}/messages` with RSC are **blocked
  (403) in shared and private channels**. [S23]
- `installationUpdate`: `action` = `add` | `remove`; on app **upgrade** it fires only if the
  manifest adds/removes the bot (`add-upgrade` / `remove-upgrade`) — "For all other cases, the
  `installationUpdate` event isn't triggered." On team install `conversation.id` is the channel
  the installer selected (General id = `team.id`), and that selected id is present only on `add`.
  `membersAdded` includes the bot itself (`id === recipient.id`, `28:<appId>`). [S11]
- Also delivered: `messageUpdate` (`channelData.eventType: editMessage | undeleteMessage`),
  `messageDelete` (`softDeleteMessage`), `messageReaction` (`reactionsAdded/Removed`, carries
  `replyToId` but "doesn't contain the contents of the original message"), read receipts (RSC
  `ChatMessageReadReceipt.Read.Chat` + tenant setting). [S1][S11]
- Uninstall: user and bot both get 403 afterwards; "You can't send or receive messages after an
  app has been uninstalled." Store approval requires the description to say the bot reads all
  messages. [S11][S10]

---

## 10. Typing indicator, reactions, deleting

- Typing: send `{ type: "typing" }` (SDK `send({ type: 'typing' })`). Official numbers (Agent 365
  doc, Teams-specific): "They have a built-in visual timeout of **about 5 seconds** and that must
  be refreshed in a loop around every **four seconds**. They're only visible in **one-on-one chats
  and small group chats, not in channels**." The Teams typing animation is unavailable while a
  stream is open. Community: no indicator in chats > 20 people; a 2023–24 new-client bug hid it
  entirely; recommended fallback is a short acknowledgement message. [S22][S13] (community:
  https://learn.microsoft.com/en-us/answers/questions/1462799/)
- **Reactions: bots can now add/remove them** (Teams SDK): `api.conversations.addReaction(
  conversationId, activityId, 'like')` / `deleteReaction`, REST
  `…/activities/{id}/reactions` (`teams.api` `ReactionClient`). Limits: "two reactions per
  second… `429`… honor the `Retry-After` header"; "Adding a reaction that's already present is a
  no-op"; fails if the message is gone or the bot isn't a member. Named ids `like`, `heart`,
  `1f440_eyes`, `2705_whiteheavycheckmark`, `launch`, `1f4cc_pushpin`; skin tones `-tone1..5`.
  Receiving reactions arrives as `messageReaction`. [S21]
- Delete: `DELETE /v3/conversations/{conversationId}/activities/{activityId}`; SDK
  `api.conversations.activities(conv).delete(id)`; only the bot's own messages. [S1]

---

## 11. Targeted ("private") channel messages

- Status: documented as a general capability (doc dated 2026-07-17): "Sending targeted messages
  to any user in a group conversation is a capability of all Teams agents" / "All agents in
  Teams are automatically eligible to send targeted messages." Receiving them requires manifest
  `bots[].supportsTargetedMessages: true`; users send one via the `/`-command menu. [S12]
- Scope: "only for one-to-one interactions between an agent and a user in channels, group chats,
  and meeting chats" (not 1:1 — teams.ts#742 removed the SDK's own rejection in 1:1). [S12]
- Send: SDK `new MessageActivityInput(text).withRecipient(activity.from, true)`; REST
  `POST …/activities?isTargetedActivity=true` with `recipient` set (400 `Bad argument` if
  missing). Proactive targeted sends must pass an explicit recipient account. Inbound targeted
  messages have `recipient.isTargeted === true`. [S12][S15]
- Limits: no reactions, replies or forwarding; **expire after 24 hours**; visibility can't be
  changed (delete + resend publicly instead); update/delete must **not** include `recipient`;
  `403 BotNotInConversationRoster` if not installed; `404 ActivityNotFoundInConversation` /
  `TARGETED_MESSAGE_EXPIRED_OR_DELETED` after expiry. "If attempting to send a targeted message
  results in an error, consider sending a 1:1 chat message as a fallback." Adaptive Card
  interactions inside a targeted message can still produce public activity. Prompt Preview
  (`targetedMessageInfo` entity with `messageId`) — SDK adds it automatically on reactive
  `send()/reply()`; "Coming Soon… June 2026" per the SDK page. [S12][S14]
- Open SDK bug: a targeted message posted at a channel **root** can't be answered through the
  targeted-reply path — "post a new targeted root message instead of replying" (teams.ts#816).
  https://github.com/microsoft/teams.ts/issues/816
- Private channels: "agents can't post messages or Adaptive Cards in private channel
  conversations" [S4], while the shared/private-channel guide says agents are supported once the
  manifest declares `supportsChannelFeatures: tier1` (v1.25+) and the app is added to each
  channel ("App must be added to each channel"; 403 "app not enabled in this channel" otherwise).
  Treat as in-flux; test. [S23]

---

## 12. Markdown rendering differences (text messages)

- Tables: only with `textFormat: extendedmarkdown` (GFM pipes with alignment) — default mode:
  "Text-only messages do not support table formatting." Cards: `Table` element only. [S2][S28][S6]
- Code: fenced blocks with language → syntax-highlighted in extended mode; default mode only
  inline backticks/`<pre>`; Q&A reports raw `<br>` showing inside code blocks when HTML is mixed
  in. [S2][S28]
- Headings: `###` works in extended mode (doc example); legacy table marks headers unsupported in
  text-only messages; unsupported in card `TextBlock`s. [S2][S28][S6]
- Line breaks: default mode honours `<br>` and blank lines; cards need `\n\n` (or `\r`/`\n` in
  lists). [S2][S6]
- Emoji: pass the Unicode characters (UTF-16, e.g. U+1F600); shortcodes like `:smile:` are not
  documented as supported; REST callers must send `charset=UTF-8`. [S1][S6]
- Links: `[text](url)` and `<a href>` in default mode; images `![..](..)` only in extended mode
  (default renders markdown images at 256×256; use `<img width height>`). [S2][S1]
- HTML: default mode accepts a small whitelist (`b strong i em u s br hr a img`); extended mode
  "does not support arbitrary HTML"; Adaptive Cards none. [S2][S6]
- Client differences: lists/strike unsupported on some mobile clients in legacy mode; test on
  desktop, web, iOS, Android when switching to extended mode. [S28][S2]
- OSS note (OpenClaw Teams troubleshooting): "Complex markdown (tables, nested lists) may not
  render correctly"; "Streaming previews may show unfinished Markdown until the final reply
  replaces them." https://docs.openclaw.ai/channels/msteams/troubleshooting (secondary)

---

## 13. Other surprises

- **Duplicate deliveries**: "If an agent activity takes more than **15 seconds** to process,
  Teams sends a retry request to the agent endpoint, so you might see duplicate requests."
  Acknowledge fast, do the work asynchronously, and dedupe on `activity.id`. [S17]
  OpenClaw keeps an "ingress tombstone [that] rejects a repeated event ID" for this reason.
- **Invoke** timeout is the stricter 5 s (×3 attempts) — see §7. [S27]
- `412 PreconditionFailed` when several operations hit the same conversation concurrently
  (e.g. an edit racing a send) → retry with backoff. [S1]
- Status/error code table worth wiring into the driver (HTTP → code → action) [S1]:
  400 `Bad Argument` (don't retry); 401 `BotNotRegistered`; 403 `BotDisabledByAdmin`,
  `BotNotInConversationRoster`, `ConversationBlockedByUser`, `ForbiddenOperationException`,
  `InvalidBotApiHost`, `NotEnoughPermissions`; 404 `ActivityNotFoundInConversation`,
  `ConversationNotFound` (drop cached ids); 412 retry; 413 `MessageSizeTooBig`; 429 `Throttled`
  (Retry-After); 500 don't retry; 502/503/504 retry.
- Locale/timezone: activities carry `locale`, `localTimestamp`, `localTimezone` and a
  `clientInfo` entity `{ locale, country, platform, timezone }`. [S1]
- Guests/external: see §5; shared channels can contain cross-tenant users — "validate user roles
  and tenant IDs"; host tenant is `conversation.tenantId`; expect **duplicate member-added
  notifications** for direct+indirect members; "Avoid relying on channel type values for app
  logic." [S23]
- TLS 1.2 only for the bot endpoint. [S17]
- Reverse proxies / WAFs can silently drop Teams traffic while Web Chat works — the Connector's
  UA is `Microsoft-SkypeBotApi (Microsoft-BotFramework/3.0)` and Cloudflare bot-fight rules were
  the suspect (teams.ts#564). https://github.com/microsoft/teams.ts/issues/564
- SDK `signin` events may fire more than once (teams.ts#351); streaming is auto-disabled in
  group scope only by convention — you must check `conversation.isGroup` yourself (teams.ts#182).
- The Connector's outbound retry on a 15 s timeout, Teams splitting text+attachment sends, and
  "the channel may not always render the messages in the proper sequence" together mean
  **ordering of fast multi-message answers is not guaranteed**. [S1][S20]
- 2020 incident: typing POSTs returned 502 during a scale-back; Teams now returns 202 for
  typing. (devblogs, secondary)

---

## Already handled / still open — checklist for the CoachAven Teams driver

Driver facts (from `src/chat/teams/`): edits coalesced per message (default 2 s window), answers
split at `MAX_TEAMS_TEXT = 25_000`, private replies via `conversations.create({ tenantId,
isGroup:false, bot, members:[{id}] })`, dialogs only as the `task/fetch` invoke response
(`DIALOG_WAIT_MS = 8000`), `serviceUrl` stored from inbound activities and used via
`app.api.clone({ serviceUrl })`, `textFormat: 'markdown'`, `claim: () => true // nothing to
dedupe`, `connector()` rethrows axios errors without retry, text+card edits already split into
text-update + follow-up card.

**Already handled**
- [x] No text+card in an update (`edit()` sends the text update then a separate card) — the
  only hard rule from [S30]; keep card→card and text→text where possible to avoid the stale
  rendering artefacts Microsoft warns about.
- [x] 25 KB split is comfortably under the 80 KB guidance even at 2 bytes/char UTF-16 (~50 KB);
  mentions/cards count toward the same 100 KB. [S2]
- [x] serviceUrl captured from inbound and applied with `api.clone({ serviceUrl })` — correct,
  because `app.send()` would otherwise use the global default host. Old URLs stay valid after a
  geo move. [S19][S5]
- [x] 1:1 creation passes `tenantId` and the `29:` user id; store/reuse the returned `a:` id.
- [x] Dialog opened only as the `task/fetch` response; `card.action` answered with a 200 message
  response and card changes done via `update()` — matches the universal-action model.
- [x] Coalesced edits (≥2 s) sit under the 7/s–60/30 s per-thread send budget for one message.
- [x] Thread key handling strips/appends `;messageid=` like the SDK helper.

**Still open / to decide** — a research snapshot, not re-checked item by item against the driver
since it was written; `docs/teams.md` describes what the driver does today.
- [x] **Invoke deadline** (done: the wait is 4 s now): `DIALOG_WAIT_MS = 8000` exceeds the 5-second invoke budget; the
  client will retry twice and show "Unable to reach the app" if the view takes > 5 s. Lower the
  wait to ≈3–4 s and make the fallback dialog say "still working", or precompute views. [S27]
- [ ] **Dedupe inbound by `activity.id`**: `claim: () => true` assumes single delivery, but Teams
  re-sends any activity whose processing exceeds 15 s. Ack the HTTP request before long work and
  keep a short-lived seen-set of activity ids. [S17]
- [ ] **429/412 handling**: SDK and `connector()` don't retry; read `Retry-After` from
  `err.response.headers` for 429, exponential backoff for 412/502/503/504, never retry
  400/403/404/413. Map 403 `BotNotInConversationRoster` / `ConversationBlockedByUser` /
  `MessageWritesBlocked` and 404 `ConversationNotFound` to "drop the cached conversation and stop
  posting"; 404 `ActivityNotFoundInConversation` to "forget the message id". [S1][S3]
- [ ] **Personal-scope prerequisite** for the private 1:1 reply: a 403
  `ForbiddenOperationException` means the user never installed the app personally — fall back to
  a channel message telling them to add CoachAven, or to a **targeted message** in the channel
  (24 h expiry, no replies/reactions, SDK `withRecipient(account, true)`). Guests/external users
  cannot get a 1:1 at all. [S5][S12][S23]
- [ ] **Message splitting**: never send `text` + `attachments` in one new activity if the id is
  needed for later edits — the Connector splits it and returns no usable id. Check `sendTo()`
  posts text and card as separate activities when both are present. [S1]
- [ ] **`textFormat`**: current `'markdown'` is the legacy default — no tables, fenced code or
  headings in plain text. Agent output with code blocks/tables should switch to
  `extendedmarkdown` (per message; drop HTML such as `<br>`), and verify on mobile. [S2]
- [ ] **Card `TextBlock` markdown**: no headers/tables/code/blockquotes; convert `\n` to `\n\n`
  outside lists; `_italic_` not `*italic*`. [S6]
- [ ] **Typing indicator**: only 1:1 and small group chats, ~5 s visible — refresh every ~4 s
  while working, or rely on the status card in channels (as the driver already does). [S22]
- [ ] **Reactions are now possible** (`api.conversations.addReaction`, 2/s) — `mark()` could use
  `👀`/`✅` reactions instead of typing in channels. [S21]
- [ ] **Deep links** for 1:1 bot chats need the `19:` chat id (not the `a:` conversation id) —
  `deepLink()` for personal conversations will not resolve; channel links should also carry
  `groupId`/`parentMessageId` for reliability. [S18]
- [ ] **Card schema**: emit `version` ≤ 1.6 (1.5 is safe), `Action.Execute` ≥ 1.4/1.5 with
  `fallback`, ≤ 6 primary actions (`mode: secondary` for the rest), `wrap: true` on text. [S7][S16]
- [ ] **RSC** (`ChannelMessage.Read.Group`, `ChatMessage.Read.Chat` + `webApplicationInfo`) if
  the bot should see replies in its own channel threads without an @mention; needs owner consent
  on (re)install and may be admin-blocked. [S10][S25]
- [ ] **Ordering**: multi-part answers may render out of order; post part n+1 only after part n's
  POST returns, or edit one message. [S20]
- [ ] **Edits of targeted messages** must omit `recipient` (SDK 2.1.0 already strips it when
  `recipient.isTargeted` is set) and fail after 24 h. [S12]
- [ ] **Private channels**: expect posting failures until `supportsChannelFeatures: tier1` is
  declared and the app is added to the channel; `tag` mentions unsupported there. [S4][S23]
- [ ] **Proactive serviceUrl for new 1:1s**: the conversation may live on a different regional
  host than the channel it was created from; keep using the stored URL (it continues to work) but
  update the store when an inbound activity arrives with a new one. [S19]
