# Performance Tests

The `epr-re-ex-performance-tests` repository holds a single JMeter script, `scenarios/epr-re-ex-test.jmx`, that runs against the `perf-test` environment. It replaces the separate `epr-backend-performance-tests`, `epr-frontend-performance-tests` and `epr-re-ex-admin-fe-perf-tests` repositories.

Three thread groups:

- **Frontend journey** — the operator journey through `epr-frontend`.
- **Admin frontend journey** — the regulator journey through `epr-re-ex-admin-frontend`.
- **Backend API** — form submissions, user linking, summary log uploads, waste balance calculation and PRN creation, authenticated via Cognito.

The frontend journeys are the emphasis and share a thread count; the backend API runs at a fifth of it, since its flows largely overlap with theirs. The CDP Portal profile sets that count — `mid` for 100 threads, `max` for 200, defaulting to 50.

Each run starts with a `DataGenerator` step; its result only seeds data and can be ignored.

We look for under 5000ms on the 99th percentile and a throughput of around 50 transactions per second, which is acceptable for a service this quiet.

`perf-test` hardware is comparable to `prod`, but the environment is shared, so expect some variance.
