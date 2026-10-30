## ADDED Requirements

### Requirement: One client pair serves every `oauth` entry of an installation
For a gateway entry with `oauth`, the bot SHALL take the client id and secret from `GATEWAY_OAUTH_<SLUG>_ID` / `_SECRET` when both are set, and otherwise from the installation pair `GATEWAY_OAUTH_ID` / `GATEWAY_OAUTH_SECRET` when neither project variable is set. A project with only one of its two variables set SHALL fail, and the two sources SHALL never be mixed. Entries without `oauth` SHALL NOT read the installation pair.

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

#### Scenario: An entry without `oauth`
- **WHEN** project `caldora`'s gateway entry has no `oauth`, the installation pair is set and `AUTH0_M2M_CALDORA_ID` is not
- **THEN** that project's gateway fails naming the `AUTH0_M2M_*` variables, as before this change, and the installation pair is not used

### Requirement: Projects on the installation pair ask distinct token requests
When the installation pair is set, loading the project config (at boot and on reload) SHALL fail, naming both projects, if two projects whose `oauth` entries take their credentials from it ask the same token request — the same token URL, scope, audience, resource and client authentication — because a token minted for one would then be valid on the other's route.

#### Scenario: A copied entry
- **WHEN** projects `caldora` and `verdant` both take the installation pair and both entries have `oauth: { "tokenUrl": "https://idp.example/oauth/token", "audience": "https://gw.example/gw/caldora/mcp" }`
- **THEN** the load fails with a message naming `caldora`, `verdant` and the shared token request, without any secret

#### Scenario: One audience per route
- **WHEN** both projects take the installation pair and each entry's `audience` is its own route URL
- **THEN** the config loads and each project gets its own token

#### Scenario: Separate clients
- **WHEN** the two entries ask the same token request but `verdant` has its own `GATEWAY_OAUTH_VERDANT_*` pair
- **THEN** the config loads: the two tokens come from different clients

#### Scenario: No installation pair
- **WHEN** the installation pair is not set
- **THEN** this check does not run and the config loads as before this change

### Requirement: A gateway entry without `oauth` is deprecated
The Auth0-specific request (a `gateway-m2m` entry without `oauth`) SHALL keep working unchanged. Loading a project config that has such entries SHALL log one warning naming the projects that use it and the documented replacement (an `oauth` object with the token URL and `audience`). A config without such entries SHALL log nothing about it.

#### Scenario: Two projects on the deprecated path
- **WHEN** projects `caldora` and `verdant` have gateway entries without `oauth`
- **THEN** one warning names both projects and points to the `oauth` replacement, and their tokens are minted exactly as before

#### Scenario: Everything on the standard path
- **WHEN** every gateway entry has `oauth`
- **THEN** no deprecation warning is logged
