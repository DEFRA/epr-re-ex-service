# 27. Modular monolith structure

Date: 2026-01-26

## Status

Proposed

## Context

The engineering team is splitting into two sub-teams with distinct ownership areas:

- **Support/BAU team**: Existing functionality support, Performance & Stability, Waste Balance, Glass, Public Register
- **PRNs feature team**: Delivering Create and Issue capabilities for Packaging Recycling Notes

Both teams will be working primarily in the epr-backend repository. With the current flat structure, there is a high risk of merge conflicts and teams inadvertently affecting each other's work. Features are currently spread across multiple top-level directories:

```
src/
├── domain/
│   ├── organisations/
│   ├── summary-logs/
│   ├── waste-balances/
│   └── waste-records/
├── repositories/
│   ├── organisations/
│   ├── summary-logs/
│   ├── waste-balances/
│   └── waste-records/
├── routes/v1/
│   ├── organisations/
│   └── ...
└── ...
```

This structure makes it difficult to understand feature boundaries, assign clear ownership, and work independently on different features.

### Alternatives considered

#### 1. Keep the current structure

Continue with the existing flat organisation and manage conflicts through communication and code review.

##### Advantages

* No migration effort required
* Team is already familiar with the structure

##### Disadvantages

* High risk of merge conflicts between teams
* No clear ownership boundaries
* Difficult to understand feature scope
* Changes to one feature may inadvertently affect another

#### 2. Split into separate microservices

Extract PRNs (and potentially other features) into separate deployable services.

##### Advantages

* Complete isolation between teams
* Independent deployment and scaling
* Clear service boundaries

##### Disadvantages

* Significant operational overhead (multiple deployments, monitoring, networking)
* Premature optimisation—we don't yet know where the boundaries should be
* Increased complexity for cross-cutting concerns (auth, logging)
* Data consistency challenges across services

#### 3. Modular monolith

Restructure the codebase into feature modules within the same deployable unit. Each module contains its own domain logic, repositories, and routes. Shared concerns remain in common locations.

##### Advantages

* Clear ownership boundaries without operational overhead
* Teams can work independently with minimal conflicts
* Maintains deployment simplicity
* Preserves data consistency (single database, transactions)
* Natural evolution path—modules can be extracted to services later if needed
* Incremental migration possible

##### Disadvantages

* Requires migration effort for existing code
* Need to establish and maintain module conventions
* Discipline required to respect module boundaries

## Decision

We will restructure the epr-backend codebase into a modular monolith. The target structure will be:

```
src/
├── modules/
│   ├── prns/
│   │   ├── domain/
│   │   ├── repositories/
│   │   ├── routes/
│   │   └── index.js
│   ├── summary-logs/
│   │   ├── domain/
│   │   ├── repositories/
│   │   ├── routes/
│   │   └── index.js
│   ├── waste-balances/
│   │   ├── domain/
│   │   ├── repositories/
│   │   ├── routes/
│   │   └── index.js
│   ├── organisations/
│   │   ├── domain/
│   │   ├── repositories/
│   │   ├── routes/
│   │   └── index.js
│   └── public-register/
│       └── ...
├── shared/
│   ├── auth/
│   ├── validation/
│   ├── common/
│   └── server/
├── config.js
└── index.js
```

### Module conventions

1. **Self-contained**: Each module contains all code for its feature (domain, repositories, routes)
2. **Ports and adapters**: Modules continue to use the existing ports and adapters pattern for data access
3. **No cross-module imports initially**: Modules should not directly import from other modules' internals. If a module needs data from another module, it uses the repository port (this maintains the existing pattern)
4. **Shared code**: Genuinely shared utilities (auth, validation helpers, date formatting) live in `src/shared/`
5. **Public interface (future)**: When modules mature, each will export a public interface via `index.js`. At that point, cross-module access must go through this interface

### Migration strategy

1. **PRNs starts fresh**: All new PRN code goes directly into `src/modules/prns/`
2. **Existing features migrate incrementally**: Move existing features into modules opportunistically—when making significant changes to a feature, migrate it first
3. **No big-bang migration**: We don't need to migrate everything at once. The hybrid structure (some code in modules, some in legacy locations) is acceptable during transition
4. **Shared code last**: Extract shared utilities to `src/shared/` as we identify them during module migrations

### Team ownership

| Module | Team |
|--------|------|
| `prns` | PRNs feature team |
| `summary-logs` | Support/BAU |
| `waste-balances` | Support/BAU |
| `organisations` | Support/BAU |
| `public-register` | Support/BAU |
| `shared` | Both (requires cross-team review) |

## Consequences

### Advantages

* **Clear ownership**: Each team knows which directories they own
* **Reduced conflicts**: Teams work in separate parts of the codebase
* **Better cohesion**: All code for a feature is co-located
* **Easier onboarding**: New developers can understand a feature by looking at one directory
* **Future flexibility**: Modules can be extracted to separate packages or services if needed

### Disadvantages

* **Migration effort**: Existing features need to be moved (though this can be incremental)
* **Learning curve**: Team needs to understand and follow module conventions
* **Potential duplication**: Some code may be duplicated between modules initially until it's clear what should be shared
* **Import path changes**: Existing import paths will need updating as code moves

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Module boundaries become unclear over time | Document conventions, enforce in code review |
| Shared code becomes a dumping ground | Require justification for additions to `shared/`, prefer module-specific code |
| Migration disrupts active development | Migrate during low-activity periods, coordinate with both teams |
