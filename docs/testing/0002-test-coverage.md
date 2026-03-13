# Test Coverage

The journey tests encompasses the following:

1. Endpoint tests - These are the tests that are run against the actual endpoints of the running application.
2. Mongo checks - Hitting the Mongo service and performing checks against the data.
3. Logging tests - Checking the `epr-backend` Docker logs and asserting against the logs.

The tests are written in `Cucumber-JS` and an `Allure` report is generated at the end of the journey.

## Smoke tests

On each deployment to a lower environment such as Test, the journey tests are run against the lower environment. Only end to end tests (Both Frontend and Backend) are run this time round. We do not run Mongo checks (As we do not have easy access to it in environments) nor the logging tests (As they are checked against Docker, not possible on environments).

The benefit of running these tests on lower environments is that we get to test email notifications (Which we do not get locally) and Slack non-prod alert notifications.

On top of that, we also ensure that connectivity to other services (Such as S3, Mongo, Cognito auth) is working as expected.

We also get the Allure reporting on the [CDP Portal](https://portal.cdp-int.defra.cloud/test-suites/epr-backend-journey-tests) after each test run.
