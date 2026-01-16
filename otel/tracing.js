'use strict'

const { NodeSDK } = require('@opentelemetry/sdk-node')
const {
  getNodeAutoInstrumentations
} = require('@opentelemetry/auto-instrumentations-node')
const {
  OTLPTraceExporter
} = require('@opentelemetry/exporter-trace-otlp-proto')

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'epr-backend',
  traceExporter: new OTLPTraceExporter({
    url:
      (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318') +
      '/v1/traces'
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // MongoDB instrumentation breaks cursor operations regardless of MongoDB version
      // The instrumentation loses async context during cursor creation, causing:
      // "Unexpected null cursor id. A cursor creating command should have set this"
      // This is a fundamental OTel/driver compatibility issue, not version-specific
      // See: https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1936
      '@opentelemetry/instrumentation-mongodb': { enabled: false },
      // Disable fs instrumentation - too noisy, not useful for perf analysis
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Disable DNS instrumentation - creates noise for every connection
      '@opentelemetry/instrumentation-dns': { enabled: false }
    })
  ]
})

sdk.start()
