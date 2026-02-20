# 27. Use orgId as the Primary Organisation Identifier

Date: 2026-02-20

## Status

Proposed

## Context

EPR organisations currently have three distinct identifiers:

| Identifier | Type | Example | Purpose |
|---|---|---|---|
| `_id` / `id` / `referenceNumber` | MongoDB ObjectId (24-char hex) | `6507f1f77bcf86cd79943901` | Internal database key, also emailed to operators |
| `orgId` | Positive integer (>= 500,000) | `500023` | EPR regulatory reference number |
| `linkedDefraOrganisation.orgId` | UUID | `550e8400-e29b-41d4-...` | Cross-government Defra identity link |

The first two both identify the same organisation within EPR. The MongoDB ObjectId (`id`) is used pervasively: in API routes (`/v1/organisations/{organisationId}`), cross-collection references (`organisationId` fields in waste-records, summary-logs, waste-balances, PRNs), session storage, and frontend URLs. The numeric `orgId` is displayed to users on the account linking screen but otherwise unused outside the organisation document itself.

### How the ObjectId became user-facing

When an organisation form is submitted, the `POST /v1/apply/organisation` handler inserts a document into MongoDB, then captures the auto-generated ObjectId as a "reference number":

```javascript
const { insertedId } = await collection.insertOne(organisationFactory({ orgId, ... }))
const referenceNumber = insertedId.toString()
```

This `referenceNumber` is emailed to the operator alongside the `orgId` via GovNotify. When the operator later submits registration and accreditation forms, they must include **both** `orgId` and `referenceNumber`. The form-submissions system stores both on registration/accreditation documents and indexes `referenceNumber` for lookups.

However, the `referenceNumber` was never deliberately designed as an identifier. It is simply the string representation of MongoDB's auto-generated `_id`. The `orgId`, by contrast, is generated from a dedicated counter and was designed to be the domain identifier. Registration and accreditation documents already carry `orgId` as a foreign key, making `referenceNumber` redundant as a lookup key. Operators are burdened with two identifiers (a 6-digit number and a 24-character hex string) when one would suffice.

### The referenceNumber as an accidental credential

The form-submission endpoints (`POST /v1/apply/registration`, `POST /v1/apply/accreditation`) are unauthenticated (`auth: false`). They are called by Defra Forms on behalf of the operator, with no bearer token or session.

Because `orgId` is sequential and guessable, requiring only `orgId` would allow anyone to submit registrations and accreditations against any organisation. The `referenceNumber` — a 24-character hex string known only to the person who received the confirmation email — acts as a shared secret that proves the submitter is associated with that organisation.

This means the `referenceNumber` is accidentally serving as a credential, not just an identifier. Any migration that removes it must address this authentication gap. Options include:

- **Adding proper authentication** to the apply endpoints (the right long-term answer, but requires changes to Defra Forms integration)
- **Replacing it with a purpose-built token** generated and emailed for form submission verification
- **Making `orgId` itself unguessable** by using random values rather than sequential numbers (but this changes the nature of the identifier and affects usability)

This ADR does not prescribe which approach to take for the credential replacement, but the migration **must not** remove the `referenceNumber` from the form-submission flow until an alternative authentication mechanism is in place.

### Problems

1. **Two identifiers for the same concept.** Developers must know that `id` is the technical key and `orgId` is the human-readable one. The naming is confusing: `orgId` sounds like the primary identifier but isn't, while `organisationId` in route parameters refers to the MongoDB ObjectId.

2. **An accidental identifier became user-facing.** The `referenceNumber` is a MongoDB ObjectId that was never designed to be shown to users. It leaked into emails, forms, and the form-submission data model simply because it was available after `insertOne()`. The deliberately designed identifier (`orgId`) was already present and could have served the same purpose.

3. **Leaking infrastructure into the domain.** The MongoDB ObjectId is an implementation detail of the persistence layer, yet it appears in API contracts, URLs, session data, and user-facing emails. The port/adapter boundary is violated; consumers are coupled to a database technology choice.

4. **Unnecessary complexity in aggregation pipelines.** Cross-collection joins require `$toObjectId` conversions because other collections store the organisation reference as a string (the hex representation of the ObjectId), while the organisations collection uses a native ObjectId for `_id`. This is purely mechanical complexity that adds no value.

5. **Opaque URLs.** `/organisations/6507f1f77bcf86cd79943901` conveys nothing to a user or developer reading logs. `/organisations/500023` is immediately recognisable as an EPR organisation number.

6. **Configuration already uses both.** Environment configuration in `cdp-app-config` reflects the split identity. `TEST_ORGANISATIONS` already uses numeric `orgId` values (e.g. `[500521,500002]`), while `FORM_SUBMISSION_OVERRIDES` must explicitly map between ObjectId hex and numeric `orgId` for each organisation. `SYSTEM_REFERENCES_REQUIRING_ORG_ID_MATCH` uses ObjectId hex strings. The dual-identifier problem extends beyond code into operational configuration.

The `orgId` field already has a unique index on the organisations collection and is present on every organisation document. It is generated internally (sequentially from 500,000) and is stable, immutable, and meaningful to the domain.

## Options

### Option 1: Keep the status quo

Continue using both identifiers with their current roles.

**Pros:**

- No migration effort
- No risk of introducing bugs

**Cons:**

- The confusion persists and compounds as the codebase grows
- New developers must learn which "organisation ID" is which
- Aggregation pipelines remain unnecessarily complex
- Infrastructure detail continues to leak through the domain boundary

### Option 2: Use orgId as the primary identifier at the port/adapter boundary

Keep MongoDB's `_id` (ObjectId) as an internal implementation detail within the MongoDB adapter. Change the repository port so that all operations identify organisations by `orgId` (the numeric EPR reference). The adapter translates between `orgId` and `_id` internally.

Other collections are augmented with the numeric `orgId` alongside their existing `organisationId` field, then migrated in phases:

1. **Augment:** Write `orgId` to all collections alongside existing `organisationId`. New documents include both fields.
2. **Switch:** Change all consumers (routes, frontend, aggregation pipelines) to use `orgId`. Remove `$toObjectId` conversions from aggregation pipelines.
3. **Deprecate:** Remove the old `organisationId` (ObjectId hex) field from other collections.

**Pros:**

- One meaningful identifier throughout the domain
- Clean port/adapter boundary: MongoDB ObjectId stays inside the adapter
- Aggregation pipelines simplify (no `$toObjectId`)
- Human-readable URLs and logs
- Incremental migration with no big-bang cutover
- `orgId` unique index already exists

**Cons:**

- Migration effort across multiple collections and both frontend/backend codebases
- Transition period where both identifiers coexist in other collections
- Risk of bugs during migration if a reference is missed

### Option 3: Replace MongoDB _id with orgId

Use the numeric `orgId` as MongoDB's `_id` field directly, eliminating the ObjectId entirely.

**Pros:**

- Simplest possible end state: one field, one identifier
- No translation layer needed even inside the adapter

**Cons:**

- Requires migrating the organisations collection itself (changing `_id` means deleting and reinserting every document)
- Loses MongoDB ObjectId benefits (embedded timestamp, guaranteed uniqueness without coordination) even though we don't currently use them
- Higher risk for no meaningful gain over Option 2

## Decision

Option 2: Use `orgId` as the primary identifier at the port/adapter boundary, migrated incrementally.

The MongoDB ObjectId remains as MongoDB's internal `_id` but never appears outside the adapter layer. All API contracts, routes, cross-collection references, session storage, and frontend URLs use the numeric `orgId`.

This respects the existing port/adapter architecture (see ADR 0015) by keeping the persistence mechanism as an implementation detail, while giving the domain a single, meaningful identifier.

## Consequences

### API and frontend

- API routes change from `/v1/organisations/{objectIdHex}` to `/v1/organisations/{orgId}` (numeric)
- Frontend URLs become human-readable (e.g. `/organisations/500023`)
- The `idSchema` in the organisations repository changes from ObjectId validation to numeric validation

### Data layer

- Aggregation pipelines in tonnage-monitoring and waste-balance-availability simplify by removing `$toObjectId` conversions
- Other collections (waste-records, summary-logs, waste-balances, PRNs) gain a numeric `orgId` field during Phase 1 and lose the old `organisationId` (ObjectId hex) field after Phase 3
- During the transition period, both fields exist in other collections and code must be consistent about which it uses

### Form submissions

- The `referenceNumber` currently serves as both an identifier and an accidental credential on the unauthenticated apply endpoints. It **must not** be removed from the form-submission flow until an alternative authentication mechanism is in place (see Context)
- Once credential replacement is addressed: the `POST /v1/apply/organisation` handler stops emailing the MongoDB ObjectId as `referenceNumber`, operators receive only `orgId`, and registration/accreditation forms are simplified to collect only `orgId`
- The `referenceNumber` field and its index on the registration and accreditation collections can be removed after the credential concern is resolved
- Existing form-submission data retains `referenceNumber` for historical reference but it is no longer used for lookups

### Unaffected

- Registration and accreditation identifiers within the organisation document retain their existing ObjectId format
- The `linkedDefraOrganisation.orgId` (UUID) is unaffected; it identifies an organisation in a different system (Defra central government) and serves a different purpose

### Configuration

- Environment configuration in `cdp-app-config` simplifies: `FORM_SUBMISSION_OVERRIDES` can drop ObjectId-to-orgId mappings, and `SYSTEM_REFERENCES_REQUIRING_ORG_ID_MATCH` switches to numeric values
