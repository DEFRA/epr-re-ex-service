# EPR Re/Ex Service

This repository combines the EPR Re/Ex microservices into a single location for the following purposes:

1. Documentation
2. Running a local development environment stack
3. Shared code and configuration

<!-- prettier-ignore-start -->
<!-- TOC -->
* [EPR Re/Ex Service](#epr-reex-service)
  * [Getting Started](#getting-started)
  * [Contributing](#contributing)
  * [Architecture](#architecture)
  * [Runbooks](#runbooks)
  * [Known issues](#known-issues)
  * [Workarounds](#workarounds)
  * [Licence](#licence)
    * [About the licence](#about-the-licence)
<!-- TOC -->

<!-- prettier-ignore-end -->

## Getting Started

Clone the repo and its submodules

```sh
git clone --recurse-submodules git@github.com:DEFRA/epr-re-ex-service.git
```

Or if you've already cloned and forgot the submodules, pull those down now

```sh
git submodule update --init --recursive
```

## Running

To run this service locally, follow [these instructions](./CONTRIBUTING.md#getting-started).

## Contributing

If you intend to contribute to this repository and/or run the application locally, please [see the contributing guidance](./CONTRIBUTING.md).

## Architecture

You can find more information about [the project's architecture here](./docs/architecture/index.md),
also see the [Architecture Decision Records](./docs/architecture/decisions/index.md).

## Runbooks

You can find [this service's runbooks here](https://eaflood.atlassian.net/wiki/spaces/MWR/pages/5873762458/Runbooks).

## Known issues

None

## Workarounds

None

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
