import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb'
import { HapiInstrumentation } from '@opentelemetry/instrumentation-hapi'

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
