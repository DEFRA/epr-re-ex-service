# Where a Test Goes

A journey test drives a real user's journey through the UI, with the frontend, admin frontend and backend running together. Keep the suite small. A new feature extends an existing journey rather than adding a new spec.

A journey test calls an API directly only where a third-party service calls ours as part of the journey. For example, a Defra form submits an application to `/v1/apply/organisation`. The frontend and admin frontend are not third parties, so a journey reaches `epr-backend` through their pages.

Test an API's behaviour, response shape and error messages in `epr-backend`, not in the journey tests. A test of one page on its own, such as its content, its validation messages or a standalone accessibility scan, goes in `epr-frontend` or `epr-re-ex-admin-frontend`, whichever serves the page.

The tests are written with `Playwright Test` and an `Allure` report is generated at the end of the journey.

## Smoke tests

On each deployment to a lower environment such as Test, the journey tests tagged `@smoketest` are run against that environment.

The benefit of running these tests on lower environments is that we get to test email notifications (Which we do not get locally) and Slack non-prod alert notifications.

On top of that, we also ensure that connectivity to other services (Such as S3, Mongo, Cognito auth) is working as expected.

We also get the Allure reporting on the [CDP Portal](https://portal.cdp-int.defra.cloud/test-suites/epr-re-ex-journey-tests) after each test run.
