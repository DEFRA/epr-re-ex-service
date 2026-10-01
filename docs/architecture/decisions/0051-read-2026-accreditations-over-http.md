# 51. Read 2026 accreditations over HTTP

Date: 2026-10-01

## Status

Accepted

Supersedes Part 2 of [ADR-0034](./0034-multi-year-accreditation-model.md).

## Context

[ADR-0034](./0034-multi-year-accreditation-model.md) Part 2 chose Option C: fetch 2027
accreditations on demand from the registration service, and keep reading 2026 accreditations
locally from the organisation documents. REEX would merge the two reads behind the
accreditations port.

On 21 September 2026 the REEX and registration service teams agreed that the registration
service owns accreditation data and REEX reads it when it needs it.

The [PAE-1965](https://eaflood.atlassian.net/browse/PAE-1965) proof of concept tested reading
2026 accreditations over HTTP on the perf-test and test environments, to see whether it works
and what it costs.

## Decision

2026 accreditations are also read over HTTP, not from the organisation documents. epr-backend
serves 2026 accreditations from an endpoint with the same contract the registration service will
serve for 2027. REEX then reads every year the same way, and the registration service can take
over 2026 later without changing REEX.

This changes the ADR-0034 adapter phases:

- **Phase 2 (Option C)** — reads every year over HTTP: 2026 from epr-backend, 2027 from the
  registration service.
- Phases 1 and 3 are unchanged.

## Consequences

### Early feedback

Reading 2026 the same way as 2027 means REEX has one read path instead of two,
and finds the problems with that path now, using live 2026 data, instead of when 2027 goes live.
The PAE-1965 proof of concept showed that this works and measured what it costs.

### Performance

The PAE-1965 proof of concept read 2026 accreditations over HTTP on the perf-test and test
environments. The results:

- **About +28ms for each organisation read.** Endpoints that don't read an organisation did not
  change, so the slowdown comes from the HTTP call.
- **No noticeable change for operators.** Operator pages, and most regulator pages, show one
  registration at a time.
- **Frontend pages are +100 to +250ms slower,** because each page reads the organisation
  several times.
- **Admin pages that list many organisations are two to five times slower:**

  | Page                                    | Before    | After |
  | --------------------------------------- | --------- | ----- |
  | Organisations list                      | 200–450ms | 1–2s  |
  | Summary log uploads                     | ~450ms    | ~2.5s |
  | PRN tonnage                             | 0.8–1.2s  | ~2.7s |
  | Overseas sites                          | ~1s       | ~2.5s |
  | Public register (download)              | 2.6s      | ~6s   |
  | Regulator: reprocessor/exporter figures | ~4s       | ~6.5s |

- **Slow reports barely change.** The 22–35s reports (credited tonnage, UK waste balance,
  market insights workbook) are slow for other reasons.
- **These numbers are the best case.** The proof of concept called epr-backend, the same
  service and database. Calls to the registration service go to another service and its own
  database, so they will be slower. Run the performance tests again against the registration
  service before 2027 goes live.

What this means:

- Admin pages that list many organisations need fewer, larger requests (a batch endpoint), and
  shouldn't fetch accreditations they don't use.
- Frontend pages need fewer organisation reads per request, or to cache accreditations for the
  length of a request.
- If latency is still too high after that, Phase 3 (a locally synced store) is the fallback.
  Because a synced copy can fall out of date, using it needs a new ADR.

### Other consequences

- **Some reads can't go through an HTTP lookup.** These need reworking before 2026 can be
  served entirely over HTTP:
  - searching by accreditation id or number
  - aggregations that join on accreditation fields
  - checks when an organisation is saved
- **Existing mechanisms for changing accreditation cannot be re-used for 2027.** Status change
  functionality and the JSON editor (in Admin UI) cannot be used as-is for editing 2027
  accreditation data (as the REEX service has a read-only view of it).
