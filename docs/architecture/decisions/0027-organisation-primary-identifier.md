# 27. Use orgId as the Primary Organisation Identifier

Date: 2026-02-20

## Status

Proposed

## Context

EPR organisations currently have three distinct identifiers:

| Identifier | Type | Example | Purpose |
|---|---|---|---|
| `_id` / `id` | MongoDB ObjectId (24-char hex) | `6507f1f77bcf86cd79943901` | Internal database key |
| `orgId` | Positive integer (>= 500,000) | `500023` | EPR regulatory reference number |
| `linkedDefraOrganisation.orgId` | UUID | `550e8400-e29b-41d4-...` | Cross-government Defra identity link |

The first two both identify the same organisation within EPR. The MongoDB ObjectId (`id`) is used pervasively: in API routes (`/v1/organisations/{organisationId}`), cross-collection references (`organisationId` fields in waste-records, summary-logs, waste-balances, PRNs), session storage, and frontend URLs. The numeric `orgId` is displayed to users on the account linking screen but otherwise unused outside the organisation document itself.

This creates several problems:

1. **Two identifiers for the same concept.** Developers must know that `id` is the technical key and `orgId` is the human-readable one. The naming is confusing: `orgId` sounds like the primary identifier but isn't, while `organisationId` in route parameters refers to the MongoDB ObjectId.

2. **Leaking infrastructure into the domain.** The MongoDB ObjectId is an implementation detail of the persistence layer, yet it appears in API contracts, URLs, and session data. The port/adapter boundary is violated; consumers are coupled to a database technology choice.

3. **Unnecessary complexity in aggregation pipelines.** Cross-collection joins require `$toObjectId` conversions because other collections store the organisation reference as a string (the hex representation of the ObjectId), while the organisations collection uses a native ObjectId for `_id`. This is purely mechanical complexity that adds no value.

4. **Opaque URLs.** `/organisations/6507f1f77bcf86cd79943901` conveys nothing to a user or developer reading logs. `/organisations/500023` is immediately recognisable as an EPR organisation number.

5. **Configuration already uses both.** Environment configuration in `cdp-app-config` reflects the split identity. `TEST_ORGANISATIONS` already uses numeric `orgId` values (e.g. `[500521,500002]`), while `FORM_SUBMISSION_OVERRIDES` must explicitly map between ObjectId hex and numeric `orgId` for each organisation. `SYSTEM_REFERENCES_REQUIRING_ORG_ID_MATCH` uses ObjectId hex strings. The dual-identifier problem extends beyond code into operational configuration.

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

- API routes change from `/v1/organisations/{objectIdHex}` to `/v1/organisations/{orgId}` (numeric)
- Frontend URLs become human-readable (e.g. `/organisations/500023`)
- The `idSchema` in the organisations repository changes from ObjectId validation to numeric validation
- Aggregation pipelines in tonnage-monitoring and waste-balance-availability simplify by removing `$toObjectId` conversions
- Other collections (waste-records, summary-logs, waste-balances, PRNs) gain a numeric `orgId` field during Phase 1 and lose the old `organisationId` (ObjectId hex) field after Phase 3
- During the transition period, both fields exist in other collections and code must be consistent about which it uses
- Registration and accreditation identifiers within the organisation document are unaffected by this change; they retain their existing ObjectId format
- The `linkedDefraOrganisation.orgId` (UUID) is unaffected; it identifies an organisation in a different system (Defra central government) and serves a different purpose
- Environment configuration in `cdp-app-config` simplifies: `FORM_SUBMISSION_OVERRIDES` can drop ObjectId-to-orgId mappings, and `SYSTEM_REFERENCES_REQUIRING_ORG_ID_MATCH` switches to numeric values
