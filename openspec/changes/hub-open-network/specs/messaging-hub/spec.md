## ADDED Requirements

### Requirement: Names are claimed first come, first served
The hub SHALL bind a name to the first signing key that claims it when all of these hold:
- the name matches `[a-z0-9-]{1,32}`;
- the name is free and not reserved;
- the hub's registration is `open`.

Under `closed` registration, the hub SHALL admit reserved names only. A bound name SHALL admit only its key. A key SHALL hold at most one name.

The hub's configuration SHALL list reserved names. Each reserved name is bound either to one or more keys, each with an optional expiry for rotation, or to nobody. Another key SHALL never claim a reserved name, and a reserved name SHALL never be released. `local` and `hub` SHALL be reserved for nobody even when the configuration does not list them.

Claims of new names SHALL be limited per IP address per day (default 5). A name whose key has not connected for the configured number of days (default 180) SHALL be released. A released name, and a name the configuration revokes, SHALL be reported as removed, as an installation removed from the hub is. A released name SHALL be free to claim again.

A configuration in the version-1 shape (a map of `installations`) SHALL stop the hub from admitting anyone and SHALL be logged as an error, so a stale configuration never opens a hub.

#### Scenario: First claim
- **WHEN** a client connects with a key the hub has not seen and claims the free name `quillon` while registration is `open`
- **THEN** the hub binds `quillon` to that key and admits the connection

#### Scenario: Name taken
- **WHEN** a second key claims `quillon`
- **THEN** the hub refuses the connection with `name taken`, and `quillon` stays bound to the first key

#### Scenario: One name per key
- **WHEN** the key bound to `quillon` claims `quillon-2`
- **THEN** the hub refuses the connection with `key holds a name`

#### Scenario: Reserved name
- **WHEN** a key that the configuration does not reserve `bluefin` for claims `bluefin`, while registration is `open` and before `bluefin` has ever connected
- **THEN** the hub refuses the connection

#### Scenario: Closed registration
- **WHEN** registration is `closed` and a key claims a name that is not reserved
- **THEN** the hub refuses the connection

#### Scenario: Silent name
- **WHEN** the key of `quillon` has not connected for 180 days
- **THEN** the hub releases the name, drops its outbox and reports `quillon` removed to the installations whose allow list names it; a later claim by any key binds the name anew

#### Scenario: Claim flood
- **WHEN** one IP address makes its sixth claim of a new name within a day
- **THEN** the hub refuses that claim, and the names already bound keep working

#### Scenario: Old configuration
- **WHEN** the hub starts with a configuration in the version-1 shape
- **THEN** it admits no connection and logs an error that names the expected shape

### Requirement: Each installation tells the hub whom it hears from
After authenticating, an installation SHALL send the hub its allow list: the installations from which it accepts envelopes. The hub SHALL keep the latest list for each installation across connections and deploys. A new list SHALL apply to envelopes routed after it arrives; envelopes already in the outbox SHALL stay. An installation that has never sent a list SHALL have an empty one.

#### Scenario: Peer added
- **WHEN** `bluefin` sends an allow list that adds `home`
- **THEN** `home`'s next envelope for `bluefin` is routed

#### Scenario: Peer dropped
- **WHEN** `bluefin` sends an allow list without `northwind`
- **THEN** later envelopes from `northwind` for `bluefin` are answered `rejected: unknown installation`, and `northwind` stops seeing `bluefin`'s presence

#### Scenario: Before any list
- **WHEN** a newly named installation has not sent an allow list yet
- **THEN** every envelope for it is answered `rejected: unknown installation`

### Requirement: The hub routes only to installations that accept the sender
The hub SHALL route an envelope only when its recipient holds a name on the hub and that installation's allow list names the sender. The hub SHALL answer every envelope with `routed`, or with `rejected` and a reason. It SHALL give the same answer, `rejected: unknown installation`, to an envelope for any of these:
- a name that is free;
- a name that was released or revoked;
- an installation that does not allow the sender.

It SHALL NOT decide which agent may ask which.

#### Scenario: Routed
- **WHEN** `home` sends an envelope for `bluefin`, and `bluefin`'s allow list names `home`
- **THEN** the hub stores it in `bluefin`'s outbox, delivers it when `bluefin` is connected, and answers `home` with `routed`

#### Scenario: Recipient does not allow the sender
- **WHEN** `northwind` sends an envelope for `bluefin`, whose allow list does not name `northwind`
- **THEN** nothing is stored, and `northwind` receives `rejected: unknown installation`, the same answer as for a name nobody holds

#### Scenario: Installation removed
- **WHEN** the operator revokes the name `northwind` in the hub's configuration and redeploys
- **THEN** the hub refuses `northwind`'s connections, drops its outbox, answers envelopes for it with `rejected: unknown installation`, and reports `northwind` as removed to every installation whose allow list names it, at once or when that installation next connects, even if `northwind`'s outbox was empty

## MODIFIED Requirements

### Requirement: Installations connect outbound and prove their key
An installation SHALL reach the hub only through a connection it opens itself. The connection address SHALL name the name the installation will claim.

The hub SHALL accept envelopes on a connection only after both of these:
- the installation has signed, with its signing key, a fresh challenge from the hub, bound to the hub's host and to protocol version 2;
- the hub has admitted that key for the claimed name under its registration policy ("Names are claimed first come, first served").

The hub SHALL refuse the connection when the claimed name differs from the one in the connection address, or when the challenge was answered for another protocol version. The hub SHALL bind the connection to that name for its lifetime. A newer authenticated connection for the same name SHALL replace the older one.

#### Scenario: Admitted installation
- **WHEN** `bluefin` connects to `wss://hub.example.com/connect?as=bluefin` and signs the hub's challenge with the key bound to `bluefin`
- **THEN** the connection is accepted, and every envelope it sends carries `bluefin` as its sender installation, whatever installation the envelope names

#### Scenario: Unknown or wrong key
- **WHEN** a client signs the challenge with a key the hub does not admit for the name it claims, or sends anything else before signing
- **THEN** the hub closes the connection before accepting any envelope and logs the refusal without key material

#### Scenario: Hint and claim differ
- **WHEN** a client connects with `?as=bluefin` and claims `northwind`
- **THEN** the hub closes the connection before accepting any envelope

#### Scenario: Version 1 client
- **WHEN** a client answers the challenge in the version-1 form
- **THEN** the hub closes the connection with the reason `unsupported version`, and the client logs both versions

#### Scenario: Clocks do not matter
- **WHEN** an installation's clock is ten minutes off
- **THEN** it still connects, because the challenge carries no time to check, and the installation logs a warning, once per connection, that its clock differs from the hub's by more than 30 seconds

#### Scenario: Second connection
- **WHEN** `bluefin` opens a new connection while an older one is still open
- **THEN** once the new one is authenticated the hub closes the older one with the reason `replaced`, and delivery continues on the new one

### Requirement: The hub sees routing metadata only
The sending installation SHALL encrypt envelope payloads to the receiving installation's key. The clear part of an envelope SHALL name only:
- the protocol version;
- the envelope id;
- the sending installation and the receiving installation.

Agent names, the method and the task id SHALL travel inside the encryption. The hub SHALL store and forward envelopes unread. It SHALL record only the two installations, the envelope id, the size and times.

#### Scenario: Stored envelope
- **WHEN** the hub's storage is inspected while an envelope from `home/owen-ops` to `bluefin/caldora` waits for delivery
- **THEN** it holds ciphertext, `home`, `bluefin`, the envelope id, the size and times, and no agent name, method, task id, question or answer text

#### Scenario: Hub logs
- **WHEN** the hub logs a routed, rejected or expired envelope
- **THEN** the log line names installations, the envelope id and the size, and no agent, method or task

### Requirement: Delivery survives disconnects
The hub SHALL keep every routed envelope in a per-installation outbox, with a strictly increasing sequence number, until the receiving installation acknowledges it. It SHALL replay unacknowledged envelopes in order when the installation reconnects. It SHALL drop an envelope only after its expiry (default 7 days) or when its recipient is removed. It SHALL report an expiry to the sender by envelope id, at once or on the sender's next connection.

It SHALL refuse an envelope with `rejected: backlog` when either limit is reached:
- the recipient's outbox holds 1000 envelopes or 50 MB;
- the envelopes from that sender waiting for that recipient number 200 or take 10 MB.

The hub's configuration MAY set other limits.

#### Scenario: Recipient offline
- **WHEN** `home` is offline while `bluefin` sends the answer to an ask from `home`
- **THEN** the hub keeps it and delivers it once, with its sequence number, on `home`'s next connection; after `home` acknowledges it the hub deletes it

#### Scenario: Duplicate after reconnect
- **WHEN** a connection drops after the hub sent an envelope but before the acknowledgement arrived
- **THEN** the envelope is sent again on reconnect with the same sequence number, and the receiver processes it once

#### Scenario: Expired undelivered
- **WHEN** an envelope from `home` waits for `northwind` for longer than its expiry
- **THEN** the hub drops it and tells `home` the id of the envelope that expired, on `home`'s next connection if it is offline, and `home` finds the task by that id

#### Scenario: Backlog cap
- **WHEN** an installation's outbox holds 1000 undelivered envelopes
- **THEN** further envelopes to it are answered with `rejected: backlog` to their senders

#### Scenario: Backlog per sender
- **WHEN** 200 envelopes from `northwind` wait for `bluefin`, and `bluefin`'s outbox holds 210 in all
- **THEN** `northwind`'s next envelope for `bluefin` is answered `rejected: backlog`, and an envelope from `home` for `bluefin` is still routed

### Requirement: Presence
The hub SHALL tell an authenticated installation which installations are connected now, among those that it allows and that allow it. It SHALL notify it when one of those connects or disconnects. It SHALL report a removal to the installations whose allow list names the removed one. It SHALL NOT tell an installation which other installations hold names on the hub.

#### Scenario: Peer goes away
- **WHEN** `northwind` disconnects while `northwind` and `home` allow each other
- **THEN** `home` receives a presence event, and an `agents` request from `home` for `northwind` answers `offline` at once instead of waiting

#### Scenario: One-sided allow list
- **WHEN** `home` allows `northwind`, and `northwind` does not allow `home`
- **THEN** `home` never sees `northwind` connect or disconnect

#### Scenario: Nothing about strangers
- **WHEN** a newly named installation connects
- **THEN** its `hello` names no other installation

## REMOVED Requirements

### Requirement: The hub routes between enrolled installations only
**Reason**: Holding a name no longer makes an installation reachable. The hub routes only along the recipient's allow list.
**Migration**: See "The hub routes only to installations that accept the sender" and "Each installation tells the hub whom it hears from". An installation becomes reachable from a peer when it pins that peer in `hub.peers.json`.
