## REMOVED Requirements

### Requirement: Without an `oauth` object the Auth0-compatible request is unchanged
**Reason**: No installation sends it any more; every gateway entry asks through the standard `oauth` request, which Auth0 answers too (`tokenUrl` + `audience`).
**Migration**: Give each gateway entry `"oauth": { "tokenUrl": "<the old AUTH0_M2M_TOKEN_URL>", "audience": "<the entry's url>" }`, put the bot client in `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` (or a project's own `GATEWAY_OAUTH_<SLUG>_*`), and drop the `AUTH0_M2M_*` lines.

### Requirement: A gateway entry without `oauth` is deprecated
**Reason**: The deprecation period is over; such an entry now fails the load (see *A gateway entry needs an `oauth` object*).
**Migration**: As above.

### Requirement: One client pair serves every `oauth` entry of an installation
**Reason**: Its last clause and scenario (an entry without `oauth` reads `AUTH0_M2M_*`, never the installation pair) describe the removed path; every gateway entry has `oauth` now. Replaced by *One client pair serves every gateway entry of an installation*, the same rule without them.
**Migration**: None for entries with `oauth`; the credential rule is unchanged.

## ADDED Requirements

### Requirement: A gateway entry needs an `oauth` object
Loading the project config (at boot and on reload) SHALL fail when an `mcp` entry with `auth: "gateway-m2m"` has no `oauth` object. The message SHALL name the config file, every project with such an entry, and the replacement: an `oauth` object with `tokenUrl` and the route's `audience` (or `scope`). The bot SHALL NOT read `AUTH0_M2M_*` variables.

#### Scenario: Two projects on the old entry
- **WHEN** projects `caldora` and `verdant` have `gateway-m2m` entries without `oauth`
- **THEN** the load fails with one message naming both projects and the `oauth` replacement, and nothing is minted

#### Scenario: Leftover Auth0 variables
- **WHEN** every gateway entry has `oauth` and the env still carries `AUTH0_M2M_TOKEN_URL` and `AUTH0_M2M_CALDORA_ID` / `_SECRET`
- **THEN** the config loads, and the tokens are requested with the `GATEWAY_OAUTH_*` credentials only

### Requirement: One client pair serves every gateway entry of an installation
For every gateway entry, the bot SHALL take the client id and secret from `GATEWAY_OAUTH_<SLUG>_ID` / `_SECRET` when both are set, and otherwise from the installation pair `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` when neither project variable is set. A project with only one of its two variables set SHALL fail, and the two sources SHALL never be mixed.

#### Scenario: Only the installation pair is set
- **WHEN** `GATEWAY_OAUTH_ID` and `GATEWAY_OAUTH_SECRET` are set, no `GATEWAY_OAUTH_CALDORA_*` is, and project `caldora` has an `oauth` gateway entry
- **THEN** the token request for `caldora` authenticates with the installation pair

#### Scenario: The project's own pair wins
- **WHEN** both `GATEWAY_OAUTH_CALDORA_ID` / `_SECRET` and the installation pair are set
- **THEN** the token request for `caldora` authenticates with `GATEWAY_OAUTH_CALDORA_*`, exactly as without the installation pair

#### Scenario: Half a project pair
- **WHEN** `GATEWAY_OAUTH_CALDORA_ID` is set, `GATEWAY_OAUTH_CALDORA_SECRET` is not, and the installation pair is set
- **THEN** that project's gateway fails with a message naming `GATEWAY_OAUTH_CALDORA_ID` and `GATEWAY_OAUTH_CALDORA_SECRET`, no token request is sent, and other projects are not affected

#### Scenario: No credentials at all
- **WHEN** neither the project pair nor the installation pair is set
- **THEN** that project's gateway fails with a message naming `GATEWAY_OAUTH_CALDORA_ID`, `GATEWAY_OAUTH_CALDORA_SECRET`, `GATEWAY_OAUTH_ID` and `GATEWAY_OAUTH_SECRET`

## MODIFIED Requirements

### Requirement: Tokens are cached per token request and refreshed before they expire
The bot SHALL keep one cached token per project and token request, the token request being the entry's token URL, scope, audience, resource and client authentication. Concurrent turns SHALL share one in-flight request; a failed request SHALL NOT be cached. A cached token SHALL be replaced once the time left is less than the smaller of one hour and half the token's lifetime at issue.

#### Scenario: A 24-hour token
- **WHEN** a token issued with a 24-hour lifetime has 2 hours left
- **THEN** the cached token is reused, and it is replaced once less than 1 hour is left

#### Scenario: A one-hour token
- **WHEN** a token issued with a one-hour lifetime has 40 minutes left
- **THEN** the cached token is reused, and it is replaced once less than 30 minutes are left

#### Scenario: Two scopes in one project
- **WHEN** two gateway entries of one project ask the same token URL for different scopes
- **THEN** each gets its own token and neither request is answered from the other's cache

#### Scenario: A burst of turns
- **WHEN** several turns of one project need the token at once and none is cached
- **THEN** exactly one token request is sent and every turn receives its token
