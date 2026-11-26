# Spec Delta

## Purpose
An operator runs an installation from chat: who may manage it, which model and effort a project's agent uses, and
one place that shows what is set — without editing the installation's files or restarting the bot.

## ADDED Requirements

### Requirement: Operator controls are off until the installation turns them on

Without `OPERATOR_CONTROLS=1` the installation SHALL behave as before this capability: no `operators`, `model` or
`effort` command, the same Home and Session card for everyone, and the same people able to run operator commands.

#### Scenario: Flag unset
- **WHEN** the flag is unset and a user of the home workspace runs `/aven model` in a project's channel
- **THEN** the command is treated as any unknown word is today, and nothing is stored

#### Scenario: Flag unset, operator commands
- **WHEN** the flag is unset on a Slack installation and a user of the home workspace runs `/aven reload`
- **THEN** the config is reloaded, as today

### Requirement: An operator is a named person of the home workspace

With the flag on, a person SHALL be an operator when the installation's config names them or the operators list
kept in chat does. Where neither names anyone, the platform's earlier rule SHALL hold. A person outside the home
workspace SHALL never be an operator.

#### Scenario: Named in chat
- **WHEN** the list kept in chat names Dana Reyes and Milo Hart, who is not named anywhere, runs `/aven reload`
- **THEN** the reload is refused as operator-only

#### Scenario: Nobody named on Slack
- **WHEN** neither the config nor the list names anyone on a Slack installation
- **THEN** every user of the home workspace is an operator, as before

#### Scenario: Client workspace
- **WHEN** an admin of a client workspace runs `/aven operators add @someone`
- **THEN** the command is refused as operator-only

### Requirement: Operators are listed to operators

`/aven operators` with no arguments SHALL show an operator who the operators are and, for each, whether the
config or the chat list names them, and who added a chat-listed one and when. Anyone else SHALL be refused.

#### Scenario: Listing
- **WHEN** Dana Reyes, an operator, runs `/aven operators`
- **THEN** the reply names each operator, the source of each, and for Milo Hart "added by Dana Reyes" with the date

#### Scenario: Not an operator
- **WHEN** a user who may drive the agent but is not an operator runs `/aven operators`
- **THEN** the command is refused

### Requirement: An operator adds and removes operators in chat

`/aven operators add @person` and `/aven operators remove @person` by an operator SHALL change the chat list,
recording who made the change and when. The list SHALL survive a restart of the bot.

#### Scenario: Adding
- **WHEN** Dana Reyes runs `/aven operators add @Milo`
- **THEN** Milo Hart is an operator from his next command on, and the list records Dana Reyes and the time

#### Scenario: Restart
- **WHEN** the bot restarts after Milo Hart was added
- **THEN** he is still an operator

#### Scenario: Not a mention
- **WHEN** an operator runs `/aven operators add milo`
- **THEN** the command is refused with its usage, and nothing changes

### Requirement: The first operator named in chat ends the everyone rule

On a platform where everyone in the home workspace is an operator while nobody is named, the first
`/aven operators add` SHALL also name the person who ran it, so that the list never starts without them.

#### Scenario: First naming on Slack
- **WHEN** nobody is named and Dana Reyes runs `/aven operators add @Milo`
- **THEN** the list holds Dana Reyes and Milo Hart, and a third user of the home workspace is no longer an operator

### Requirement: The operators list cannot be emptied or cut below the config in chat

`/aven operators remove` SHALL refuse to remove a person the config names, and SHALL refuse to remove the last
operator when the config names none.

#### Scenario: Named in the config
- **WHEN** an operator runs `/aven operators remove @Dana` and the config names Dana Reyes
- **THEN** the command is refused, saying that she is named in the installation's config

#### Scenario: The last one
- **WHEN** the chat list holds only Dana Reyes, the config names nobody, and she runs `/aven operators remove @Dana`
- **THEN** the command is refused, and she stays an operator

### Requirement: An operator sets a project's model from chat

`/aven model <name>` in a project's conversation, by an operator, SHALL make that project's agent run on the named
model in every conversation that starts afterwards. The name SHALL be one of the model names the installation's
pinned agent CLI accepts; anything else, a non-operator, or a conversation with no project SHALL be refused with
nothing stored.

#### Scenario: Setting
- **WHEN** an operator runs `/aven model opus` in the channel of project `atlas`
- **THEN** the next conversation started in `atlas` runs on that model, and other projects are unchanged

#### Scenario: Unknown name
- **WHEN** an operator runs `/aven model fastest`
- **THEN** the command is refused, listing the names that are accepted, and nothing is stored

#### Scenario: Not an operator
- **WHEN** a user who may drive the agent but is not an operator runs `/aven model opus`
- **THEN** the command is refused, and nothing is stored

### Requirement: An operator sets a project's effort from chat

`/aven effort low|medium|high` in a project's conversation, by an operator, SHALL make that project's agent start
with that effort in every conversation that starts afterwards; any other value, a non-operator, or a conversation
with no project SHALL be refused with nothing stored.

#### Scenario: Setting
- **WHEN** an operator runs `/aven effort high` in `atlas`'s channel
- **THEN** the next conversation started in `atlas` starts with high effort

#### Scenario: Unknown level
- **WHEN** an operator runs `/aven effort extreme`
- **THEN** the command is refused, listing `low`, `medium` and `high`

### Requirement: A running conversation keeps its model and effort

A conversation whose session already exists SHALL keep the model and effort it started with until that session
ends or is restarted, and the reply to a change SHALL say so.

#### Scenario: Thread in progress
- **WHEN** a thread of `atlas` has a session and an operator runs `/aven model opus`
- **THEN** the reply says that running conversations keep their model, and that thread's next turn runs as before

#### Scenario: After a restart of the session
- **WHEN** someone then presses Restart session on that thread and writes again
- **THEN** that turn runs on the newly set model

### Requirement: The model and effort settings are recorded and can be read

A project's chat-set model and effort SHALL be stored with the installation's state with who set each and when,
SHALL survive a restart of the bot, and `/aven model` or `/aven effort` with no arguments SHALL show the value
in force and its source to anyone who may see the project's settings.

#### Scenario: Reading
- **WHEN** a viewer runs `/aven model` in `atlas`'s channel after Dana Reyes set `opus`
- **THEN** the reply names `opus`, set in chat by Dana Reyes, with the date

#### Scenario: Nothing set in chat
- **WHEN** nothing was set for `atlas` and the installation's setting names a model
- **THEN** the reply names that model and says it is the installation's default

### Requirement: `default` returns a project to the installation's setting

`/aven model default` and `/aven effort default` by an operator SHALL remove the project's chat-set value, so that
conversations starting afterwards use what the installation's settings say, exactly as a project never set in chat.

#### Scenario: Back to the default
- **WHEN** `atlas` has `opus` set in chat and an operator runs `/aven model default`
- **THEN** the next conversation in `atlas` starts as it would on an installation where nothing was ever set

### Requirement: The Home shows operators an operator section

With the flag on, the Home of an operator SHALL carry a section that names the operators and, for each project of
the home workspace, its model, its effort and its active grants with their end times. The Home of anyone else
SHALL be what it is without the flag.

#### Scenario: Operator
- **WHEN** Dana Reyes, an operator, opens the Home while `atlas` holds `workflows` until 14:30 and runs on `opus`
- **THEN** her Home shows the operators, and for `atlas` the model `opus`, its effort and `workflows` until 14:30

#### Scenario: Not an operator
- **WHEN** Milo Hart, who may drive the agent but is not an operator, opens the Home
- **THEN** his Home has no operator section and no operator control

### Requirement: The operator section acts as the commands do

Each control of the operator section — reload the config, start a grant, end a grant, set a project's model, set
a project's effort — SHALL do exactly what the matching command does, with the same refusals, and SHALL check
that the person pressing it is an operator at that moment.

#### Scenario: Reload from the Home
- **WHEN** an operator presses Reload in the section
- **THEN** the config is re-read as by `/aven reload`, and the Home shows the outcome

#### Scenario: Pressed by someone who is no longer an operator
- **WHEN** Milo Hart was removed from the operators and presses a control on a Home he still has open
- **THEN** nothing changes, and he is told the control is operator-only

### Requirement: A grant started outside a conversation is announced in the project's conversation

A grant started or ended from the Home SHALL be announced as any grant is, in the project's own channel or room,
naming who pressed it.

#### Scenario: Grant from the Home
- **WHEN** Dana Reyes starts `workflows` for `atlas` from her Home at 14:00
- **THEN** `atlas`'s channel sees that Dana Reyes gave `atlas` GitHub workflows write until 14:30

### Requirement: The Session card shows operators the project's controls

With the flag on, the Session card opened by an operator SHALL also show the project's model, effort and active
grants, with the same controls as the Home's section for that one project. Opened by anyone else it SHALL be
today's card.

#### Scenario: Operator opens the card
- **WHEN** an operator presses ⚙️ Session under an answer in a thread of `atlas`
- **THEN** the card, visible to them alone, shows today's content and `atlas`'s model, effort, grants and controls

#### Scenario: Someone else opens it on the same answer
- **WHEN** a user who is not an operator presses ⚙️ Session under the same answer
- **THEN** they see today's card, with no operator control
