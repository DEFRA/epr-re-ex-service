# Performance Tests

The `epr-re-ex-performance-tests` repository holds a single JMeter script, `scenarios/epr-re-ex-test.jmx`, that runs against the `perf-test` environment. It replaces the separate `epr-backend-performance-tests`, `epr-frontend-performance-tests` and `epr-re-ex-admin-fe-perf-tests` repositories.

Three thread groups:

- **Setup** — fetches a Cognito access token for the backend API calls.
- **Frontend journey** — the operator journey through `epr-frontend`, with the backend API calls (form submissions, user linking, summary log uploads, waste balance calculation and PRN creation) inline.
- **Admin frontend journey** — the regulator journey through `epr-re-ex-admin-frontend`, against an organisation it first creates through the backend API.

Both journeys share one thread count, set by the CDP Portal profile — `mid` for 100 threads, `max` for 200, defaulting to 50.

Each run starts with a `DataGenerator` step; its result only seeds data and can be ignored.

Results are assessed against the NFR thresholds in [section 9.3 of the Solution Architecture Definition](https://github.com/DEFRA/epr-re-ex-docs/blob/main/technology/quality-assurance-view/solution-architecture-definition/solution-architecture-definition-sections/9-technology-architecture.md#93-performance-and-scaling). The script itself asserts only on response codes, so timing is judged from the JMeter report rather than by the run passing or failing.

`perf-test` hardware is comparable to `prod`, but the environment is shared, so expect some variance.
