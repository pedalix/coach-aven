# Spec Delta

## ADDED Requirements

### Requirement: A driver states whether it delivers files
A chat driver SHALL declare in its capabilities whether it can post files into a conversation, and the core SHALL
offer the agent an outbox only on a surface that declares it can.

#### Scenario: Slack and web deliver, Teams does not
- **WHEN** the core asks each driver's capabilities
- **THEN** the Slack and web drivers report file delivery and the Teams driver reports none

### Requirement: A driver posts files into a conversation
A chat driver that declares file delivery SHALL post a set of named files into a conversation and thread the core
names, with each file's bytes and media type, and SHALL throw on a platform failure so the core can name the file.

#### Scenario: Several files in one post
- **WHEN** the core posts two files into a thread
- **THEN** both appear in that thread, in the order given, with their names

#### Scenario: The platform refuses
- **WHEN** the platform answers the upload with an error
- **THEN** the driver throws, and the core posts the notice (the driver posts nothing itself)

### Requirement: Driver capabilities are published in one table
The documentation SHALL carry one table of every chat driver's declared capabilities, rendered from the drivers'
own declarations, and a test SHALL fail when the table and the declarations differ.

#### Scenario: A capability is added
- **WHEN** a driver's capabilities gain a field or a driver changes a value
- **THEN** the test fails until the table in the documentation shows the new state

#### Scenario: Reading what a surface implements
- **WHEN** an operator asks whether a surface delivers outbound files
- **THEN** the table answers for Slack, Teams, the web and the shadow driver without reading code
