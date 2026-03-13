# Local Login Guide

Login to the EPR frontend locally using the Defra ID stub.

## Quick Start (Automated)

After starting the services and waiting for the backend to seed:

```bash
npm install      # if you haven't already
npm run seed:stub
```

Then visit http://localhost:3000 - click "Start now" and select the pre-registered user.

This script automatically:

1. Queries MongoDB for the seeded organisation's DefraId UUID
2. Registers `tester@example.com` in the Defra ID stub with that organisation

## Prerequisites

Start the services:

```bash
npm run dev
```

Or equivalently:

```bash
GOVUK_NOTIFY_API_KEY=test-api-key-12345 docker compose --profile all up --watch
```

## Manual Login Steps

If you need to register a different user or can't use the automated script:

1. Open http://localhost:3000
2. Click **Start now** - redirects to Defra ID stub at http://localhost:3200

### Step 1: User Setup

The stub presents a user registration form.

**Auto-generated fields (leave as-is):**

- User ID (B2C object ID)
- Contact ID
- Unique reference

**Fill in these fields:**

| Field              | Value                |
| ------------------ | -------------------- |
| Email address      | `tester@example.com` |
| First name         | `Test`               |
| Last name          | `User`               |
| Level of assurance | `LOA1` (default)     |
| MFA Performed      | `No` (default)       |
| Enrolments         | `1`                  |
| Enrolment Requests | `0`                  |

Click **Continue**.

### Step 2: New User Relationships

On the relationships screen, enter the organisation details:

| Field             | Value                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Relationship ID   | Any value (e.g. `1234`)                                           |
| Organisation ID   | The `linkedDefraOrganisation.orgId` UUID from MongoDB (see below) |
| Organisation Name | Any value (e.g. `Test Organisation`)                              |
| Relationship role | `Employee`                                                        |

Click **Add relationship** to complete the login.

## Finding the Organisation ID in MongoDB

The Organisation ID must match the `linkedDefraOrganisation.orgId` field stored in MongoDB. This is a UUID generated when the database is seeded.

Connect to MongoDB and run:

```bash
docker exec -it epr-re-ex-service-mongodb-1 mongosh
```

Then query for the organisation:

```javascript
use epr-backend
db["epr-organisations"].findOne(
  { orgId: 50030 },
  { "linkedDefraOrganisation.orgId": 1, "companyDetails.name": 1 }
)
```

Example output:

```javascript
{
  _id: ObjectId('...'),
  companyDetails: { name: 'Test Reprocessor Ltd' },
  linkedDefraOrganisation: { orgId: 'd24d7e8e-312a-46c1-b18b-a75b4e58eb36' }
}
```

Copy the `linkedDefraOrganisation.orgId` UUID and use it in the Defra ID stub form.

## Linked Test Users

| Email                | orgId | Organisation Type                              |
| -------------------- | ----- | ---------------------------------------------- |
| `tester@example.com` | 50030 | Active organisation with approved registration |

## Switching Organisations

Visit http://localhost:3000/auth/organisation to force organisation reselection.

## Troubleshooting

### Defra ID Stub - Login link not appearing

After adding a relationship, you should see a "Registered users" screen with a **Log in** link next to your email. If the Log in link doesn't render, navigate back to http://localhost:3000 and click Sign in again - the stub will remember your registered user.

Also consider running the DefraId stub container locally, instead of the latest published image. Example:

```yaml
# ...
defra-id-stub:
  # image: defradigital/cdp-defra-id-stub:${DEFRA_ID_STUB_VERSION:-latest}
  build:
    context: ./cdp-defra-id-stub
    dockerfile: Dockerfile
# ...
```
