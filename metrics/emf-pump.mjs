// Stands in for the CloudWatch agent plus the metric extraction that CloudWatch
// Logs does in AWS, so custom metrics show up in the local emulator and can be
// charted in the local Grafana.
//
// With AWS_EMF_ENVIRONMENT=Agent the app writes newline-delimited EMF documents
// to AWS_EMF_AGENT_ENDPOINT over a plain TCP socket. That is the same path the
// deployed service uses, so nothing about the app is special-cased for local.
//
// The emulator does not verify signatures, so this posts the query-string form
// of PutMetricData directly and needs no AWS SDK -- worth it to keep the
// container dependency free and instant to start.

import { createInterface } from 'node:readline'
import { createServer } from 'node:net'

import { groupByNamespace, parseEmf, toPutMetricDataForm } from './emf.mjs'

/**
 * @import { Metric } from './emf.mjs'
 */

// The port aws-embedded-metrics writes to when it has no AWS_EMF_AGENT_ENDPOINT.
const DEFAULT_AGENT_PORT = 25888

const PORT = Number(process.env.EMF_PUMP_PORT ?? DEFAULT_AGENT_PORT)

// Required rather than defaulted: where the emulator lives is the compose file's
// business, and hardcoding it here would put a plaintext URL in the source.
const ENDPOINT = process.env.AWS_ENDPOINT_URL

if (!ENDPOINT) {
  console.error('AWS_ENDPOINT_URL is required')
  process.exit(1)
}

/** @param {Metric[]} metrics */
const publish = async (metrics) => {
  for (const [namespace, entries] of groupByNamespace(metrics)) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toPutMetricDataForm(namespace, entries)
    })

    if (!response.ok) {
      console.error(`put failed ${response.status}: ${await response.text()}`)
      return
    }

    entries.forEach(({ name, dimensions }) => {
      const dims = dimensions.map((d) => `${d.name}=${d.value}`).join(' ')

      console.log(`-> ${namespace} ${name} ${dims}`)
    })
  }
}

const server = createServer((socket) => {
  socket.on('error', (err) => console.error(`socket error: ${err.message}`))

  createInterface({ input: socket }).on('line', (line) => {
    const metrics = parseEmf(line)

    if (metrics.length) {
      publish(metrics).catch((err) =>
        console.error(`publish failed: ${err.message}`)
      )
    }
  })
})

server.listen(PORT, () =>
  console.log(`listening for EMF on ${PORT}, publishing to ${ENDPOINT}`)
)
