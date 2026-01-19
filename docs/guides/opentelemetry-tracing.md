# OpenTelemetry Tracing for Local Development

This guide explains how to enable distributed tracing for local development using OpenTelemetry and Jaeger.

## Overview

OpenTelemetry instrumentation provides visibility into:

- HTTP request/response timing
- MongoDB query execution times
- Service-to-service communication

This is useful for:

- Debugging performance issues
- Understanding request flow through the system
- Identifying bottlenecks

## Prerequisites

Install the OTel dependencies:

```bash
cd otel && npm install
```

## Usage

Start the stack with OTel tracing enabled:

```bash
docker compose -f compose.yml -f compose.otel.yml --profile epr-backend --profile epr-frontend up -d
```

Access the Jaeger UI at: http://localhost:16686

## What Gets Traced

- **HTTP requests** - All incoming/outgoing HTTP calls with timing
- **MongoDB operations** - find, insert, update, aggregate with collection names and query timing
- **TCP/TLS connections** - Connection establishment timing

## Limitations

When using OTel:

- **Hot-reload is disabled** - nodemon is bypassed so OTel instrumentation loads before the app

## Disabling OTel

To run without tracing (normal development with hot-reload):

```bash
docker compose --profile epr-backend --profile epr-frontend up -d
```

## Troubleshooting

### No traces appearing in Jaeger

1. Check OTel dependencies are installed: `ls otel/node_modules`
2. Verify containers have OTel env vars: `docker inspect <container> --format='{{range .Config.Env}}{{println .}}{{end}}' | grep OTEL`
3. Check container logs for OTel errors: `docker compose logs epr-backend`

### Container fails to start

If you see `Cannot find module '@opentelemetry/sdk-node'`:

```bash
cd otel && npm install
docker compose -f compose.yml -f compose.otel.yml --profile epr-backend up -d --build
```
