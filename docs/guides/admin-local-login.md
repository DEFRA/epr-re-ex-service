# Admin Local Login Guide

Log in to the EPR admin frontend locally using the Entra ID stub.

## Prerequisites

Start the services:

```bash
npm run dev
```

Or equivalently:

```bash
GOVUK_NOTIFY_API_KEY=test-api-key-12345 docker compose --profile all up --watch
```

## Environment Configuration

To use the Entra stub locally, set the following environment variables:

```bash
export ENTRA_CLIENT_ID=clientId
export ENTRA_CLIENT_SECRET=test
export ENTRA_OIDC_WELL_KNOWN_CONFIGURATION_URL=http://localhost:3010/.well-known/openid-configuration
export ENTRA_TENANT_ID=tenantId
```

Alternatively, add these to a `.env` file and use `npm run dev:env`.

## Login Steps

1. Open http://localhost:3002
2. Click **Sign in** - redirects to Entra ID stub at http://localhost:3010

### Step 1: User Selection

The stub presents a list of pre-configured test users with default credentials.

### Step 2: Authentication

Select a user from the list and complete the authentication flow. The stub will redirect back to the admin frontend with the authentication tokens.

## Default Test Users

The Entra stub comes with the following pre-configured test user credentials:

| Username               | Password | Name             | Role          |
| ---------------------- | -------- | ---------------- | ------------- |
| `ea@test.gov.uk`       | `pass`   | EA Regulator     | EPR.Regulator |
| `nrw@test.gov.uk`      | `pass`   | NRW Regulator    | EPR.Regulator |
| `niea@test.gov.uk`     | `pass`   | NIEA Regulator   | EPR.Regulator |
| `customer@test.gov.uk` | `pass`   | Regular Customer | EPR.Customer  |

Use the regulator accounts (EA, NRW, NIEA) for admin functionality testing.

## Troubleshooting

### OIDC Configuration Not Found

Ensure the `ENTRA_OIDC_WELL_KNOWN_CONFIGURATION_URL` is set to `http://localhost:3010/.well-known/openid-configuration` and the entra-stub container is running:

```bash
docker compose ps | grep entra-stub
```

### Invalid Client ID or Secret

Verify the environment variables match the stub configuration:

- `ENTRA_CLIENT_ID=clientId`
- `ENTRA_CLIENT_SECRET=test`

### Stub Not Running

The entra-stub service starts automatically with Docker Compose. Check it's running on port 3010:

```bash
curl http://localhost:3010/.well-known/openid-configuration
```

### Using Real Azure AD Instead of Stub

If you need to test against real Azure AD, remove the environment variable overrides and configure a valid `ENTRA_CLIENT_SECRET` from Azure. The default configuration points to the actual Microsoft login endpoint.
