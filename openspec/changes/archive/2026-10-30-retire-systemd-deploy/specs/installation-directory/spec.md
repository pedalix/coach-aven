# Spec Delta

## MODIFIED Requirements

### Requirement: No runtime file is located through the code or the working directory
The bot's own assets (fixtures, static files, workers) SHALL stay beside the code; nothing else SHALL be located through the code's own location. Every file the bot reads or writes at runtime SHALL be located through the installation directory. The test suite SHALL fail when code under `src/` builds such a path from its own location or from the working directory.

#### Scenario: A new journal located through the code
- **WHEN** a change adds `new URL('../journal', import.meta.url)` for a runtime file under `src/`
- **THEN** `npm test` fails and names the file and the path

#### Scenario: A cache located through the working directory
- **WHEN** a change adds `join(process.cwd(), 'cache')` under `src/`
- **THEN** `npm test` fails and names the file

#### Scenario: Release marker
- **WHEN** the error tracker's release is wanted
- **THEN** it comes from the environment the compose file sets from the pinned version, and no file beside the code is read for it
