// Generates the KPI Metrics dashboard JSON.
//
// Usage:
//   node metrics/build-dashboard.mjs [out.json]
//
// Generated rather than hand written because every journey needs a near
// identical pair of queries, and the one thing that must not drift is the
// dimension values -- they have to match what the services emit, so they come
// from metrics/journeys.mjs, the same list the seeder uses.
//
// This builds one dashboard. Getting it onto a real one is metrics/promote.mjs,
// which knows nothing about the KPI row and works for any dashboard.
//
// Queries run in Metric Search mode rather than Metrics Insights SQL: the
// journey list is short and fixed, and the emulator this is built against
// implements neither Metrics Insights nor SEARCH expressions.

import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  JOURNEYS,
  TRANSACTION_END,
  TRANSACTION_START,
  namespaceFor
} from './journeys.mjs'

// Grafana's unbraced variable form. The braced ${...} form works identically but
// reads as an unterminated template literal to static analysis.
const DATASOURCE = { type: 'cloudwatch', uid: '$datasource' }

const FULL_WIDTH = 24
const ROW_HEIGHT = 1
const STAT_HEIGHT = 5
const TABLE_HEIGHT = 9

/**
 * Journey metrics carry one dimension by design, so a query naming it matches
 * exactly and needs nothing environment-specific. matchExact stays true: a
 * partial match would make Grafana build a CloudWatch SEARCH expression, which
 * is both looser than we want and unsupported by the local emulator.
 * @param {{ refId: string, metricName: string, service: string, journey: string, label: string }} query
 */
const metricQuery = ({ refId, metricName, service, journey, label }) => ({
  refId,
  datasource: DATASOURCE,
  namespace: namespaceFor(service),
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

const letter = (index) => String.fromCodePoint('A'.codePointAt(0) + index)

/** Started and completed for every journey, as one series each. */
const journeyQueries = JOURNEYS.flatMap(
  ({ service, title, start, end }, index) => [
    metricQuery({
      refId: letter(index * 2),
      metricName: TRANSACTION_START,
      service,
      journey: start,
      label: `${title} - started`
    }),
    metricQuery({
      refId: letter(index * 2 + 1),
      metricName: TRANSACTION_END,
      service,
      journey: end,
      label: `${title} - completed`
    })
  ]
)

/**
 * @param {{ id: number, title: string, description: string, metricName: string, phase: 'start' | 'end', x: number }} panel
 */
const totalPanel = ({ id, title, description, metricName, phase, x }) => ({
  id,
  type: 'stat',
  title,
  description,
  gridPos: { h: STAT_HEIGHT, w: FULL_WIDTH / 2, x, y: 1 },
  datasource: DATASOURCE,
  targets: JOURNEYS.map((journey, index) =>
    metricQuery({
      refId: letter(index),
      metricName,
      service: journey.service,
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
  id: 2,
  title: 'Journeys started',
  description:
    'Every journey start across all journeys. With journeys completed, feeds cost per transaction.',
  metricName: TRANSACTION_START,
  phase: 'start',
  x: 0
})

const completedPanel = totalPanel({
  id: 3,
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
  id: 4,
  type: 'table',
  title: 'Journeys',
  description:
    'Started and completed per journey. Not completed is started minus completed, so it also picks up journeys finished outside the selected period.',
  gridPos: { h: TABLE_HEIGHT, w: FULL_WIDTH, x: 0, y: 1 + STAT_HEIGHT },
  datasource: DATASOURCE,
  targets: journeyQueries,
  // Each query returns one series, so reduce gives a row per series named
  // "<journey> - <phase>". Splitting that back out lets the matrix pivot phases
  // into columns, which is what puts started and completed on the same row --
  // without which not-completed and completion rate cannot be expressed.
  //
  // The regex must be slash-delimited. Grafana silently falls back to its default
  // capture for a bare pattern, which yields the whole string in one field.
  transformations: [
    { id: 'reduce', options: { reducers: ['sum'], mode: 'seriesToRows' } },
    {
      id: 'extractFields',
      options: {
        source: 'Field',
        format: 'regexp',
        regExp: '/^(?<Journey>.*) - (?<Phase>.*)$/',
        keepTime: false,
        replace: false
      }
    },
    {
      id: 'groupingToMatrix',
      options: {
        columnField: 'Phase',
        rowField: 'Journey',
        valueField: 'Total',
        emptyValue: 'zero'
      }
    },
    {
      id: 'calculateField',
      options: {
        mode: 'binary',
        alias: 'Not completed',
        binary: { left: 'started', operator: '-', right: 'completed' },
        replaceFields: false
      }
    },
    {
      id: 'calculateField',
      options: {
        mode: 'binary',
        alias: 'Completion rate',
        binary: { left: 'completed', operator: '/', right: 'started' },
        replaceFields: false
      }
    },
    {
      id: 'organize',
      options: {
        renameByName: {
          'Journey\\Phase': 'Journey',
          started: 'Started',
          completed: 'Completed'
        }
      }
    }
  ],
  fieldConfig: {
    defaults: { unit: 'short', decimals: 0 },
    overrides: [
      {
        matcher: { id: 'byName', options: 'Completion rate' },
        properties: [
          { id: 'unit', value: 'percentunit' },
          { id: 'decimals', value: 1 }
        ]
      }
    ]
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
      id: 1,
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

const ROOT = resolve(import.meta.dirname, '..')

/** @param {string} path */
const within = (path) => {
  const resolved = resolve(ROOT, path)
  const inside = relative(ROOT, resolved)

  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`refusing to write outside the repository: ${path}`)
  }

  return resolved
}

const [, , requestedPath = 'metrics/kpi-dashboard.json'] = process.argv

// This used to take subcommands that now live in metrics/promote.mjs, and the
// old form would silently treat one as a filename -- writing a file called
// 'dev'. Muscle memory outlives a refactor, so say where they went.
if (!requestedPath.endsWith('.json')) {
  console.error(
    `'${requestedPath}' is not a .json path. This builds the KPI dashboard only; status, merge and check are now node metrics/promote.mjs`
  )
  process.exit(1)
}

const outputPath = within(requestedPath)

await writeFile(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`)

console.log(
  `wrote ${relative(ROOT, outputPath)}: ${JOURNEYS.length} journeys, ${journeyQueries.length} queries`
)
