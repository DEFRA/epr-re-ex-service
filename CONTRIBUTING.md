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
docker compose up --profile all --build --watch
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
docker compose up --profile shared --profile epr-admin-frontend --profile epr-backend --build -d
```

You can also use the `COMPOSE_PROFILES` environment variable to define profiles 

```bash
COMPOSE_PROFILES=shared,epr-admin-frontend,epr-backend && docker compose up --build -d
```

Available profiles: 

1. `all` runs all containers
2. `shared` runs all shared containers
3. `epr-backend` runs all shared containers plus `epr-backend` 
4. `epr-frontend` runs all shared containers plus `epr-frontend`
5. `epr-admin-frontend` runs all shared containers plus `epr-admin-frontend`

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

