import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

/**
 * @typedef {{ result: string }} JobResult
 *
 * @typedef {{
 *   jobIds: string[]
 *   exclude: string[]
 *   gated: string[]
 * }} CompareJobsInput
 *
 * @typedef {{ missing: string[]; stale: string[] }} JobDrift
 */

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
export const parseList = (value) =>
  (value ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)

/**
 * GITHUB_WORKFLOW_REF is `<owner>/<repo>/<path>@<ref>`, and only the ref may
 * itself contain an `@`.
 *
 * @param {string} ref
 * @returns {string}
 */
export const workflowPathFromRef = (ref) =>
  ref.slice(0, ref.indexOf('@')).split('/').slice(2).join('/')

/**
 * @param {CompareJobsInput} input
 * @returns {JobDrift}
 */
export const compareJobs = ({ jobIds, exclude, gated }) => {
  const expected = jobIds.filter((id) => !exclude.includes(id))

  return {
    missing: expected.filter((id) => !gated.includes(id)),
    stale: gated.filter((id) => !expected.includes(id))
  }
}

/**
 * @param {Record<string, JobResult>} results
 * @returns {string[]}
 */
export const failedResults = (results) =>
  Object.entries(results)
    .filter(([, { result }]) => result !== 'success' && result !== 'skipped')
    .map(([job, { result }]) => `${job}=${result}`)

/**
 * @param {string} yamlText
 * @returns {string[]}
 */
export const jobIds = (yamlText) => Object.keys(parse(yamlText)?.jobs ?? {})

/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const {
    GITHUB_JOB: gateJob,
    GITHUB_WORKFLOW_REF: workflowRef,
    PR_GATE_RESULTS: rawResults,
    PR_GATE_SEPARATELY_REQUIRED: separatelyRequired,
    PR_GATE_ADVISORY: advisory
  } = process.env

  if (!gateJob || !workflowRef || !rawResults) {
    console.log(
      '::error::GITHUB_JOB, GITHUB_WORKFLOW_REF and PR_GATE_RESULTS must be set'
    )
    process.exit(1)
  }

  const results = JSON.parse(rawResults)
  const workflowPath = workflowPathFromRef(workflowRef)

  const { missing, stale } = compareJobs({
    jobIds: jobIds(readFileSync(workflowPath, 'utf8')),
    exclude: [
      gateJob,
      ...parseList(separatelyRequired),
      ...parseList(advisory)
    ],
    gated: Object.keys(results)
  })

  if (missing.length > 0) {
    console.log(
      `::error::not gated by ${gateJob}: ${missing.join(', ')}. Add each to ` +
        `\`needs\`, or declare it under separately-required / advisory.`
    )
  }
  if (stale.length > 0) {
    console.log(
      `::error::listed in \`needs\` but not a job in ${workflowPath}: ${stale.join(', ')}`
    )
  }
  if (missing.length > 0 || stale.length > 0) {
    process.exit(1)
  }
  console.log(`Every blocking job in ${workflowPath} is gated`)

  const failed = failedResults(results)
  if (failed.length > 0) {
    console.log(`::error::did not pass: ${failed.join(' ')}`)
    process.exit(1)
  }
  console.log('Every pull request check passed')
}
/* v8 ignore stop */
