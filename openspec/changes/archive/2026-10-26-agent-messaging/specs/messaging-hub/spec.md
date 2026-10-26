## Purpose
A relay that lets installations of the bot reach each other without any of them accepting inbound connections. Each installation connects outbound and proves which installation it is; the hub stores and forwards envelopes it cannot read. Which agent may ask which is not the hub's decision; the receiving installation makes it (`agent-messaging`).

## ADDED Requirements

### Requirement: Installations connect outbound and prove their key
An installation SHALL reach the hub only through a connection it opens itself. The hub SHALL accept envelopes on a connection only after the installation has signed a fresh challenge from the hub with a private key whose public key the hub's configuration enrols for that installation id. The configuration MAY enrol several keys for one id during a rotation. The hub SHALL bind the connection to that id for its lifetime. A newer authenticated connection for the same id SHALL replace the older one.

#### Scenario: Enrolled installation
- **WHEN** installation `bluefin` connects and signs the hub's challenge with the key enrolled for `bluefin`
- **THEN** the connection is accepted, and every envelope it sends carries `bluefin` as its sender installation, whatever installation the envelope names

#### Scenario: Unknown or wrong key
- **WHEN** a client signs the challenge with a key not enrolled for the id it names, or sends anything else before signing
- **THEN** the hub closes the connection before accepting any envelope and logs the refusal without key material

#### Scenario: Clocks do not matter
- **WHEN** an installation's clock is ten minutes off
- **THEN** it still connects, because the challenge carries no time to check, and the installation logs a warning, once per connection, that its clock differs from the hub's by more than 30 seconds

#### Scenario: Second connection
- **WHEN** `bluefin` opens a new connection while an older one is still open
- **THEN** once the new one is authenticated the hub closes the older one with the reason `replaced`, and delivery continues on the new one

### Requirement: The hub routes between enrolled installations only
The hub SHALL route an envelope only when both its sender and its recipient installation are enrolled, and SHALL answer every envelope with `routed` or `rejected` and a reason. It SHALL NOT decide which agent may ask which.

#### Scenario: Routed
- **WHEN** `home` sends an `ask` for `bluefin/caldora`
- **THEN** the hub stores it in `bluefin`'s outbox, delivers it when `bluefin` is connected, and answers `home` with `routed`

#### Scenario: Unknown recipient
- **WHEN** `home` sends an envelope for an installation the hub does not enrol
- **THEN** nothing is stored and `home` receives `rejected: unknown installation`

#### Scenario: Installation removed
- **WHEN** the operator removes `northwind` from the hub's configuration and redeploys
- **THEN** the hub refuses `northwind`'s connections, drops its outbox, answers envelopes for it with `rejected: unknown installation`, and reports `northwind` as removed to connected installations and to every installation when it connects, even if `northwind`'s outbox was empty

### Requirement: The hub sees routing metadata only
Envelope payloads SHALL be encrypted by the sending installation to the receiving installation's key. The hub SHALL store and forward them unread and SHALL record only `from`, `to`, `method`, task id, size and times.

#### Scenario: Stored envelope
- **WHEN** the hub's storage is inspected while an envelope waits for delivery
- **THEN** it holds ciphertext and the routing fields, and no question or answer text

### Requirement: Delivery survives disconnects
The hub SHALL keep every routed envelope in a per-installation outbox with a strictly increasing sequence number until the receiving installation acknowledges it. It SHALL replay unacknowledged envelopes in order when the installation reconnects. It SHALL drop an envelope only after its expiry (default 7 days) or when its recipient is removed. It SHALL report an expiry to the sender, at once or on the sender's next connection.

#### Scenario: Recipient offline
- **WHEN** `home` is offline while `bluefin` sends the answer to an ask from `home`
- **THEN** the hub keeps it and delivers it once, with its sequence number, on `home`'s next connection; after `home` acknowledges it the hub deletes it

#### Scenario: Duplicate after reconnect
- **WHEN** a connection drops after the hub sent an envelope but before the acknowledgement arrived
- **THEN** the envelope is sent again on reconnect with the same sequence number, and the receiver processes it once

#### Scenario: Expired undelivered
- **WHEN** an envelope from `home` waits for `northwind` for longer than its expiry
- **THEN** the hub drops it and tells `home` which envelope and task expired, on `home`'s next connection if it is offline

#### Scenario: Backlog cap
- **WHEN** an installation's outbox holds 1000 undelivered envelopes
- **THEN** further envelopes to it are answered with `rejected: backlog` to their senders

### Requirement: Idle connections cost nothing
The hub SHALL keep an idle connection without its process staying active. Keep-alive pings SHALL be answered without waking it. Its state (connection identity, outboxes, pending expiry reports) SHALL survive the process being evicted between messages.

#### Scenario: Wake on message
- **WHEN** the hub has been idle for an hour with three installations connected and one of them sends an envelope
- **THEN** the envelope is routed to its recipient over the existing connection, and no installation has to reconnect

### Requirement: Presence
The hub SHALL tell an authenticated installation which enrolled installations are connected now. It SHALL notify it when one of them connects, disconnects or is removed.

#### Scenario: Peer goes away
- **WHEN** `northwind` disconnects
- **THEN** connected installations receive a presence event, and an `agents` request for `northwind` answers `offline` at once instead of waiting
