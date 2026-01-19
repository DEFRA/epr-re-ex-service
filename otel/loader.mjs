/**
 * OpenTelemetry ESM Bootstrap Loader
 *
 * Registers the ESM loader hook then initialises the OpenTelemetry SDK.
 * The loader hook enables proper instrumentation of ESM modules like Hapi,
 * giving us route-level spans instead of just generic HTTP spans.
 *
 * Usage: NODE_OPTIONS="--import /opt/otel/loader.mjs"
 *
 * IMPORTANT: pino-pretty's worker thread transport conflicts with the ESM
 * loader hook. Set LOG_FORMAT=ecs in compose.otel.yml to use ECS logging
 * instead, which bypasses pino-pretty entirely.
 */

import { register } from 'node:module'

// Register the OpenTelemetry ESM loader hook for module instrumentation
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)

// Import and configure the SDK after the loader is registered
const { NodeSDK } = await import('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = await import(
  '@opentelemetry/exporter-trace-otlp-proto'
)
const { HttpInstrumentation } = await import(
  '@opentelemetry/instrumentation-http'
)
const { MongoDBInstrumentation } = await import(
  '@opentelemetry/instrumentation-mongodb'
)
const { HapiInstrumentation } = await import(
  '@opentelemetry/instrumentation-hapi'
)

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'epr-backend',
  traceExporter: new OTLPTraceExporter({
    url:
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318') +
      '/v1/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new MongoDBInstrumentation({
      // Enable traces even outside HTTP context (e.g. startup operations)
      // See: https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1910
      requireParentSpan: false
    }),
    new HapiInstrumentation()
  ]
})

sdk.start()
