# 26. Expose Initial User Status to Frontend

Date: 2026-01-28

## Status

Proposed

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

- Additional roundtrip at sign-in time
- More infrastructure to maintain

### Option 3: Emit metric from backend instead

Move the metric emission to the backend, where `initial_user` status is already known.

**Pros:**

- No need to expose role to frontend
- Backend has authoritative data

**Cons:**

- Sign-in flow is handled by frontend; backend would need a hook/event
- Changes where metrics are emitted (currently frontend handles sign-in metrics)

## Decision

TBD

## Consequences

TBD
