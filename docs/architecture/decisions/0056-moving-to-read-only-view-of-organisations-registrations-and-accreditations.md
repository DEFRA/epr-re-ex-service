# 56. Moving to read-only view of organisations, registrations and accreditations

Date: 2026-11-11

## Status

Approved

## Context

This ADR outlines an implementation approach with `epr-backend` to migrate from using the `OrganisationsRepository` to the `OrganisationReadRepository`.

### Read model

ADR [52. Organisation read model](0052-organisation-read-model.md) outlined a read-only model for working with an organisation and it's associated registrations and accreditations. It was introduced into the `epr-backend` code via a new `OrganisationReadRepository` port, which was created alongside the original `OrganisationsRepository` port

The original `OrganisationsRepository` port exposed (keyed by internal Mongo document IDs for each entity)

- read functions that surface an `Organisation` _as stored_ in Mongo (including its registrations and accreditations)
- functions to mutate an organisation (eg Defra ID organisation linking, user management)
- functions to mutate a registration (eg status changes)
- functions to mutate an accreditation (eg status changes)

Initially the new `OrganisationReadRepository` port only surfaced

- read functions that surface an `Organisation` (as per the read model), keyed by natural keys (`{organisationNumber}, {registrationNumber}, {year}, {accreditationNumber}`)

The main benefits offered by the read model are

- allows modelling a registration spanning multiple years, with a different accreditation for each operational year (which is required for the service to be able to continue working into the 2027 operational year).
- a slimmer representation of the `Organisation/Registration/Accreditation` that is a better fit to the REEX domain, driving simpler domain logic/code.

### Ownership

The "contingency solution" for submitting applications for an Organisation to use the REEX service meant that from day 1 all three of organisations, registrations and accreditations landed in `epr-backend`'s database, and thus had to be managed (ie. mutated) within the service.

We are now working towards a target architecture where

- Organisations are read by REEX, but managed in another EPR service (current thinking is "Manage Organisation")
- Registrations and Accreditations are read by REEX, but managed in the (RREPW) Registration & Accreditation service
- Waste recording for operators (reprocessors and exporters), waste balance, PRNs and operator reports are owned by REEX
- Regulator facing reports are owned by REEX for now (with a possible move to the Analytics & Insights service later)

As of Q3/Q4 2026, all the above entities above still exist solely in REEX, apart from 2027 accreditations (2026 accreditations still live only in REEX).

## Decision

The migration work will target

1. features that need sight of accreditations go through functions on the `OrganisationReadRepository` port

- the port should only expose functions for reading organisation/registration/accreditation data

1. features that mutate the organisation, a registration or a 2026 accreditation should stay on the original `OrganisationsRepository` port, e.g.

- user linking
- Defra ID organisation linking
- Registration and (2026) accreditation status changes
- other maintainence tasks performed via the JSON editor in the Admin UI

## Consequences

This ADR

- formalises a migration strategy that the team/agents can working in `epr-backend`
- creates a seam in the application code between entities owned by REEX, and external entities read by REEX
  - this includes the entities that are currently within REEX that will ultimately be extracted
