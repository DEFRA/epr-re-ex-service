# Testing Authenticated Endpoints

This guide covers two approaches for testing endpoints that require authentication and authorisation, depending on what you need to verify.

## The Problem

Testing authenticated endpoints currently requires 15-20 lines of boilerplate per test file:

1. Mock OIDC servers via `setupAuthContext()`
2. Create an organisation linked to hardcoded Defra ID token constants (`COMPANY_1_ID`, etc.)
3. Use `buildActiveOrg()` to create the org with correct `linkedDefraOrganisation` structure
4. Pass the `organisationsRepository` to the test server
5. Use Bearer token headers with the mock token

This ceremony obscures the business logic being tested and couples tests tightly to token constants.

Additionally, the current design couples authentication (validating tokens) with authorisation (checking org access) inside the JWT validate function:

```
JWT validate() → getDefraUserRoles() → getOrgMatchingUsersToken() → getRolesForOrganisationAccess()
                                              ↓
                                    request.organisationsRepository
```

This means:

- Tests must use real (mock) tokens to exercise authorisation
- Hapi's `server.inject({ auth })` bypasses the org check entirely
- No clean way to test cross-org access control

## Choosing Your Approach

| Scenario                                         | Use                                |
| ------------------------------------------------ | ---------------------------------- |
| Testing business logic, not auth behaviour       | Tier 1: Auth Injection Helpers     |
| Testing that users can only access their own org | Tier 2: Auth Context Adapter       |
| Testing role-based access within an org          | Tier 1 with different role helpers |
| Testing cross-org access control                 | Tier 2                             |

## Tier 1: Auth Injection Helpers

For unit tests that focus on business logic rather than auth behaviour, Hapi's built-in `server.inject({ auth })` option allows credentials to be injected directly, bypassing JWT validation entirely.

### Setup

Create helper functions in `src/test/inject-auth.js`:

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

### Usage

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

### Benefits

- Reduces boilerplate from 15-20 lines to a single spread operator
- No need for `buildActiveOrg()`, `organisationsRepository` setup, or token constants
- Tests can use any organisation ID without matching token claims
- Clear, readable test code focused on business logic

### Limitations

- Bypasses org access checks entirely (user could access any org)
- Not suitable for testing authorisation scenarios
- `setupAuthContext()` still required for server startup

## Tier 2: Auth Context Adapter

For integration tests that need to verify users can only access their own organisations, the Auth Context Adapter uses the ports and adapters pattern to decouple org access checking from JWT validation.

### Auth Context Port

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

### Production Adapter

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

### In-Memory Adapter (for tests)

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

### Org Access Check Extension

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

### Test Context Factory

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

### Benefits

- **Tests declare intent**: "Given these orgs with these users" reads naturally
- **No token constants**: Tests don't need to know about `COMPANY_1_ID` etc.
- **Cross-org testing**: Easy to test that users can't access other orgs' data
- **Separation of concerns**: Authentication (who is this?) vs Authorisation (can they access this?)
- **Leverages Hapi**: Uses `onPostAuth` extension point and auth injection properly

## Migration Guide

The two tiers can be adopted independently.

### Adopting Tier 1

1. Create `src/test/inject-auth.js` with role-based helpers
2. Update unit tests to use `asStandardUser()` etc. instead of token ceremony
3. Can be done immediately with no production code changes

### Adopting Tier 2

1. Implement the auth context adapter port and adapters
2. Add the `onPostAuth` extension for org access checking
3. Create the test context factory
4. Update integration tests to use the new pattern
5. Eventually remove the org access check from JWT validate (once all tests migrated)

> **Note**: Tier 2 requires refactoring existing auth code to extract the org access check. Existing tests may need updating to use the new patterns.
