/**
 * OpenTelemetry ESM Bootstrap Loader
 *
 * This file registers the ESM loader hook with exclusions for pino modules,
 * then initialises the OpenTelemetry SDK. The loader hook enables proper
 * instrumentation of ESM modules like Hapi.
 *
 * Usage: NODE_OPTIONS="--import /opt/otel/loader.mjs"
 *
 * Why exclusions? The pino-pretty transport uses worker threads, and the
 * ESM loader hook interferes with how pino resolves transport targets.
 * By excluding pino modules, we avoid the conflict while still getting
 * Hapi route-level spans.
 */

import { register } from 'node:module'
import { createAddHookMessageChannel } from 'import-in-the-middle'

// Register the ESM loader hook with exclusions for pino (which breaks with the loader)
const { registerOptions, waitForAllMessagesAcknowledged } =
  createAddHookMessageChannel()

register('import-in-the-middle/hook.mjs', import.meta.url, {
  ...registerOptions,
  data: {
    ...registerOptions.data,
    exclude: ['pino', 'pino-pretty', 'hapi-pino']
  }
})

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

// Wait for the loader hook to be fully initialised before the app starts
await waitForAllMessagesAcknowledged()
