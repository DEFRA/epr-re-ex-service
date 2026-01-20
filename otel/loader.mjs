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
const { getNodeAutoInstrumentations } = await import(
  '@opentelemetry/auto-instrumentations-node'
)

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'epr-backend',
  traceExporter: new OTLPTraceExporter({
    url:
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318') +
      '/v1/traces'
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Enable MongoDB traces even outside HTTP context (e.g. startup operations)
      '@opentelemetry/instrumentation-mongodb': { requireParentSpan: false },
      // Disable fs instrumentation - too noisy, not useful for perf analysis
      '@opentelemetry/instrumentation-fs': { enabled: false }
    })
  ]
})

sdk.start()
