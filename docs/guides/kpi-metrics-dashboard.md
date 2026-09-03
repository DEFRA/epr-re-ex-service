# KPI Metrics Dashboard

This guide explains how to build and promote Grafana dashboards for the custom
metrics the services emit, using a local stand-in for CloudWatch.

## Overview

Tenant dashboards on CDP are built in a playground folder and then promoted, and
a promoted dashboard cannot be edited in place. Without somewhere local to work,
every panel tweak costs a deploy and a promotion.

The `compose.metrics.yml` overlay provides that. floci speaks the CloudWatch API,
so panels built against it use the same queries as the deployed dashboard and
their JSON transfers unchanged.

## Prerequisites

A running stack. The overlay joins it to reach floci.

## Running

```bash
npm run dev:metrics
```

Grafana is then at http://localhost:3300 — anonymous, no login. The KPI dashboard
is provisioned from `metrics/kpi-dashboard.json`, so regenerating that file is
enough to see the change; there is no import step.

Seed some representative metrics so panels are laid out against realistic
numbers rather than empty frames:

```bash
npm run metrics:seed
```

Walking journeys by hand also works, and is the real test — but not for every
iteration of a panel.

Seeding repeatedly accumulates, so figures inflate across runs while the ratios
stay right. To start from nothing:

```bash
npm run metrics:reset
```

The emulator keeps its state in memory, so restarting it clears every metric.
`floci-init` restarts alongside to put the buckets and queues back, which the
uploader needs — without it, uploads break until the stack is restarted.

Run it against the stack you want to reset, with the same project name that stack
was started with. It restarts the containers rather than recreating them, so the
network and published port they already hold are kept; recreating them without the
port and network variables the stack was started with would silently rebuild floci
on the default network and port, detaching it from everything else. The guard
refuses rather than resetting the wrong stack.

## How the metrics get there

`aws-embedded-metrics` never calls `PutMetricData`. It writes an EMF document to
the CloudWatch agent, which forwards it to CloudWatch Logs, and the Logs service
extracts the metrics. floci implements the CloudWatch APIs but not that
extraction, so `metrics/emf-pump.mjs` stands in for both: it listens on the agent
port and publishes what it receives.

The overlay points all three services at it, and sets `AWS_EMF_NAMESPACE` so the
documents land in the namespace the deployed environments use.

## Building a dashboard

`metrics/build-dashboard.mjs` generates the JSON. It is generated rather than
hand written because each journey needs a near identical pair of queries, and the
dimension values must match what the services emit — so they come from
`metrics/journeys.mjs`, the same list the seeder uses.

`SERVICES` there registers each service that emits custom metrics and the
CloudWatch namespace it publishes under, and every journey names its service. A
row can therefore draw from more than one, which is how the dashboard this joins
is already organised: by concern rather than by service. `Operator Activity`, for
instance, mixes `epr-frontend` and `epr-backend` panels.

```bash
npm run metrics:dashboard                          # standalone, for local work
node metrics/build-dashboard.mjs dev out.json      # dev's dashboard plus our row
node metrics/build-dashboard.mjs check out.json    # has the target moved since?
```

### Two constraints worth knowing

floci implements `GetMetricData` for explicit queries only. It supports neither
Metrics Insights SQL nor CloudWatch SEARCH expressions, and returns an empty
series rather than an error for both. In practice that means **pin an exact
dimension set and leave `matchExact` on** — a partial match makes Grafana build a
SEARCH expression, which silently yields nothing.

This is why journey metrics carry a single `journey` dimension rather than the
`LogGroup`, `ServiceName` and `ServiceType` the library adds by default. One
dimension is exactly matchable, and carries nothing environment-specific, so the
same JSON works locally, on dev and in production.

### Keeping the values honest

`metrics/journeys.mjs` names the dimension values the dashboard queries, and they
have to match what the frontend emits. Rename one there and the dashboard asks
for a metric nobody publishes any more — which Grafana renders as zero rather
than as an error, so nothing looks broken.

`metrics/journeys.test.mjs` checks the two lists against each other, reading each
service that declares its journey names in code through `lib/`. It skips when that is not present, so it protects local
work rather than CI. Values the dashboard charts ahead of the instrumentation
land in `AWAITING_INSTRUMENTATION`, and the test also fails if one is still
listed after the service starts emitting it, so the list cannot rot. The same
test holds the registry's namespaces in step with the ones the overlay sets,
since those have to be stated as literals in YAML.

### Transformations

Build transformation chains in Grafana's own UI and port the result into the
generator, rather than writing the JSON by hand. Grafana fails by rendering
nothing rather than erroring, so a wrong option name looks identical to missing
data. The UI shows the effect of each step immediately.

Provisioned dashboards allow UI edits here for that reason. The generator still
owns the file, so port changes back into it — anything saved only in the UI is
lost the next time the file is regenerated.

## Promoting

CDP promotes whole dashboards, so the artefact is the target dashboard with the
new row already in it.

1. Generate against the environment whose playground you will paste into:
   `node metrics/build-dashboard.mjs dev merged.json`. This fetches the target
   live and writes a stamp of the version it merged from.
2. In Grafana for that environment, open `Playground/<service>-monitoring`, then
   New → New dashboard → Settings → JSON Model, and paste.
3. Save, then find the version under Settings → Versions.
4. Re-check before promoting: `node metrics/build-dashboard.mjs check merged.json`.
   If the target moved since you generated, promoting yours would revert that
   change, and nothing else in the flow would say so.
5. Promote from the portal: services → the service → Diagnostics → Dev.

Promoting from dev applies the change to **every** environment at once.

## Before you promote

```bash
node metrics/build-dashboard.mjs status
```

Answers two questions the portal does not, and exits non-zero if either needs
attention.

**Is anything staged in the playground?** The folder is shared per service and
holds one working copy per dashboard. Dashboards are promoted one at a time, so
another dashboard's staged work will not go out with yours — but a staged copy of
_the dashboard you are about to edit_ is someone's unfinished work that you would
save over. Only that case is treated as blocking. Unlike the promoted copies,
playground dashboards carry a real author rather than the platform's, so the
report names who to ask.

**Do the environments agree?** Since a promotion fans out to all of them,
environments that disagree mean a promotion in flight, one that failed part way,
or an environment edited directly. The comparison ignores datasource uids, which
are rewritten per environment and would otherwise differ every time.

### What you cannot see

Every environment reports the dashboard's author as `admin`, because promotion
runs as the platform. Grafana's version history needs a login. So the version and
its timestamp are all the attribution available — enough to tell that something
moved, not who moved it. Say so in the team channel before editing the playground.
