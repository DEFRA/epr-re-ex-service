# 24. Create PRN API strategy

Date: 2026-01-14

## Status

Accepted

## Context

We need to develop a journey for recyclers and exporters to create a Packaging Recycling Note (PRN) for a producer using one of their accreditations. The data attached to the PRN contains some initial context (issuer and accreditation details). Further data points (tonnage, recipient and notes) are added through a classic government multi-page form with a summary view before final submission. A few options have been proposed for how the data collection is orchestrated between frontend and backend API.

### Alternatives considered

#### 1. Utilise session storage (Redis)

A Redis layer and @hapi/yar are available, so the frontend could store the PRN data as part of a session.

##### Advantages

* keeps back end API very simple, single post endpoint for creation of a PRN

##### Disadvantages

* introduces extra complexity on the frontend for session storage and retrieval
* doesn't save a partial or draft PRN
* potential added complexity for clearing session values for users creating multiple PRNs during a single session

##### 2. Allow partial submissions on a single post endpoint

The epr-backend exposes a single POST endpoint for updating a draft PRN. Each epr-frontend page within the journey submits the data it collects (e.g. tonnage, recipient or notes) to the same endpoint. The backend treats all PRN properties as optional, allowing the PRN to be completed incrementally. A separate endpoint is used to submit the PRN, at which point completeness is validated before the PRN status is set to `AWAITING_ACCEPTANCE`

##### Advantages

* single endpoint is developed and maintained for draft PRN creation
* avoids coupling backend endpoints directly to individual UI pages
* allows draft PRN to be incrementally updated and revisited
* frontend state management is simple, just post a form
* API doesn't need to change if pages are reordered, merged, or split in the future
* new PRN data points can be added without creating new endpoints
* multiple clients (with differing UIs) can use the same endpoint

##### Disadvantages

* requires backend rules distinguishing draft validation from submission validation
* single endpoint handles multiple possible field combinations

#### 3. Expose multiple single-purpose endpoints per PRN update

The epr-backend exposes a set of POST endpoints, each responsible for updating a specific part of the PRN (e.g. tonnage, recipient, notes). Each page in the UI calls the corresponding endpoint for the data it collects. Validation and update logic for each data point is encapsulated within its dedicated endpoint.

##### Advantages

* frontend state management is simple, just post a form
* allows draft PRN to be incrementally updated and revisited
* each endpoint has a narrow well-defined responsibility
* validation logic is clearly scoped to a specific update
* avoids any ambiguity about which fields are expected in a given request
* endpoints can be reasoned about independently

##### Disadvantages

* introduces a large number of backend endpoints
* increased initial development and maintenance overhead, (additional schemas and testing)
* couples API closely to the current UI structure
* changes to the user journey may require API changes

## Decision

Borrowing a little bit from both options 2 and 3 we will:

Create a single POST endpoint `../packaging-recycling-notes` for initial PRN creation, accepts organisationId and accreditationId and builds the barebones of the PRN from those setting it with a status of 'DRAFT'. Returns the PRN ID.

Create a single PATCH endpoint `../packaging-recycling-notes/{id}` for updates of tonnage, recipient details and issuer notes. This could potentially still be expanded out to be 3 separate PATCH endpoints if it's felt that is needed.

Create a single POST endpoint `../packaging-recycling-notes/{id}/status` for updating the PRN status. Initially this will be for the transition from `DRAFT` to `AWAITING_AUTHORISATION` or `CANCELLED`, but can be extended to accomodate other statuses later. This endpoint will handle the business logic around when and by whom different statuses can be set, as well as handling side effects such as updating waste balances.

## Consequences

### Advantages

* avoids coupling backend endpoints directly to individual UI pages
* allows draft PRN to be incrementally updated and revisited
* frontend state management is simple, just post a form
* API doesn't need to change if pages are reordered, merged, or split in the future
* new PRN data points can be added without creating new endpoints
* multiple clients (with differing UIs) can use the same endpoint
* endpoints are limited in scope
* flexibility remains to adapt with further endpoints if needed

### Disadvantages

* requires backend rules distinguishing draft validation from submission validation
