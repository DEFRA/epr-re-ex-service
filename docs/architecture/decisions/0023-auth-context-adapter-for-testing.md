# 23. Auth Context Adapter for Testing

Date: 2025-12-11

## Status

Proposed

## Context

When adding authentication and authorisation to endpoints in epr-backend, tests become complex due to the ceremony required to set up the auth flow:

1. Mock OIDC servers via `setupAuthContext()`
2. Create an organisation linked to the hardcoded Defra ID token constants (`COMPANY_1_ID`, etc.)
3. Use `buildActiveOrg()` to create the org with correct `linkedDefraOrganisation` structure
4. Pass the `organisationsRepository` to the test server
5. Use Bearer token headers with the mock token

This results in 15-20 lines of boilerplate per test file, tightly coupled to hardcoded token constants. The tests become difficult to read because the auth setup obscures the business logic being tested.

Additionally, the current design couples authentication (validating tokens) with authorisation (checking org access) inside the JWT validate function. This makes it impossible to test authorisation scenarios (e.g. user A cannot access user B's data) without going through the full JWT flow.

### Current Auth Flow

```
JWT validate() → getDefraUserRoles() → getOrgMatchingUsersToken() → getRolesForOrganisationAccess()
                                              ↓
                                    request.organisationsRepository
```

The org access check happens inside token validation, meaning:

- Tests must use real (mock) tokens to exercise authorisation
- Hapi's `server.inject({ auth })` bypasses the org check entirely
- No clean way to test cross-org access control

## Decision

We propose a two-tier approach: simple auth injection helpers for unit tests, and a full auth context adapter for integration tests that need to verify cross-org access control.

### Tier 1: Auth Injection Helpers for Unit Tests

For unit tests that focus on business logic rather than auth behaviour, Hapi's built-in `server.inject({ auth })` option allows credentials to be injected directly, bypassing JWT validation entirely.

Create simple helper functions in `src/test/inject-auth.js`:

```javascript
import { ROLES } from '#common/helpers/auth/constants.js'

/**
 * Creates auth injection options for a standard user
 * @param {object} [overrides] - Optional credential overrides
 * @returns {object} Auth options for server.inject()
 */
export const asStandardUser = (overrides = {}) => ({
  auth: {
    strategy: 'access-token',
    credentials: {
      scope: [ROLES.standardUser],
      id: 'test-user-id',
      email: 'test@example.com',
      ...overrides
    }
  }
})

export const asServiceMaintainer = (overrides = {}) => ({
  auth: {
    strategy: 'access-token',
    credentials: {
      scope: [ROLES.serviceMaintainer],
      id: 'test-maintainer-id',
      email: 'maintainer@example.com',
      ...overrides
    }
  }
})

// Similar helpers for asLinker(), asInquirer(), etc.
```

Usage in unit tests:

```javascript
import { asStandardUser } from '#test/inject-auth.js'

describe('POST upload-completed', () => {
  setupAuthContext() // Still needed for OIDC config fetch at server startup

  it('accepts valid payload', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/organisations/org-123/registrations/reg-456/summary-logs/sum-789/upload-completed`,
      payload: { ... },
      ...asStandardUser()
    })

    expect(response.statusCode).toBe(202)
  })
})
```

**Benefits of Tier 1:**

- Reduces boilerplate from 15-20 lines to a single spread operator
- No need for `buildActiveOrg()`, `organisationsRepository` setup, or token constants
- Tests can use any organisation ID without matching token claims
- Clear, readable test code focused on business logic

**Limitations of Tier 1:**

- Bypasses org access checks entirely (user could access any org)
- Not suitable for testing authorisation scenarios
- `setupAuthContext()` still required for server startup

### Tier 2: Auth Context Adapter for Integration Tests

For integration tests that need to verify users can only access their own organisations, introduce an **Auth Context Adapter** using the ports and adapters pattern to decouple org access checking from JWT validation.

#### Auth Context Port

```javascript
/**
 * @typedef {Object} AuthContextAdapter
 * @property {(userId: string, orgId: string) => Promise<AuthAccess>} getUserOrgAccess
 */

/**
 * @typedef {Object} AuthAccess
 * @property {string[]} roles - Roles the user has for this org
 * @property {string | null} linkedOrgId - The org ID the user is linked to
 */
```

#### Production Adapter

Wraps the existing logic from `getOrgMatchingUsersToken` and `getRolesForOrganisationAccess`:

```javascript
export const createAuthContext = (organisationsRepository) => ({
  async getUserOrgAccess(userId, orgId, tokenPayload) {
    const linkedOrg = await getOrgMatchingUsersToken(
      tokenPayload,
      organisationsRepository
    )
    if (!linkedOrg) {
      return { roles: [], linkedOrgId: null }
    }
    // Existing role determination logic
    return { roles: ['standardUser'], linkedOrgId: linkedOrg.id }
  }
})
```

#### In-Memory Adapter (for tests)

```javascript
export const createInMemoryAuthContext = () => {
  const userOrgAccess = new Map()

  return {
    async getUserOrgAccess(userId, orgId) {
      return (
        userOrgAccess.get(`${userId}:${orgId}`) || {
          roles: [],
          linkedOrgId: null
        }
      )
    },
    grantAccess(userId, orgId, roles) {
      userOrgAccess.set(`${userId}:${orgId}`, { roles, linkedOrgId: orgId })
    }
  }
}
```

#### Org Access Check Extension

Move the org access check from JWT validate to a Hapi `onPostAuth` extension:

```javascript
server.ext('onPostAuth', async (request, h) => {
  const { organisationId } = request.params
  if (!organisationId || !request.auth.isAuthenticated) {
    return h.continue
  }

  const { authContext } = request
  const { id: userId } = request.auth.credentials

  const access = await authContext.getUserOrgAccess(userId, organisationId)
  if (!access.linkedOrgId || access.linkedOrgId !== organisationId) {
    throw Boom.forbidden('Not linked to this organisation')
  }

  return h.continue
})
```

This runs after authentication but before the handler, and works with both real auth and Hapi's auth injection.

#### Test Context Factory

Provide a high-level helper for integration tests:

```javascript
const { server, orgs, asUser } = await createTestContext({
  organisations: [
    {
      registrations: [{ id: 'reg-123', material: 'paper', ... }],
      users: {
        alice: { roles: ['standardUser'] },
        manager: { roles: ['standardUser', 'orgAdmin'] }
      }
    },
    {
      registrations: [{ id: 'reg-456', material: 'plastic', ... }],
      users: {
        bob: { roles: ['standardUser'] }
      }
    }
  ]
})

const [orgA, orgB] = orgs

// Alice accessing her org - works
await server.inject({
  method: 'GET',
  url: `/v1/organisations/${orgA.id}/registrations/reg-123/summary-logs/123`,
  ...asUser('alice')
})

// Alice accessing Bob's org - 403 Forbidden
const response = await server.inject({
  method: 'GET',
  url: `/v1/organisations/${orgB.id}/registrations/reg-456/summary-logs/456`,
  ...asUser('alice')
})
expect(response.statusCode).toBe(403)
```

The factory:

1. Creates organisations with their registrations
2. Configures the in-memory auth context adapter with user→org linkages
3. Returns `asUser(name)` helpers that inject credentials for the named user

**Benefits of Tier 2:**

- **Tests declare intent**: "Given these orgs with these users" reads naturally
- **No token constants**: Tests don't need to know about `COMPANY_1_ID` etc.
- **Cross-org testing**: Easy to test that users can't access other orgs' data
- **Separation of concerns**: Authentication (who is this?) vs Authorisation (can they access this?)
- **Leverages Hapi**: Uses `onPostAuth` extension point and auth injection properly

## Consequences

### Positive

- Unit tests become dramatically simpler with Tier 1 auth injection helpers
- Integration tests become more readable and maintainable with Tier 2
- Authorisation logic is testable independently of JWT validation
- New tests can be written with minimal boilerplate
- The adapter pattern allows future flexibility (e.g. caching, different auth backends)
- Clear separation between tests that need auth behaviour vs tests that don't

### Negative

- Tier 2 requires refactoring existing auth code to extract the org access check
- Existing tests may need updating to use the new patterns
- Additional abstraction layer to understand and maintain (Tier 2 only)

### Migration

The two tiers can be adopted independently:

**Tier 1 (auth injection helpers):**

1. Create `src/test/inject-auth.js` with role-based helpers
2. Update unit tests to use `asStandardUser()` etc. instead of token ceremony
3. Can be done immediately with no production code changes

**Tier 2 (auth context adapter):**

1. Implement the auth context adapter port and adapters
2. Add the `onPostAuth` extension for org access checking
3. Create the test context factory
4. Update integration tests to use the new pattern
5. Eventually remove the org access check from JWT validate (once all tests migrated)
