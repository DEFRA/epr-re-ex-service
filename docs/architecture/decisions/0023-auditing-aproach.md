# 23. Auditing aproach

Date: 2025-12-03

## Status

Proposal

## Context

The PEPR service must capture auditing data so that Defra have a record of how users have interacted with the service. This is an enabler for activities such as disaster recovery and identification of fraudulent usage. There is a CDP helper library that presents a simple interface for capturing auditing data (behind the scenes the library and platform take care of storing the captured data) - this ADR appraises the options for interacting with the auditing helper from within the application code.

### Option 1 - audit by endpoint access

The `handler` code for each endpoint is wrapped (eg. using a Hapi plugin) such that audit information is captured at the end of serving each request (for each component in the service). The data included in the audit payload would include
- request information (http verb, url, query, payload, response code, etc)
- user details (identifier such as email address, roles, etc) derived from
  - the supplied `Bearer` token for requests to `epr-backend`
  - session data for requests to `epr-frontend` and `epr-re-ex-admin-frontend`

Additional considerations
- the approach allows one implementation to cover both unauthorised access (`handler` code serving endpoint not invoked) and authorised access (handler code serving endpoint is invoked)
- data that is only available within the `handler`code, but would be useful to audit (eg the state of a resource before/after modification) would not be in scope to the auditing code
  - a mechanism (eg Hapi request decorator) would need implementing for capturing (request scoped) data from the `handler` code so that it is available to the auditing code
- the approach has limitations for requests that invoke asynchronous behaviour and send a HTTP response _before_ the asynchronous action completes

### Option 2 - add inline auditing statements at required points in code

Any code that performs an action that merits auditing is modified to include `audit` statements. This couples auditing to the domain code, and thus is easy reason about/modify on a case-by-case basis. The tradeoff is that auditing code is decentralised and


## Decision

TBC - asking the team

## Consequences (option 1)

- auditing is consistently applied across `frontend` and `backend` components
- there is no additional effort to add auditing when implementing new features
- no additional effort to retrospectively adding auditing to existing feaures
- comprehension of the auditing data is coupled to the HTTP API
  - user intent must be inferred from the URL of the request
  - what action the service took is inferred from the HTTP response code
- auditing of activity that takes place outside of the request scope (e.g. startup actions, responding to SQS messages) is not catered for

## Consequences (option 2)

- potential for divergeance of auditing implementation across frontend (what pages did a user access) and backend (what action did the user take, and what did the service do) components
- addition of auditing must form part of acceptance criteria for all new features, and development effort expended to implement it
- existing feaures need re-visiting and auditing retrospectively added as appropriate
- auditing code co-located with business logic code (high cohesion) - articulate user intent and action taken by service can be clearly articulated within the audit payload
- auditing can be added to startup routines, message handling code, etc
