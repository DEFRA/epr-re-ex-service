// Generates the KPI Metrics dashboard JSON.
//
// Generated rather than hand written because every journey needs a near
// identical pair of queries, and the one thing that must not drift is the
// dimension values -- they have to match what the frontend emits, so they come
// from the same list the seeder uses.
//
// The output is what gets pasted into a CDP playground dashboard and promoted.
// It queries in Metric Search mode rather than using Metrics Insights SQL: the
// journey list is short and fixed, and the local emulator this is built against
// does not implement Metrics Insights.

import { writeFile } from 'node:fs/promises'

import {
  JOURNEYS,
  NAMESPACE,
  TRANSACTION_END,
  TRANSACTION_START
} from './journeys.mjs'

const DATASOURCE = { type: 'cloudwatch', uid: '${datasource}' }

const FULL_WIDTH = 24
const ROW_HEIGHT = 1
const STAT_HEIGHT = 5
const TABLE_HEIGHT = 9

/**
 * Journey metrics carry one dimension by design, so a query naming it matches
 * exactly and needs nothing environment-specific. matchExact stays true: a
 * partial match would make Grafana build a CloudWatch SEARCH expression, which
 * is both looser than we want and unsupported by the local emulator.
 * @param {{ refId: string, metricName: string, journey: string, label: string }} query
 */
const metricQuery = ({ refId, metricName, journey, label }) => ({
  refId,
  datasource: DATASOURCE,
  namespace: NAMESPACE,
  metricName,
  dimensions: { journey: [journey] },
  statistic: 'Sum',
  matchExact: true,
  metricQueryType: 0,
  metricEditorMode: 0,
  queryMode: 'Metrics',
  region: 'default',
  period: '',
  id: '',
  label
})

const letter = (index) => String.fromCharCode('A'.charCodeAt(0) + index)

/** Started and completed for every journey, as one series each. */
const journeyQueries = JOURNEYS.flatMap(({ title, start, end }, index) => [
  metricQuery({
    refId: letter(index * 2),
    metricName: TRANSACTION_START,
    journey: start,
    label: `${title} - started`
  }),
  metricQuery({
    refId: letter(index * 2 + 1),
    metricName: TRANSACTION_END,
    journey: end,
    label: `${title} - completed`
  })
])

/**
 * @param {{ title: string, description: string, metricName: string, phase: 'start' | 'end', x: number }} panel
 */
const totalPanel = ({ title, description, metricName, phase, x }) => ({
  type: 'stat',
  title,
  description,
  gridPos: { h: STAT_HEIGHT, w: FULL_WIDTH / 2, x, y: 1 },
  datasource: DATASOURCE,
  targets: JOURNEYS.map((journey, index) =>
    metricQuery({
      refId: letter(index),
      metricName,
      journey: journey[phase],
      label: journey.title
    })
  ),
  // Collapse the five journeys to one row each so the panel's own reducer adds
  // them into a single figure rather than showing five.
  transformations: [
    { id: 'reduce', options: { reducers: ['sum'], mode: 'seriesToRows' } }
  ],
  options: {
    reduceOptions: { calcs: ['sum'], fields: '', values: false },
    colorMode: 'value',
    graphMode: 'none',
    textMode: 'auto',
    justifyMode: 'auto'
  },
  fieldConfig: {
    defaults: {
      unit: 'short',
      decimals: 0,
      color: { mode: 'fixed', fixedColor: 'text' }
    },
    overrides: []
  }
})

const startedPanel = totalPanel({
  title: 'Journeys started',
  description:
    'Every journey start across all journeys. With journeys completed, feeds cost per transaction.',
  metricName: TRANSACTION_START,
  phase: 'start',
  x: 0
})

const completedPanel = totalPanel({
  title: 'Journeys completed',
  description: 'Every journey completion across all journeys.',
  metricName: TRANSACTION_END,
  phase: 'end',
  x: FULL_WIDTH / 2
})

/**
 * One row per journey, started and completed side by side, with the two derived
 * figures the KPI actually reports. Not completed is start minus end rather than
 * a metric of its own: an abandoned journey emits nothing, so it can only ever
 * be inferred.
 */
const journeysPanel = {
  type: 'table',
  title: 'Journeys',
  description:
    'Started and completed per journey. Not completed is started minus completed, so it also picks up journeys finished outside the selected period.',
  gridPos: { h: TABLE_HEIGHT, w: FULL_WIDTH, x: 0, y: 1 + STAT_HEIGHT },
  datasource: DATASOURCE,
  targets: journeyQueries,
  transformations: [
    { id: 'reduce', options: { reducers: ['sum'], mode: 'seriesToRows' } },
    {
      id: 'organize',
      options: { renameByName: { Field: 'Journey', Total: 'Count' } }
    }
  ],
  fieldConfig: {
    defaults: { unit: 'short', decimals: 0 },
    overrides: []
  },
  options: { showHeader: true, cellHeight: 'sm' }
}

const dashboard = {
  title: 'epr-frontend (KPI metrics)',
  uid: 'epr-frontend-kpi-metrics',
  tags: ['custom', 'epr-frontend', 'kpi'],
  timezone: 'browser',
  time: { from: 'now-30d', to: 'now' },
  refresh: '',
  schemaVersion: 39,
  templating: {
    list: [
      {
        name: 'datasource',
        type: 'datasource',
        query: 'cloudwatch',
        current: {},
        hide: 0
      }
    ]
  },
  panels: [
    {
      type: 'row',
      title: 'KPI Metrics',
      gridPos: { h: ROW_HEIGHT, w: FULL_WIDTH, x: 0, y: 0 },
      collapsed: false,
      panels: []
    },
    startedPanel,
    completedPanel,
    journeysPanel
  ]
}

const [, , outputPath = 'metrics/kpi-dashboard.json'] = process.argv

await writeFile(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`)

console.log(
  `wrote ${outputPath}: ${JOURNEYS.length} journeys, ${journeyQueries.length} queries`
)
