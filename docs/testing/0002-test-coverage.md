# Test Coverage

## Where a test goes

A journey test drives a real user's journey through the UI, with the frontend, admin frontend and backend running together. Keep the suite small. A new feature extends an existing journey rather than adding a new spec.

A journey test calls an API directly only where a third-party service calls ours as part of the journey. The frontend and admin frontend are not third parties, so a journey reaches `epr-backend` through their pages.

Test an API's behaviour, response shape and error messages in `epr-backend`, not in the journey tests.

Along the way, a journey can also check:

1. Mongo - the data the journey left in the Mongo service.
2. Logs - what `epr-backend` wrote to its Docker logs.

The tests are written with `Playwright Test` and an `Allure` report is generated at the end of the journey.

## Smoke tests

On each deployment to a lower environment such as Test, the journey tests are run against the lower environment. Only end to end tests (Both Frontend and Backend) are run this time round. We do not run Mongo checks (As we do not have easy access to it in environments) nor the logging tests (As they are checked against Docker, not possible on environments).

The benefit of running these tests on lower environments is that we get to test email notifications (Which we do not get locally) and Slack non-prod alert notifications.

On top of that, we also ensure that connectivity to other services (Such as S3, Mongo, Cognito auth) is working as expected.

We also get the Allure reporting on the [CDP Portal](https://portal.cdp-int.defra.cloud/test-suites/epr-re-ex-journey-tests) after each test run.
