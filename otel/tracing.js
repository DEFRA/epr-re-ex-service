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
      // Disable MongoDB instrumentation - known issue with cursor operations in MongoDB 7+
      // See: https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1936
      '@opentelemetry/instrumentation-mongodb': { enabled: false }
    })
  ]
})

sdk.start()
