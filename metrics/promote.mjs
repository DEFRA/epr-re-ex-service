// Preparing any dashboard change for a CDP promotion.
//
// Nothing here knows about a particular dashboard: give it a target uid and a
// file holding the panels you want to add, and it produces the artefact to paste
// into a playground folder. metrics/build-dashboard.mjs is one caller, for the
// KPI row; anything else that generates or exports panels can be another.
//
// Usage:
//   node metrics/promote.mjs status <target-uid>
//   node metrics/promote.mjs merge  <target-uid> <panels.json> <out.json>
//   node metrics/promote.mjs check  <out.json>
//
// CDP promotes whole dashboards and a promoted one cannot be edited in place, so
// the artefact has to be the target dashboard with the new panels already in it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import {
  describeDrift,
  describeStagedWork,
  fingerprint,
  mergeIntoTarget,
  summariseEnvironments,
  targetStamp
} from './dashboard.mjs'

const ENVIRONMENTS = ['dev', 'test', 'prod']

/** The environment a change is authored in, and therefore promoted from. */
const AUTHORING_ENVIRONMENT = 'dev'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Environments and paths arrive from argv, so check them rather than
 * interpolating whatever was typed into a URL or a file write.
 * @param {string} environment
 */
const known = (environment) => {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `unknown environment '${environment}' -- expected one of ${ENVIRONMENTS.join(', ')}`
    )
  }

  return environment
}

/** @param {string} path */
const within = (path) => {
  const resolved = resolve(ROOT, path)
  const inside = relative(ROOT, resolved)

  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`refusing to read or write outside the repository: ${path}`)
  }

  return resolved
}

/** @param {string} environment */
const api = (environment) =>
  `https://metrics.${known(environment)}.cdp-int.defra.cloud/api`

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
const read = (path) =>
  fetch(path).then((response) => {
    if (!response.ok) {
      throw new Error(`${response.status} reading ${path} -- on the VPN?`)
    }

    return response.json()
  })

/**
 * Read the target from the environment whose playground the change will be
 * pasted into. Exporting a different one silently reverts whatever it has that
 * the other does not.
 * @param {string} environment
 * @param {string} uid
 */
const fetchTarget = (environment, uid) =>
  read(`${api(environment)}/dashboards/uid/${uid}`)

/**
 * Whatever is sitting in the service's playground folder, with the fingerprint
 * needed to tell unfinished work from the copy a completed promotion leaves
 * behind. Playground dashboards are not promoted, so unlike the promoted ones
 * they carry a real author -- which is who to ask.
 * @param {string} environment
 * @param {string} folderName
 */
const fetchPlayground = async (environment, folderName) => {
  const base = api(environment)
  const folders = await read(`${base}/folders?limit=1000`)
  const playground = folders.find(
    (/** @type {{ title: string }} */ candidate) =>
      candidate.title === 'Playground'
  )

  if (!playground) {
    return []
  }

  const sub = await read(
    `${base}/folders?parentUid=${playground.uid}&limit=1000`
  )
  const folder = sub.find(
    (/** @type {{ title: string }} */ candidate) =>
      candidate.title === folderName
  )

  if (!folder) {
    return []
  }

  const staged = await read(`${base}/search?folderUIDs=${folder.uid}&limit=100`)

  return Promise.all(
    staged.map(async (/** @type {{ uid: string, title: string }} */ entry) => {
      const { meta, dashboard } = await read(
        `${base}/dashboards/uid/${entry.uid}`
      )

      return {
        title: entry.title,
        updatedBy: meta.updatedBy,
        updated: meta.updated,
        fingerprint: fingerprint(dashboard)
      }
    })
  )
}

/**
 * The service folder a dashboard's playground copy lives in. CDP names it after
 * the service, and the promoted dashboard sits in a folder of that name.
 * @param {{ meta: Record<string, any> }} response
 */
const playgroundFolderFor = ({ meta }) => `${meta.folderTitle}-monitoring`

/**
 * Two questions the portal does not answer: do the environments agree, and is
 * anything staged that you would save over.
 * @param {string} uid
 */
const status = async (uid) => {
  const targets = await Promise.all(
    ENVIRONMENTS.map(async (environment) => ({
      environment,
      ...(await fetchTarget(environment, uid))
    }))
  )

  const snapshots = targets.map(({ environment, meta, dashboard: target }) => ({
    environment,
    version: meta.version,
    updated: meta.updated,
    fingerprint: fingerprint(target)
  }))

  snapshots.forEach(({ environment, version, updated }) =>
    console.log(`  ${environment}: version ${version}, updated ${updated}`)
  )

  const { inSync, differences } = summariseEnvironments(snapshots)

  if (inSync) {
    console.log('\nenvironments agree')
  }

  differences.forEach((difference) => console.error(`\n${difference}`))

  const authoring = targets.find(
    ({ environment }) => environment === AUTHORING_ENVIRONMENT
  )
  const staged = describeStagedWork(
    await fetchPlayground(
      AUTHORING_ENVIRONMENT,
      playgroundFolderFor(authoring)
    ),
    authoring.dashboard.title,
    fingerprint(authoring.dashboard)
  )

  if (staged) {
    console[staged.blocking ? 'error' : 'log'](`\n${staged.message}`)
  }

  if (!inSync || staged?.blocking) {
    process.exit(1)
  }
}

/** @param {string} outputPath */
const stampPath = (outputPath) =>
  `${outputPath.replace(/\.json$/, '')}.target.json`

/**
 * @param {string} uid
 * @param {string} panelsPath a dashboard JSON whose panels are added to the target
 * @param {string} outputPath
 */
const merge = async (uid, panelsPath, outputPath) => {
  const source = JSON.parse(await readFile(within(panelsPath), 'utf8'))
  const response = await fetchTarget(AUTHORING_ENVIRONMENT, uid)
  const merged = mergeIntoTarget(response.dashboard, source.panels)
  const stamp = {
    ...targetStamp(AUTHORING_ENVIRONMENT, response),
    // Recorded so check knows what to re-read without being told again.
    targetUid: uid
  }

  await mkdir(dirname(within(outputPath)), { recursive: true })
  await writeFile(within(outputPath), `${JSON.stringify(merged, null, 2)}\n`)
  await writeFile(
    within(stampPath(outputPath)),
    `${JSON.stringify(stamp, null, 2)}\n`
  )

  const written = relative(ROOT, within(outputPath))

  console.log(
    `wrote ${written}: ${AUTHORING_ENVIRONMENT} version ${stamp.version} plus ${source.panels.length} panels`
  )
  console.log(
    `re-check before promoting: node metrics/promote.mjs check ${written}`
  )
}

/**
 * A target that has moved since the merge was built is a silent revert waiting
 * to happen, and nothing in Grafana or the portal will say so.
 * @param {string} outputPath
 */
const check = async (outputPath) => {
  const stamp = JSON.parse(
    await readFile(within(stampPath(outputPath)), 'utf8')
  )
  const environment = known(stamp.environment)
  const before = { ...stamp, environment }
  const drift = describeDrift(
    before,
    targetStamp(environment, await fetchTarget(environment, stamp.targetUid))
  )

  if (drift) {
    console.error(drift)
    process.exit(1)
  }

  console.log(
    `${environment} is still at version ${Number(before.version)} -- safe to paste`
  )
}

const [, , mode, ...rest] = process.argv

const usage = `usage:
  node metrics/promote.mjs status <target-uid>
  node metrics/promote.mjs merge  <target-uid> <panels.json> <out.json>
  node metrics/promote.mjs check  <out.json>`

if (mode === 'status' && rest.length === 1) {
  await status(rest[0])
} else if (mode === 'merge' && rest.length === 3) {
  await merge(rest[0], rest[1], rest[2])
} else if (mode === 'check' && rest.length === 1) {
  await check(rest[0])
} else {
  console.error(usage)
  process.exit(1)
}
