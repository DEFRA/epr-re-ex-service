# 34. Read organisation data with Basic Auth

Date: 2026-05-22

## Status

Accepted

## Context

The registration team is building out a new application that provides functionality to allow Reprocessors/Exporters to re-apply for accreditation in 2027. To do this they need the data for organisations already enrolled in the RREPW service.

Initially the requirement is for visibility of data only - designing a mechanism to synchronise data across the two applications (where one/both could potentially be updating the data) is _out of scope_ .

The registration service will be hosted on CDP (including backend components within the protected zone).

There are existing endpoints on the `epr-backend` API that expose organisation data

- `GET /v1/organisations` - lists data (paginated) for all organisations
- `GET /v1/organisations/{organisationId}` - returns data for a single organisation

## Decision

Basic auth will be added to the existing `GET /v1/organisations` endpoint, and credentials shared with the registration team.

Basic auth will _not_ be added to the `GET /v1/organisations/{organisationId}` endpoint as

- this returns a subset of data that can already be accessed over the list endpoint
- granting access to a minimum number of endpoints aligns with the Principle of Least Exposure

## Consequences

- Minimally invasive, and quick to add mechanism for surfacing data to new application (meets immediate need of surfacing data)
- Secured by virtue of the two applications being hosted within the CDP protected zone
- Risk of leaking data to _other_ clients in the CDP protexted zone if Basic Auth credentials are leaked
- Additional auth code to understand/maintain in the `epr-backend` application code
