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

Introduce an **Auth Context Adapter** using the ports and adapters pattern to decouple org access checking from JWT validation.

### 1. Auth Context Port

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

### 2. Production Adapter

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

### 3. In-Memory Adapter (for tests)

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

### 4. Org Access Check Extension

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

### 5. Test Context Factory

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

## Consequences

### Positive

- Integration tests become more readable and maintainable
- Authorisation logic is testable independently of JWT validation
- New tests can be written with minimal boilerplate
- The adapter pattern allows future flexibility (e.g. caching, different auth backends)

### Negative

- Requires refactoring existing auth code to extract the org access check
- Existing tests may need updating to use the new pattern
- Additional abstraction layer to understand and maintain

### Migration

Existing tests can continue to work during migration. The new pattern can be adopted incrementally:

1. Implement the auth context adapter and `onPostAuth` extension
2. Create the test context factory
3. Update integration tests to use the new pattern
4. Eventually remove the org access check from JWT validate (once all tests migrated)
