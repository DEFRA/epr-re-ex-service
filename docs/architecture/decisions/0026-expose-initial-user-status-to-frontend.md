# 26. Expose Initial User Status to Frontend

Date: 2026-01-28

## Status

Accepted

## Context

PAE-974 requires tracking sign-ins by "non-initial users" - users who were invited to an organisation rather than being named in the original registration/accreditation application.

The `initial_user` role is stored in MongoDB as part of the organisation's `users` array:

```javascript
{
  users: [
    { email: 'user@example.com', roles: ['initial_user', 'standard_user'] }
  ]
}
```

This role is used server-side in the backend for authorization (e.g. only `initial_user` can link a Defra ID to an organisation), but is **not exposed to the frontend**.

The frontend currently has no way to know whether the signed-in user has `initial_user` status.

## Options

> **Note on backend options (1, 2, 3):** Any option that touches the backend is complicated by how users get populated in the `epr-organisation.users` array. This happens as a side-effect of the backend serving a response to any API call that performs "is this a Defra ID user?" authorisation. The `users` array may not exist or be fully populated at the time of the `/v1/me/organisations` call during sign-in.

### Option 1: Add field to `/v1/me/organisations` response

Extend the existing endpoint to include whether the current user has `initial_user` role on their linked organisation.

```javascript
{
  organisations: {
    linked: {
      id: '...',
      name: '...',
      isInitialUser: true  // new field
    }
  }
}
```

**Pros:**

- No additional roundtrip - data comes with existing call
- Single source of truth from backend

**Cons:**

- Requires backend change
- Adds coupling between metric requirement and API shape

### Option 2: New dedicated endpoint

Create a new endpoint e.g. `GET /v1/me/roles` that returns the user's roles across their organisations.

**Pros:**

- Clean separation of concerns
- Could be useful for other features

**Cons:**

- Additional roundtrip at sign-in time (albeit parallel call is possible)
- More infrastructure to maintain
- Continuing to overload the concept of `roles` between internal data (mongo items) and auth/JWT concepts

### Option 3: Emit metric from backend instead

Move the metric emission to the backend, where `initial_user` status is already known.

**Pros:**

- No need to expose role to frontend
- Backend has authoritative data

**Cons:**

- Sign-in flow is handled by frontend; backend would need a hook/event
- Changes where metrics are emitted (currently frontend handles sign-in metrics)

### Option 4: Use `linkedBy.id` as proxy

The `/v1/me/organisations` response already includes `linkedBy` - the user who linked the Defra ID to the organisation. The frontend can compare `linkedBy.id` with the signed-in user's ID to approximate "non-initial user".

```javascript
const isNonInitialUser =
  organisations.linked?.linkedBy?.id !== session.profile.id
if (isNonInitialUser) {
  await metrics.signInSuccessNonInitialUser()
}
```

**Pros:**

- No backend changes required
- Uses existing data from existing endpoint
- Already implemented (PR #396)

**Cons:**

- Not a precise match for `initial_user` role:
  - Multiple users can have `initial_user` (submitter, approved persons, signatories)
  - Only one user is recorded as `linkedBy`
  - A user with `initial_user` who isn't the linker would be counted as "non-initial"
- Measures "not the person who linked" rather than "not named in original application"

## Decision

Option 4: Use `linkedBy.id` as a proxy for initial user status.

While not a precise match for the `initial_user` role, this approach is pragmatic for the current requirement (a dashboard metric). The imprecision is acceptable because:

- The metric's purpose is to understand adoption patterns, not enforce access control
- The proxy captures the most common case (the person who linked is typically an initial user)
- No backend changes are required
- The implementation already exists (PR #396)

If precise `initial_user` status becomes necessary for other features (e.g. access control in the frontend), we can revisit Option 1 or Option 2.

## Consequences

- The `signInSuccessNonInitialUser` metric measures "user is not the person who linked the organisation" rather than "user does not have initial_user role"
- Some initial users (e.g. approved persons, signatories who didn't perform the linking) will be counted as non-initial users
- No backend API changes required
- Frontend implementation is simpler with no additional API calls
