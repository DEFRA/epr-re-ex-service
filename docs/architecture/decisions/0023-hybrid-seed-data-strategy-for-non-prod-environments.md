# 23. Hybrid seed data strategy for non-prod environments

Date: 2025-12-29

## Status

Proposed

## Context

Non-prod environments seed data at startup via `createSeedData()` in `src/common/helpers/collections/create-update.js`. Currently, this seeds:

1. **Form submissions** (raw DEFRA Forms data) from static JSON fixtures
2. **EPR organisations** from 4 static JSON files in `src/data/fixtures/common/epr-organisations/`
3. **Waste records** from static JSON fixtures

The 4 EPR organisation fixtures only represent organisations in the "created" status. This is insufficient for testing, which requires organisations in various states:

- **Approved** organisations (with approved registrations/accreditations)
- **Active** organisations (linked to DefraId, with active registrations/accreditations)
- **Mixed states** (e.g., active organisation with a rejected accreditation)
- **Custom users** (testers need their email in the `users` array)

Maintaining static JSON files for every state combination is impractical due to:

- The complexity of status transitions (organisation, registration, and accreditation statuses must be consistent)
- The need for valid cross-references (e.g., `linkedDefraOrganisation`, `accreditationId`)
- Duplication of large JSON structures with minor variations

## Decision

Adopt a **hybrid approach** that combines:

1. **Static JSON fixtures** for baseline "created" organisations (preserves full data model documentation)
2. **Programmatic scenarios** for state variations using builder functions

The implementation will:

- Keep existing JSON fixtures unchanged for backward compatibility
- Add a new scenarios module that programmatically creates organisations in different states
- Use fixed `orgId` values for each scenario to enable idempotent seeding
- Support environment variable configuration (e.g., `SEED_TESTER_EMAIL`) for customisation

Example scenarios to seed:

| Scenario                             | orgId | Description                            |
| ------------------------------------ | ----- | -------------------------------------- |
| `approved_organisation`              | 50020 | Approved org with approved reg/acc     |
| `active_organisation`                | 50030 | Active org with tester email in users  |
| `active_with_rejected_accreditation` | 50040 | Active org with rejected accreditation |

## Proof of Concept Implementation

A proof of concept has been implemented to validate this approach. The implementation consists of:

### New Files

**`src/common/helpers/collections/seed-scenarios.js`**

Defines programmatic scenarios for seeding EPR organisations. Key components:

- `SCENARIO_ORG_IDS` - Fixed orgIds for each scenario (50020, 50030, 50040)
- `buildApprovedOrgForSeed()` - Creates an approved organisation with:
  - Status set to `approved`
  - First registration approved with `registrationNumber`, `validFrom`, `validTo`
  - First accreditation approved with `accreditationNumber`, `validFrom`, `validTo`
- `buildActiveOrgForSeed()` - Creates an active organisation with:
  - Status set to `active`
  - `linkedDefraOrganisation` with valid UUIDs
  - Tester email in `users` array (configurable via `SEED_TESTER_EMAIL` env var)
  - All approved registrations/accreditations transitioned to `active`
- `buildActiveOrgWithRejectedAccreditation()` - Creates an active organisation where:
  - Organisation and registration are `active`
  - Matching accreditation is `rejected`
- `createEprOrganisationScenarios()` - Main entry point that:
  - Checks if scenarios already exist (idempotent)
  - Creates each scenario using the repository
  - Logs success/failure for each scenario

**`src/common/helpers/collections/seed-scenarios.test.js`**

Unit tests covering:

- All three scenarios are created
- Each scenario has correct status at org/registration/accreditation level
- Environment variable customisation works
- Idempotent seeding (skips if scenarios exist)
- Schema validation passes (repository validates on insert/replace)

### Modified Files

**`src/common/helpers/collections/create-update.js`**

Added call to `createEprOrganisationScenarios()` in the seeding flow:

```javascript
if (!isProduction()) {
  await createOrgRegAccFixtures(db)
  await createEprOrganisationFixtures(db, organisationsRepository)
  await createEprOrganisationScenarios(db, organisationsRepository) // NEW
  await createWasteRecordsFixtures(db, wasteRecordsRepository)
}
```

### Schema Validation

The implementation leverages existing repository validation:

1. `organisationsRepository.insert()` validates against `organisationInsertSchema`
2. `organisationsRepository.replace()` validates against `organisationReplaceSchema`

If scenarios produce invalid data, seeding fails with descriptive error messages. This was verified during development when initial implementation had:

- Non-UUID values for `linkedDefraOrganisation.orgId` (required UUID)
- Invalid role values (required `initial_user` or `standard_user`)

### Eventual Consistency

The implementation handles eventual consistency in the in-memory repository by:

- Using `findById(id, minimumVersion)` to wait for expected version after replace operations
- This ensures subsequent operations see the updated state

## Consequences

### Easier

- Adding new test scenarios (define in code, no JSON maintenance)
- Ensuring data consistency (builders handle status transitions correctly)
- Customising seed data per environment (via env vars)
- Maintaining accurate test data as the domain model evolves

### More difficult

- Understanding the full data model at a glance (mitigated by keeping comprehensive JSON fixtures)
- Debugging seed failures (mitigated by per-scenario logging)

### Risks

- Builders must be kept in sync with domain rules (mitigated: schema validation catches violations)
- Seed data changes require code changes (acceptable: this is intentional for traceability)
- Additional startup time for programmatic seeding (minimal: ~50ms for 3 scenarios)

## Alternatives Considered

### Using `/v1/dev/` endpoints

The existing `PATCH /v1/dev/organisations/{id}` endpoint could be used to modify organisations after seeding. However:

- Requires an existing organisation to patch (doesn't solve creation)
- Bypasses domain validation (can create invalid state)
- Not reproducible across environments
- Adds network overhead

**Verdict**: Complementary for ad-hoc testing, not a replacement for seed data.

### More static JSON fixtures

Creating additional JSON files for each state:

- High maintenance burden
- Error-prone (must manually maintain status consistency)
- Difficult to keep in sync with schema changes

**Verdict**: Does not scale.
