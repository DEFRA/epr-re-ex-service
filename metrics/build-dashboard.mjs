// Generates the KPI Metrics dashboard JSON.
//
// Usage:
//   node metrics/build-dashboard.mjs                 # standalone, for the local rig
//   node metrics/build-dashboard.mjs dev out.json    # dev's dashboard plus our row
//   node metrics/build-dashboard.mjs check out.json  # has the target moved since?
//   node metrics/build-dashboard.mjs status           # anything unpromoted or out of step?
//
// Generated rather than hand written because every journey needs a near
// identical pair of queries, and the one thing that must not drift is the
// dimension values -- they have to match what the frontend emits, so they come
// from the same list the seeder uses.
//
// The standalone form is what gets built and verified against the local metrics
// overlay. The merged form is what gets pasted into a CDP playground dashboard
// and promoted: CDP promotes whole dashboards, and a promoted one cannot be
// edited in place, so the artefact has to be the target dashboard with our row
// already in it. Merge against the environment whose playground you will paste
// into -- see dashboard.mjs.
//
// Queries run in Metric Search mode rather than Metrics Insights SQL: the
// journey list is short and fixed, and the emulator the standalone form is built
// against implements neither Metrics Insights nor SEARCH expressions.

import { readFile, writeFile } from 'node:fs/promises'

import {
  describeDrift,
  describeStagedWork,
  fingerprint,
  mergeIntoTarget,
  summariseEnvironments,
  targetStamp
} from './dashboard.mjs'
import {
  JOURNEYS,
  TRANSACTION_END,
  TRANSACTION_START,
  namespaceFor
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

const letter = (index) => String.fromCharCode('A'.charCodeAt(0) + index)

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

// The dashboard our row belongs to, per the decision on PAE-1781 to put the KPI
// figures on the service's existing operational dashboard rather than a new one.
const TARGET_UID = 'epr-backend-epr-re-ex-service-bd579e7f'

const targetUrl = (environment) =>
  `https://metrics.${environment}.cdp-int.defra.cloud/api/dashboards/uid/${TARGET_UID}`

/**
 * Read the target from the environment the playground copy will be made in.
 * Exporting a different one silently reverts whatever it has that the other does
 * not -- dev currently carries a Regulator activity row that prod does not.
 * @param {string} environment
 */
const fetchTarget = async (environment) => {
  const response = await fetch(targetUrl(environment))

  if (!response.ok) {
    throw new Error(
      `could not read the ${environment} dashboard (${response.status}) -- on the VPN?`
    )
  }

  return /** @type {{ meta: Record<string, any>, dashboard: Record<string, any> }} */ (
    await response.json()
  )
}

const stampPath = (outputPath) =>
  `${outputPath.replace(/\.json$/, '')}.target.json`

/**
 * Promotion takes whatever is in the playground and applies it to every
 * environment, so a target that has moved since the merge was built is a silent
 * revert waiting to happen -- and nothing in Grafana or the portal will say so.
 * @param {string} outputPath
 */
const check = async (outputPath) => {
  const before = JSON.parse(await readFile(stampPath(outputPath), 'utf8'))
  const drift = describeDrift(
    before,
    targetStamp(before.environment, await fetchTarget(before.environment))
  )

  if (drift) {
    console.error(drift)
    process.exit(1)
  }

  console.log(
    `${before.environment} is still at version ${before.version} -- safe to paste`
  )
}

const ENVIRONMENTS = ['dev', 'test', 'prod']

const PLAYGROUND_FOLDER = 'epr-backend-monitoring'

/**
 * Two questions worth asking before promoting, neither of which the portal
 * answers: is anything staged in the playground that would go out with yours,
 * and do the environments agree.
 */
const status = async () => {
  const targets = await Promise.all(
    ENVIRONMENTS.map(async (environment) => ({
      environment,
      ...(await fetchTarget(environment))
    }))
  )

  const snapshots = targets.map(({ environment, meta, dashboard }) => ({
    environment,
    version: meta.version,
    updated: meta.updated,
    fingerprint: fingerprint(dashboard)
  }))

  snapshots.forEach(({ environment, version, updated }) =>
    console.log(`  ${environment}: version ${version}, updated ${updated}`)
  )

  const { inSync, differences } = summariseEnvironments(snapshots)

  if (inSync) {
    console.log('\nenvironments agree')
  }

  differences.forEach((difference) => console.error(`\n${difference}`))

  const staged = describeStagedWork(
    await fetchPlayground('dev'),
    targets[0].dashboard.title
  )

  if (staged) {
    console[staged.blocking ? 'error' : 'log'](`\n${staged.message}`)
  }

  if (!inSync || staged?.blocking) {
    process.exit(1)
  }
}

/**
 * Anything sitting in the service's playground folder, which promotion would
 * carry out alongside our own change.
 * @param {string} environment
 */
const fetchPlayground = async (environment) => {
  const base = `https://metrics.${environment}.cdp-int.defra.cloud/api`

  /**
   * @param {string} path
   * @returns {Promise<any>}
   */
  const read = (path) =>
    fetch(`${base}${path}`).then((response) => response.json())

  const folders = await read('/folders?limit=1000')
  const playground = folders.find(
    (/** @type {{ title: string }} */ folder) => folder.title === 'Playground'
  )

  if (!playground) {
    return []
  }

  const sub = await read(`/folders?parentUid=${playground.uid}&limit=1000`)
  const folder = sub.find(
    (/** @type {{ title: string }} */ candidate) =>
      candidate.title === PLAYGROUND_FOLDER
  )

  if (!folder) {
    return []
  }

  const staged = await read(`/search?folderUIDs=${folder.uid}&limit=100`)

  // Playground dashboards are not promoted, so unlike the promoted copies they
  // carry a real author rather than the platform's -- which is who to ask.
  return Promise.all(
    staged.map(
      async (/** @type {{ uid: string, title: string }} */ { uid, title }) => {
        const { meta } = await read(`/dashboards/uid/${uid}`)

        return { title, updatedBy: meta.updatedBy, updated: meta.updated }
      }
    )
  )
}

const [, , mode = 'local', outputPath = 'metrics/kpi-dashboard.json'] =
  process.argv

if (mode === 'status') {
  await status()
} else if (mode === 'check') {
  await check(outputPath)
} else if (mode === 'local') {
  await writeFile(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`)

  console.log(
    `wrote ${outputPath}: standalone, ${JOURNEYS.length} journeys, ${journeyQueries.length} queries`
  )
} else {
  const response = await fetchTarget(mode)
  const merged = mergeIntoTarget(response.dashboard, dashboard.panels)
  const stamp = targetStamp(mode, response)

  await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`)
  await writeFile(stampPath(outputPath), `${JSON.stringify(stamp, null, 2)}\n`)

  console.log(
    `wrote ${outputPath}: ${mode} version ${stamp.version} plus ${dashboard.panels.length} panels`
  )
  console.log(
    `re-check before promoting: node metrics/build-dashboard.mjs check ${outputPath}`
  )
}
