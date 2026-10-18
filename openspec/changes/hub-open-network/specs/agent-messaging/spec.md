## ADDED Requirements

### Requirement: Pinned peers are the installation's allow list at the hub
An installation connected to the hub SHALL send the hub the list of installations pinned in its `hub.peers.json`, and nothing else. It SHALL send the list after every authentication, and after every `/aven reload` that changes its pinned peers. Which agent of a pinned installation may ask which local agent SHALL stay with the agents' accept lists, which never leave the installation.

#### Scenario: Peer pinned on reload
- **WHEN** the operator of `bluefin` pins `home` in `hub.peers.json` and runs `/aven reload`
- **THEN** `bluefin` sends the hub a list that names `home`, and asks from `home/owen-ops` reach caldora's accept check

#### Scenario: Accept lists stay on the installation
- **WHEN** caldora accepts only `home/owen-ops`
- **THEN** the hub learns only that `bluefin` hears from `home`, and never an agent name from caldora's accept list

### Requirement: Addresses on other hubs are refused for now
An address SHALL be either `<installation>/<agent>` or a bare agent name. An installation name SHALL mean that installation on the hub this installation uses. An installation part of the form `<name>@<host>` SHALL be refused, without contacting the hub, with a reason saying that addresses on other hubs are not supported. `@` and `.` SHALL stay invalid in installation names.

#### Scenario: Address on another hub
- **WHEN** owen-ops calls `send_message` for `bluefin@hub.example.org/caldora`
- **THEN** the call is refused at once, saying that addresses on other hubs are not supported, and no envelope is sent

## MODIFIED Requirements

### Requirement: Encrypted between installations
An installation SHALL send these only encrypted to the receiving installation's pinned public key and signed by the sender's key:
- question and answer texts;
- agent names;
- the method;
- the task id.

The clear part of an envelope SHALL name only the version, the envelope id and the two installations. The key derivation SHALL bind the receiver's encryption key, and the signature SHALL be made with the sender's signing key, so a name bound to another key can neither open an envelope nor pass one off as its own.

An installation SHALL discard an envelope whose signature does not verify against the sender's pinned key. Messages between agents of one installation SHALL never leave its bot process.

#### Scenario: Tampered envelope
- **WHEN** an envelope's ciphertext or sender is altered in transit
- **THEN** the receiver drops it, logs `bad signature from <from>`, and starts no turn

#### Scenario: Sealed routing
- **WHEN** owen-ops on `home` asks `bluefin/caldora`
- **THEN** the envelope that leaves `home` names `home` and `bluefin` in clear, and `owen-ops`, `caldora`, the method and the task id only inside the encryption

#### Scenario: Name taken over
- **WHEN** the name `bluefin` is released on the hub and claimed by another key, and an envelope signed by that key arrives as from `bluefin`
- **THEN** the receiver, which pinned the earlier key, drops it, logs `bad signature from bluefin`, and starts no turn

### Requirement: Installations on different releases interoperate
Every envelope SHALL carry its protocol version. A receiver SHALL:
- ignore payload fields it does not know;
- reject an envelope of a version it does not support with `rejected: unsupported version`, and log it.

Changes within one version SHALL be additive only. Version 2 SHALL replace version 1 without a compatibility layer: an installation SHALL speak only version 2, to the hub and to other installations.

#### Scenario: Prod on the last tag
- **WHEN** the home bot runs `main` with a payload field that prod's tagged release does not know, and asks a prod agent
- **THEN** prod answers the task and ignores the field

#### Scenario: Unknown version
- **WHEN** an envelope arrives with a version the receiver does not support
- **THEN** no turn starts, the sender is told `rejected: unsupported version`, and a warning names both versions

#### Scenario: Version 1 installation
- **WHEN** an installation still on a version-1 release connects to a version-2 hub
- **THEN** the hub refuses it with `unsupported version`, the installation logs both versions, and messaging inside that installation keeps working

### Requirement: Discovery through agent cards
`agents(installation?)` SHALL return the agents of that installation that accept the caller; without an argument, the caller's own installation. Each card SHALL give:
- the agent id;
- the one-line description from its messaging configuration;
- whether the agent would take a new task from the caller now, that is, its daily limit for the caller is not reached.

For a peer installation that is not connected, or that does not allow this installation at the hub, it SHALL return `offline` and say that the peer may also not have pinned this installation.

#### Scenario: Listing a peer
- **WHEN** owen-ops calls `agents("bluefin")` while `bluefin` is connected, and `home` and `bluefin` allow each other
- **THEN** it receives one card for each bluefin agent that accepts `home/owen-ops`, and none for the others

#### Scenario: Peer has not pinned us
- **WHEN** owen-ops calls `agents("northwind")`, and `northwind` has not pinned `home`
- **THEN** it receives `offline` at once, with the note that `northwind` may not have pinned `home`
