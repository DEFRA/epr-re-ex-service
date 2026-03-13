# Performance Tests

The `epr-backend-performance-tests` repository includes a JMeter script that can be executed against the `perf-test` environment.

Currently it tests against the form submissions, user linking, summary log uploads, waste balance calculation, and PRN creation.

There is a `DataGenerator` step on each run, but the result can be ignored as it is only used to generate data.

Generally speaking, we look for performance that is less than 5000ms on the 99th percentile (Worst case) and a throughput of approximately 50 transaactions per second is deemed acceptable as it is not a busy service.

There is also a profile set up for `epr-backend-performance-tests` to be used in the CDP Portal. You can pass in a `mid` profile for 100 threads, or `max` for 200 threads.

Similarly, there is the `epr-frontend-performance-tests` repository includes a JMeter script that can be executed against the `perf-test` environment. This exercises the performance test via the `epr-frontend` service but indirectly exercises the `epr-backend` as well as the frontend calls the backend endpoints.

Bear in mind that the performance environment is a shared environment, so you may or may not encounter some variance in performance.

The hardware configuration in the `perf-test` environment is similar to the `prod` environment.
