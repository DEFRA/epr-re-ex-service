# EPR Frontend Page Navigation

> [!NOTE]
> This document provides a comprehensive overview of the EPR Frontend application's page structure and navigation flows.

<!-- prettier-ignore-start -->
<!-- TOC -->
* [EPR Frontend Page Navigation](#epr-frontend-page-navigation)
  * [Overview](#overview)
  * [All Routes](#all-routes)
  * [Navigation Flow Diagram](#navigation-flow-diagram)
  * [Key Conditional Logic](#key-conditional-logic)
    * [Authentication & Organisation Linking](#authentication--organisation-linking)
    * [Summary Log Processing States](#summary-log-processing-states)
  * [Authentication Requirements](#authentication-requirements)
  * [Session & State Management](#session--state-management)
<!-- TOC -->
<!-- prettier-ignore-end -->

## Overview

The EPR Frontend is a Hapi.js application that provides the user interface for the Extended Producer Responsibility (EPR) service. Users authenticate via Defra ID (OIDC) and can then manage their organisations, view accreditations, and upload summary logs.

## All Routes

| Path | Method | Purpose | Auth Required |
|------|--------|---------|---------------|
| `/health` | GET | Health check endpoint | No |
| `/` | GET | Home/landing page | No |
| `/login` | GET | Initiates OIDC login flow | No |
| `/auth/callback` | GET | OIDC callback handler | No |
| `/auth/organisation` | GET | Fallback safeguard | No |
| `/logout` | GET | Clears session & redirects to Defra ID logout | Yes |
| `/account` | GET | User account/organisations page | Yes |
| `/account/linking` | GET | Account linking form | Yes |
| `/account/linking` | POST | Process organisation linking | Yes |
| `/email-not-recognised` | GET | Email not recognised page | Yes |
| `/organisations/{id}` | GET | Organisation dashboard (reprocessing tab) | Yes |
| `/organisations/{id}/exporting` | GET | Organisation dashboard (exporting tab) | Yes |
| `/organisations/{organisationId}/accreditations/{accreditationId}` | GET | Accreditation detail dashboard | Yes |
| `/organisations/{organisationId}/registrations/{registrationId}` | GET | Registration detail page | Yes |
| `/organisations/{organisationId}/registrations/{registrationId}/summary-logs/upload` | GET | Summary log upload page | Yes |
| `/organisations/{organisationId}/registrations/{registrationId}/summary-logs/{summaryLogId}` | GET | Summary log progress tracker | Yes |
| `/organisations/{organisationId}/registrations/{registrationId}/summary-logs/{summaryLogId}/submit` | POST | Submit summary log | Yes |
| `/contact` | GET | Contact page | No |
| `/cookies` | GET | Cookie policy page | No |

## Navigation Flow Diagram

```mermaid
flowchart TD
    subgraph Static["Static Pages"]
        HOME["Home Page"]
        CONTACT["Contact Page"]
        COOKIES["Cookie Policy"]
        HEALTH["Health Check"]
    end

    subgraph Auth["Authentication Flow"]
        LOGIN["Login"]
        CALLBACK["Auth Callback"]
        LOGOUT["Logout"]
        DEFRA_ID["Defra ID"]
    end

    subgraph Linking["Organisation Linking"]
        ACCOUNT["Account Home"]
        LINKING["Link Organisation"]
        EMAIL_NOT_RECOG["Email Not Recognised"]
    end

    subgraph OrgDashboard["Organisation Dashboard"]
        ORG_DASH["Reprocessing Tab"]
        ORG_EXPORT["Exporting Tab"]
    end

    subgraph AccreditationFlow["Accreditation & Upload"]
        ACCRED["Accreditation Detail"]
        REG["Registration Detail"]
        UPLOAD["Upload Summary Log"]
        PROGRESS["Progress Tracker"]
        SUBMIT["Submit"]
    end

    HOME -->|Sign In| LOGIN
    LOGIN -->|Redirect| DEFRA_ID
    DEFRA_ID -->|Auth success| CALLBACK

    CALLBACK -->|Has linked orgs| ACCOUNT
    CALLBACK -->|No linked orgs| LINKING

    LINKING -->|Select and submit| ACCOUNT
    LINKING -->|No unlinked orgs| EMAIL_NOT_RECOG
    EMAIL_NOT_RECOG -->|Contact support| CONTACT

    ACCOUNT -->|Select organisation| ORG_DASH
    ORG_DASH <-->|Tab switch| ORG_EXPORT

    ORG_DASH -->|Select accreditation| ACCRED
    ORG_EXPORT -->|Select accreditation| ACCRED
    ACCRED -->|Back| ORG_DASH
    ACCRED -->|View registration| REG
    ACCRED -->|Upload summary log| UPLOAD

    UPLOAD -->|File uploaded| PROGRESS

    PROGRESS -->|Processing| PROGRESS
    PROGRESS -->|Validated| SUBMIT
    SUBMIT -->|POST| PROGRESS
    PROGRESS -->|Invalid| UPLOAD
    PROGRESS -->|Submitted| ACCRED

    ACCOUNT -->|Sign Out| LOGOUT
    ORG_DASH -->|Sign Out| LOGOUT
    LOGOUT -->|Clear session| DEFRA_ID
    DEFRA_ID -->|Post-logout| HOME

    classDef static fill:#51cf66,stroke:#2e7d32,color:#000,stroke-width:2px
    classDef auth fill:#74c0fc,stroke:#1565c0,color:#000,stroke-width:2px
    classDef linking fill:#ffd43b,stroke:#ef6c00,color:#000,stroke-width:2px
    classDef dashboard fill:#b197fc,stroke:#7b1fa2,color:#000,stroke-width:2px
    classDef upload fill:#FF8870,stroke:#5E342B,color:#000,stroke-width:2px
    classDef external fill:#dee2e6,stroke:#546e7a,color:#000,stroke-width:2px,stroke-dasharray: 5 5

    class HOME,CONTACT,COOKIES,HEALTH static
    class LOGIN,CALLBACK,LOGOUT auth
    class ACCOUNT,LINKING,EMAIL_NOT_RECOG linking
    class ORG_DASH,ORG_EXPORT dashboard
    class ACCRED,REG,UPLOAD,PROGRESS,SUBMIT upload
    class DEFRA_ID external
```

## Key Conditional Logic

### Authentication & Organisation Linking

**After OIDC Callback (`/auth/callback`):**

1. Session is created and stored in cache
2. User organisations are fetched from the backend API
3. If the user has **no linked organisations** → redirect to `/account/linking`
4. If the user has **linked organisations** → continue to referrer or `/`

**On `/account/linking` (GET):**

1. Fetch user organisations (prerequisite)
2. Check if `organisations.unlinked.length > 0`
3. If **no unlinked organisations** → redirect to `/email-not-recognised`
4. If **unlinked organisations exist** → show form with radio buttons

**On `/account/linking` (POST):**

1. Validate `organisationId` in payload
2. If validation fails → re-render form with error
3. If validation passes → call `linkOrganisation()` API → redirect to `/account`

### Summary Log Processing States

The summary log upload workflow uses asynchronous processing with status polling:

| State | UI Behaviour |
|-------|-------------|
| `preprocessing` | Shows "Processing..." with polling |
| `validating` | Shows "Processing..." with polling |
| `validated` | Shows check page with row counts, user can submit |
| `submitting` | Shows "Submitting..." with polling |
| `submitted` | Shows success page |
| `invalid` | Shows validation errors, re-upload link |
| `rejected` | Shows validation errors, re-upload link |
| `validationFailed` | Shows validation errors, re-upload link |
| `superseded` | Shows message that a newer upload exists |

## Authentication Requirements

**Protected routes** (require authenticated session):

- `/account`
- `/account/linking`
- `/email-not-recognised`
- `/organisations/**`
- All summary log routes

**Public routes:**

- `/` (home)
- `/health`
- `/login`
- `/auth/callback`
- `/contact`
- `/cookies`

Unauthenticated users attempting to access protected routes are redirected to `/login`.

## Session & State Management

- **Session storage**: Redis cache (configured in `server.app.cache`)
- **Session identifier**: UUID stored in cookie (`sessionId`)
- **Flash messages**: Used for storing referrer URL during login flow
- **Yar sessions**: Used for storing `summaryLogs` data (uploadId, freshData)
