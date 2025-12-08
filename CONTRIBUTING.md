# Contributing

<!-- prettier-ignore-start -->
<!-- TOC -->
* [Contributing](#contributing)
  * [Prerequisites](#prerequisites)
  * [Getting Started](#getting-started)
    * [Docker Compose](#docker-compose)
      * [Selectively running services](#selectively-running-services)
    * [Secrets](#secrets)
    * [ADR tools](#adr-tools)
  * [Documentation](#documentation)
    * [Architecture Decision Records (ADRs)](#architecture-decision-records-adrs)
    * [Testing](#testing)
    * [Technical guides](#technical-guides)
    * [Wider engineering documentation](#wider-engineering-documentation)
  * [Repository](#repository)
    * [Pull Requests](#pull-requests)
    * [Dependabot](#dependabot)
    * [SonarCloud](#sonarcloud)
  * [Deployments](#deployments)
    * [Secrets and Environment Variables](#secrets-and-environment-variables)
<!-- TOC -->

<!-- prettier-ignore-end -->

## Prerequisites

1. [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. [NVM](https://github.com/creationix/nvm)

## Getting Started

### Docker Compose

A local environment with:

- Localstack for AWS services (S3, SQS)
- Redis
- MongoDB
- CDP Uploader
- Defra ID Stub
- Entra ID Stub // @todo
- epr-backend
- epr-frontend
- epr-re-ex-admin-frontend

Run all shared services - ideal if you run the apps in separate consoles

```bash
docker compose up
```

Run everything in Docker with build & watch mode

```bash
docker compose --profile all up --build --watch
```

See the running services with:

```bash
docker compose ps
```

> [!NOTE]
> Each service should run in watch mode, allowing you to develop locally without restarting the changed services.

#### Selectively running services

Should you wish to run your own services locally you can use profiles to achieve that,
e.g. to run docker compose for everything except `epr-frontend` you would use the multiple profiles:

```bash
docker compose --profile epr-admin-frontend --profile epr-backend up --build -d
```

You can also use the `COMPOSE_PROFILES` environment variable to define profiles

```bash
COMPOSE_PROFILES=epr-admin-frontend,epr-backend && docker compose up --build -d
```

Available profiles:

1. `all` runs all containers
2. `epr-backend` runs all shared containers plus `epr-backend`
3. `epr-frontend` runs all shared containers plus `epr-frontend`
4. `epr-admin-frontend` runs all shared containers plus `epr-admin-frontend`

> [!NOTE]
> You will need to use profiles when stopping/removing docker compose containers, [see docs](https://docs.docker.com/compose/how-tos/profiles/#stop-application-and-services-with-specific-profiles)
>
> `docker compose --profile all down`

### Secrets

Certain secrets are required to run this repository, to ensure these are safeguarded we use [Docker Compose Secrets](https://docs.docker.com/compose/how-tos/use-secrets/) during local development.

To configure these, please complete the following actions:

1. Obtain the necessary secret values from a team member
2. Create the following Env Var(s):
   - `export GOVUK_NOTIFY_API_KEY=AskTeamMemberForSecretValue`
   - `export ENTRA_CLIENT_SECRET=AskTeamMemberForSecretValue`
3. Optionally [persist these Env Vars in your CLI environment](https://unix.stackexchange.com/questions/117467/how-to-permanently-set-environmental-variables)

> [!NOTE]
> Running the backend requires `GOVUK_NOTIFY_API_KEY` environment variable.

> [!NOTE]
> Docker Compose secrets cannot be accidentally exposed via `process.env`

> [!IMPORTANT]
> Secrets also need to be managed on CDP, [see here for next steps](#secrets-and-environment-variables)

### ADR tools

To simplify the creation and management of ADRs, please [install ADR tools](https://github.com/npryce/adr-tools/blob/master/INSTALL.md)

## Documentation

Please see the [root `README.md`](./README.md).

### Architecture Decision Records (ADRs)

This project uses ADRs and `adr-tools`, to create new ADRs:

1. Ensure you have [installed adr-tools](#adr-tools)
2. From any directory in the repository: `adr new {name of ADR}`
3. Complete the Context, Decision & Consequence sections
4. Commit and push the code, the TOC file should be updated automatically

### Testing

You can find more information about [the project's approach to testing here](./docs/testing/index.md).

### Technical guides

You can find more information about [the project's technical guides here](./docs/testing/index.md).

### Wider engineering documentation

This `CONTRIBUTING.md` focuses on repository-specific guidance such as setup, development, and deployment.

For wider engineering documentation (including runbooks, hotfix process, non-technical resources, and dummy data assets), please see our Confluence space:

[Engineering Documentation Home](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/5895749782/Engineering)

## Repository

### Pull Requests

This repository and it's child repositories are configured to only allow updates via Pull Requests, please ensure that you follow the [pull request standards](https://defra.github.io/software-development-standards/processes/pull_requests).

### Dependabot

Dependabot is configured for this repository. You can [find the configuration here](.github/dependabot.yml).

### SonarCloud

SonarCloud is configured for this repository. You can [find the configuration here](./sonar-project.properties).

## Deployments

Deployments are managed by CDP, speak with the engineering team to be briefed on this.

Deployments are conducted automatically for lower environments and manually for prod.

### Secrets and Environment Variables

Both secrets and environment variables are managed by CDP, speak with the engineering team to be briefed on this.
