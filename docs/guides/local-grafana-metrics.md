# Local Grafana and CloudWatch Metrics

This guide explains how backend and frontend metrics reach a local Grafana dashboard, and where that setup diverges from the deployed CDP environments.

## Overview

In CDP environments, the `amazon-cloudwatch-agent` sidecar reads EMF-formatted log lines emitted by `aws-embedded-metrics` and calls the real CloudWatch API. Locally there is no AWS account and no sidecar, so this repo instead:

1. Sets `AWS_EMF_ENVIRONMENT: Local` on `epr-backend` and `epr-frontend`, which makes `aws-embedded-metrics` write EMF JSON to stdout instead of sending it anywhere.
2. Runs an `emf-collector` service (`compose/emf-collector`) that tails both containers' stdout via the Docker API, parses the EMF JSON, and calls `PutMetricData` directly against `floci` (this repo's CloudWatch/S3/SQS emulator).
3. Runs a `grafana` service provisioned with a CloudWatch datasource pointed at `floci`, and the `epr-backend (epr-re-ex-service)` dashboard.

Access Grafana at http://localhost:3400 (anonymous admin).

## The dashboard file is a point-in-time copy

`compose/grafana/provisioning/dashboards/json/epr-re-ex-service.json` is an export of the real dev-environment dashboard, taken on a specific date. It is not generated or kept in sync automatically — if the dev dashboard changes, this file goes stale until someone re-exports it.

Grafana loads this file via its file provisioner, with `allowUiUpdates: true` set on the provider (`compose/grafana/provisioning/dashboards/dashboards.yml`). This means UI edits and saves work, but they persist to Grafana's own database, not back to this JSON file — they won't show up in git, and they can be overwritten if this file is edited and the provisioner re-syncs that dashboard version. To make a change permanent, edit the JSON file directly (or export the dashboard from the UI — Dashboard settings → JSON Model → copy — and paste that into the file), then restart the `grafana` container (or wait for the next 30-second provisioning poll).

Pasting a fresh export from dev straight into the JSON Model editor and saving fails with "Dashboard not found". The dev export carries dev Grafana's numeric `id` (e.g. `3879`), which doesn't exist locally — Grafana looks up that `id` first and fails before it gets to the matching `uid`. Set `"id": null` in the pasted JSON before saving; `uid` alone is enough for Grafana to match it onto the existing local dashboard.

## What doesn't work against floci

floci is a S3/SQS/CloudWatch emulator, not real AWS. Two gaps affect this dashboard specifically:

| Gap | Symptom | Confirmed by |
|---|---|---|
| No CloudWatch Metrics Insights SQL support (`queryLanguage: CWLI` in SQL/`GROUP BY` mode) | Panel shows "No data", no error | `GetMetricData` with a `SELECT ... GROUP BY` expression against floci returns `MetricDataResults: []`; floci's own docs describe `GetMetricData` only as "query metrics with math expressions", with no SELECT/WHERE/GROUP BY support |
| No partial-dimension matching on `GetMetricData`/`GetMetricStatistics` | Plain (non-SQL) query with only some of a metric's dimensions also returns no data | Querying `prn.created` with 3 of its 6 stored dimensions returns no datapoints; querying with all 6 (including the `LogGroup`/`ServiceName`/`ServiceType` dimensions `aws-embedded-metrics` adds by default) returns the real value |

Panels affected on this dashboard: **PRN Status Transitions**, **Status Transitions**, **December PRN's created - by processor type** (all three use SQL/`GROUP BY` queries). Every other panel — the User journey KPI gauges, sign-in/out totals, Waste Records, etc. — uses plain dimension-based queries and works against floci once the metric exists.

To find the exact dimension set floci needs for a metric, query it directly rather than guessing:

```bash
docker run --rm --network cdp-tenant -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=eu-west-2 amazon/aws-cli:2.36.39 \
  --endpoint-url http://floci:4566 cloudwatch list-metrics --namespace epr-backend --metric-name prn.created
```

The `Dimensions` array in that response is the exact, complete set a plain `GetMetricData`/`GetMetricStatistics` query needs to return anything.

## OpenSearch logs are not integrated

Seven panels — **Defra Forms submissions**, **Defra Forms submissions totals**, **Sign in/out traffic** (all three copies), **Organisation update**, **Organisation update totals** — use the `grafana-opensearch-datasource` datasource, not CloudWatch. That datasource is not provisioned locally at all, so these panels show a datasource error rather than "No data".

This is not a quick add. The queries (e.g. `container_name: "epr-backend_ssl" AND uri: "/v1/apply/organisation" AND method: POST AND status:200`) read CDP's nginx/ingress access-log fields, which are a different shape from the ECS-format request logs the apps themselves emit locally (`http.request.method`, `url.path`, etc., not `container_name`/`uri`/`method`/`status`). Making these panels work locally would need: an OpenSearch container, a log shipper reindexing either the local `proxy` service's or the apps' own logs into that specific field schema, and a provisioned OpenSearch datasource — new local infrastructure, not configuration.

## Querying a metric manually

To check a metric exists in floci without going through Grafana:

```bash
docker run --rm --network cdp-tenant -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=eu-west-2 amazon/aws-cli:2.36.39 \
  --endpoint-url http://floci:4566 cloudwatch list-metrics --namespace epr-backend --metric-name prn.created
```
