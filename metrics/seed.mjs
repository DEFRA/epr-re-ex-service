// Publishes representative journey events so the KPI dashboard has something to
// chart while it is being built. Walking every journey by hand for every panel
// tweak is not practical, and panels laid out against empty data read fine and
// then fall apart once numbers arrive.
//
// Values are arbitrary but shaped like reality: fewer completions than starts,
// and completion rates that differ per journey so a broken query is obvious.

import { groupByNamespace, toPutMetricDataForm } from './emf.mjs'
import {
  JOURNEYS,
  TRANSACTION_END,
  TRANSACTION_START,
  namespaceFor
} from './journeys.mjs'

/**
 * @import { Metric } from './emf.mjs'
 */

const ENDPOINT = process.env.AWS_ENDPOINT_URL

if (!ENDPOINT) {
  console.error('AWS_ENDPOINT_URL is required')
  process.exit(1)
}

const HOURS = 12
const MS_PER_HOUR = 60 * 60 * 1000

// Deliberately uneven, so a panel wired to the wrong series is obvious.
const VOLUMES = [
  { started: 48, completed: 39 },
  { started: 41, completed: 33 },
  { started: 26, completed: 18 },
  { started: 19, completed: 15 },
  { started: 34, completed: 31 }
]

/**
 * @param {string} metricName
 * @param {string} service
 * @param {string} journey
 * @param {number} hoursAgo
 * @returns {Metric}
 */
const datapoint = (metricName, service, journey, hoursAgo) => ({
  namespace: namespaceFor(service),
  name: metricName,
  unit: 'Count',
  value: 1,
  timestamp: new Date(Date.now() - hoursAgo * MS_PER_HOUR).toISOString(),
  dimensions: [{ name: 'journey', value: journey }]
})

/**
 * Spread a total across the window so the time series has a shape rather than a
 * single spike, without pretending to model real traffic.
 * @param {string} metricName
 * @param {string} service
 * @param {string} journey
 * @param {number} total
 * @returns {Metric[]}
 */
const spread = (metricName, service, journey, total) =>
  Array.from({ length: total }, (_, i) =>
    datapoint(metricName, service, journey, (i % HOURS) + 1)
  )

const metrics = JOURNEYS.flatMap(({ service, start, end }, index) => [
  ...spread(TRANSACTION_START, service, start, VOLUMES[index].started),
  ...spread(TRANSACTION_END, service, end, VOLUMES[index].completed)
])

// CloudWatch caps PutMetricData at 1000 data points per call; stay well under.
// Grouped by namespace because a call carries one, and journeys may belong to
// different services.
const BATCH = 100

for (const [namespace, entries] of groupByNamespace(metrics)) {
  for (let i = 0; i < entries.length; i += BATCH) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toPutMetricDataForm(namespace, entries.slice(i, i + BATCH))
    })

    if (!response.ok) {
      console.error(`seed failed ${response.status}: ${await response.text()}`)
      process.exit(1)
    }
  }
}

console.log(
  `seeded ${metrics.length} data points across ${JOURNEYS.length} journeys`
)
