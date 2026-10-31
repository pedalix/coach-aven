# Spec Delta

## Purpose

When a project's memory consolidation (a dream) runs: nightly by default, or on a schedule the channel sets.

## ADDED Requirements

### Requirement: A dream runs on the schedule the channel gives it
`/aven dream on <when>` SHALL accept the schedule forms of `/aven schedule` and SHALL create the project's dream on that schedule, or move its existing dream to it and enable it. Without `<when>`, a new dream SHALL run daily at 03:00 and an existing one SHALL keep its schedule. A schedule it cannot read SHALL be refused with the accepted forms, changing nothing.

#### Scenario: Weekly from the start
- **WHEN** a project channel with no dream sends `/aven dream on weekly sun 3:00`
- **THEN** the project's dream runs on Sundays at 03:00 and the reply names `weekly sun 3:00`

#### Scenario: Nightly moved to weekly
- **WHEN** a channel whose dream runs daily sends `/aven dream on weekly sun 3:00`
- **THEN** the same dream now runs weekly, and `/aven dream` shows `weekly sun 3:00`

#### Scenario: Unreadable schedule
- **WHEN** the channel sends `/aven dream on fortnightly`
- **THEN** the reply lists the accepted forms and no dream is created or changed

#### Scenario: Today's shape
- **WHEN** the channel sends a bare `/aven dream on`
- **THEN** a new dream runs daily at 03:00, as before
