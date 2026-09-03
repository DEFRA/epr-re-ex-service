import { createHash } from 'node:crypto'

// Merging generated panels into a dashboard that already exists.
//
// CDP promotes a whole dashboard, never a panel, and a promoted dashboard cannot
// be edited in place: you take a full copy into a playground folder, change it
// there, and promote the result. So the thing to generate is not a dashboard of
// our own but the target dashboard with our row appended, ready to paste into
// the playground's JSON model.
//
// Take the target live rather than from a committed snapshot. A snapshot goes
// stale silently, and promoting one would revert whatever was added upstream in
// the meantime -- a failure that looks like success.

/**
 * @typedef {Record<string, any>} Panel
 * @typedef {Record<string, any>} Dashboard
 */

/**
 * Rows can hold their children rather than sit beside them, depending on whether
 * they were collapsed when the dashboard was saved, so both shapes have to be
 * walked.
 * @param {Panel[]} panels
 * @returns {Panel[]}
 */
const flatten = (panels) =>
  panels.flatMap((panel) => [panel, ...flatten(panel.panels ?? [])])

/**
 * @param {Panel[]} panels
 * @returns {number}
 */
export const maxPanelId = (panels) =>
  flatten(panels).reduce((highest, { id }) => Math.max(highest, id ?? 0), 0)

/**
 * @param {Panel[]} panels
 * @returns {number}
 */
export const contentBottom = (panels) =>
  flatten(panels).reduce(
    (lowest, { gridPos }) =>
      Math.max(lowest, (gridPos?.y ?? 0) + (gridPos?.h ?? 0)),
    0
  )

/**
 * The uid a datasource has is per Grafana instance, so ours has to adopt whatever
 * the target already queries through rather than carry one of its own. Promotion
 * rewrites it again for each environment downstream.
 * @param {Dashboard} dashboard
 * @returns {string}
 */
export const cloudwatchDatasourceUid = (dashboard) => {
  const uid = flatten(dashboard.panels ?? [])
    .flatMap((panel) => [
      panel.datasource,
      ...(panel.targets ?? []).map((t) => t.datasource)
    ])
    .find((datasource) => datasource?.type === 'cloudwatch')?.uid

  if (!uid) {
    throw new Error('target dashboard has no cloudwatch datasource to adopt')
  }

  return uid
}

/**
 * @param {Panel} panel
 * @param {{ id: number, yOffset: number, datasourceUid: string }} placement
 * @returns {Panel}
 */
const place = (panel, { id, yOffset, datasourceUid }) => {
  const datasource = { type: 'cloudwatch', uid: datasourceUid }

  return {
    ...panel,
    id,
    gridPos: { ...panel.gridPos, y: panel.gridPos.y + yOffset },
    ...(panel.datasource && { datasource }),
    ...(panel.targets && {
      targets: panel.targets.map((target) => ({ ...target, datasource }))
    })
  }
}

/**
 * @param {Dashboard} target
 * @param {Panel[]} panels
 * @returns {Dashboard}
 */
export const mergeIntoTarget = (target, panels) => {
  const datasourceUid = cloudwatchDatasourceUid(target)
  const firstId = maxPanelId(target.panels) + 1
  const yOffset = contentBottom(target.panels)

  // Numbered above the highest in use rather than into the gaps: a panel added
  // upstream takes the next free number, and would collide with a claimed gap.
  const placed = panels.map((panel, index) =>
    place(panel, { id: firstId + index, yOffset, datasourceUid })
  )

  const { id, uid, ...dashboard } = target

  return { ...dashboard, panels: [...target.panels, ...placed] }
}

/**
 * What a merge was built from, so it can be checked again before promoting.
 * Nothing attributes a change to a person: promotion runs as the platform, so
 * every environment reports admin as the author, and the version history
 * endpoint needs a login. Version and timestamp are all that is readable, and
 * they are enough to tell that something moved.
 * @param {string} environment
 * @param {{ meta: Record<string, any>, dashboard: Record<string, any> }} response
 */
export const targetStamp = (environment, { meta, dashboard }) => ({
  environment,
  uid: dashboard.uid,
  version: meta.version,
  updated: meta.updated
})

/**
 * @param {ReturnType<typeof targetStamp>} before
 * @param {ReturnType<typeof targetStamp>} after
 * @returns {string | null} why the target is no longer what was merged from
 */
export const describeDrift = (before, after) => {
  if (before.version !== after.version) {
    return `${before.environment} moved from version ${before.version} to ${after.version} since this was generated -- regenerate, or promoting will revert whatever changed`
  }

  if (before.updated !== after.updated) {
    return `${before.environment} was edited at ${after.updated} without the version moving -- someone may have work in progress there`
  }

  return null
}

/**
 * A stable digest of what a dashboard actually shows, ignoring the fields that
 * differ by Grafana instance rather than by content.
 * @param {Dashboard} dashboard
 * @returns {string}
 */
export const fingerprint = (dashboard) => {
  const { id, version, ...content } = dashboard

  // Datasource uids are per Grafana instance and are rewritten on promotion, so
  // they always differ between environments even when the content is identical.
  const normalised = JSON.stringify(content, (key, value) =>
    key === 'datasource' && value?.uid
      ? { ...value, uid: 'per-environment' }
      : value
  )

  return createHash('sha256').update(normalised).digest('hex')
}

/**
 * Promoting from dev applies the change to every environment at once, so
 * environments that disagree are not somebody midway through a piece of work --
 * that sits in the playground. They mean a promotion is in flight, failed part
 * way, or an environment was edited directly.
 * @param {{ environment: string, version: number, updated: string, fingerprint: string }[]} snapshots
 */
export const summariseEnvironments = (snapshots) => {
  const groups = snapshots.reduce(
    (grouped, snapshot) =>
      grouped.set(snapshot.fingerprint, [
        ...(grouped.get(snapshot.fingerprint) ?? []),
        snapshot
      ]),
    /** @type {Map<string, typeof snapshots>} */ (new Map())
  )

  if (groups.size === 1) {
    return { inSync: true, differences: [] }
  }

  // Report the smaller groups: whatever is outnumbered is what to look at.
  const [, ...odd] = [...groups.values()].sort((a, b) => b.length - a.length)

  return {
    inSync: false,
    differences: odd.map(
      (group) =>
        `${group.map(({ environment }) => environment).join(' and ')} do not match the others (${group
          .map(
            ({ version, updated }) => `version ${version}, updated ${updated}`
          )
          .join(
            '; '
          )}) -- a promotion in flight, one that failed part way, or an environment edited directly. Ask before promoting over it.`
    )
  }
}

/**
 * Dashboards are promoted one at a time, so staged work only goes out with yours
 * if it is the same dashboard. Anything else in the folder is someone's
 * unfinished work: worth knowing about, not a reason to stop.
 *
 * Playground copies are not promoted, so unlike the promoted ones they carry a
 * real author rather than the platform's -- which is who to ask.
 * @param {{ title: string, updatedBy?: string, updated?: string }[]} staged
 * @param {string} targetTitle
 * @returns {{ blocking: boolean, message: string } | null}
 */
export const describeStagedWork = (staged, targetTitle) => {
  if (staged.length === 0) {
    return null
  }

  const describe = ({ title, updatedBy, updated }) =>
    updatedBy
      ? `${title} (last touched by ${updatedBy}${updated ? ` on ${updated}` : ''})`
      : title

  const sameDashboard = staged.filter(({ title }) => title === targetTitle)

  if (sameDashboard.length > 0) {
    return {
      blocking: true,
      message: `the playground already holds a copy of the dashboard you are about to edit, and saving over it would overwrite that work: ${sameDashboard
        .map(describe)
        .join(', ')}`
    }
  }

  return {
    blocking: false,
    message: `other unpromoted work is sitting in the playground, which promoting yours will not disturb: ${staged
      .map(describe)
      .join(', ')}`
  }
}
