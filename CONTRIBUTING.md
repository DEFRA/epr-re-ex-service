# Contributing

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

```bash
docker compose up --profile all --build --watch -d
```

See the running services with:

```bash
docker compose ps
```

> [!NOTE]
> Each service should run in watch mode, allowing you to develop locally without restarting the changed services.

### Secrets

Certain secrets are required to run this repository, to ensure these are safeguarded we use [Docker Compose Secrets](https://docs.docker.com/compose/how-tos/use-secrets/) during local development.

To configure these, please complete the following actions:

1. Obtain the necessary secret values from a team member
2. Create the following Env Var(s):
    - `export GOVUK_NOTIFY_API_KEY=AskTeamMemberForSecretValue`
    - `export ENTRA_CLIENT_SECRET=AskTeamMemberForSecretValue`
3. Optionally [persist these Env Vars in your CLI environment](https://unix.stackexchange.com/questions/117467/how-to-permanently-set-environmental-variables)

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

