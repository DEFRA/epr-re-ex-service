import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{
 *   name: string,
 *   status: string,
 *   durationMs: number | null,
 *   message?: string,
 *   historyId?: string,
 *   start?: number
 * }} Result
 */

/**
 * @typedef {Result & {
 *   attempts: number,
 *   failedAttempts: number,
 *   firstFailure?: string
 * }} Test
 */

const SLOWEST_LIMIT = 5
const FAILED_STATUSES = new Set(['failed', 'broken'])
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000
const MESSAGE_MAX_LENGTH = 200

/**
 * Reads allure `*-result.json` files, keeping only the top-level fields the
 * summary needs. Deeply nested `steps` are never traversed and unreadable or
 * unparseable files are skipped, so a pathological result can't break the
 * summary (Node parses JSON iteratively, so depth is not a concern either).
 * @param {string} dir
 * @returns {Result[]}
 */
export const readResults = (dir) => {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  return entries
    .filter((name) => name.endsWith('-result.json'))
    .flatMap((name) => {
      try {
        const {
          name: testName,
          status,
          start,
          stop,
          statusDetails,
          historyId
        } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        return [
          {
            name: testName,
            status,
            durationMs:
              start === undefined || stop === undefined ? null : stop - start,
            message: statusDetails?.message,
            historyId,
            start
          }
        ]
      } catch {
        return []
      }
    })
}

/**
 * Folds the attempts of each test into one entry: its last attempt's outcome,
 * with how many attempts there were and how many of them failed.
 * @param {Result[]} results
 * @returns {Test[]}
 */
const toTests = (results) =>
  Object.values(Object.groupBy(results, (r) => r.historyId ?? r.name)).map(
    (attempts = []) => {
      const ordered = attempts.toSorted(
        (a, b) => (a.start ?? 0) - (b.start ?? 0)
      )
      const failures = ordered.filter((r) => FAILED_STATUSES.has(r.status))
      return {
        ...ordered[ordered.length - 1],
        attempts: ordered.length,
        failedAttempts: failures.length,
        firstFailure: failures[0]?.message
      }
    }
  )

/**
 * @param {Test} test
 * @returns {boolean}
 */
const isFlaky = (test) => test.status === 'passed' && test.failedAttempts > 0

/**
 * @param {number} seconds
 * @returns {string}
 */
export const formatDuration = (seconds) =>
  seconds >= SECONDS_PER_MINUTE
    ? `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`
    : `${seconds}s`

/**
 * @param {Test[]} results
 * @returns {Array<{ name: string, seconds: number }>}
 */
const slowest = (results) =>
  results
    .flatMap((r) =>
      r.durationMs === null ? [] : [{ name: r.name, durationMs: r.durationMs }]
    )
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOWEST_LIMIT)
    .map((r) => ({
      name: r.name,
      seconds: Math.round(r.durationMs / MS_PER_SECOND)
    }))

/**
 * Renders a value for a markdown table cell: first line only, truncated, with
 * pipes escaped so they can't break the table.
 * @param {string | undefined} value
 * @returns {string}
 */
const cell = (value) => {
  const firstLine = (value ?? '').split('\n')[0].trim()
  const clipped =
    firstLine.length > MESSAGE_MAX_LENGTH
      ? `${firstLine.slice(0, MESSAGE_MAX_LENGTH)}...`
      : firstLine
  return clipped.replace(/\|/g, '\\|')
}

/**
 * @param {number} failed
 * @param {number} flaky
 * @param {string} outcome
 * @returns {string}
 */
const statusLine = (failed, flaky, outcome) => {
  if (failed > 0) {
    return `:x: **${failed} failed**`
  }
  if (outcome && outcome !== 'success') {
    return `:x: **Journey tests reported ${outcome}** with no failed test results: a leg may have stopped before its tests ran`
  }
  return flaky > 0
    ? `:warning: All tests passed, ${flaky} only on a retry`
    : ':white_check_mark: All tests passed'
}

/**
 * @param {Test[]} tests
 * @returns {string[]}
 */
const flakySection = (tests) => {
  const flaky = tests.filter(isFlaky)
  if (flaky.length === 0) {
    return []
  }
  return [
    '',
    '### Passed on a retry',
    '',
    '| Test | Failed attempts | First failure |',
    '|---|---|---|',
    ...flaky.map(
      (t) =>
        `| ${cell(t.name)} | ${t.failedAttempts} of ${t.attempts} | ${cell(t.firstFailure)} |`
    )
  ]
}

/**
 * @param {Test[]} results
 * @returns {string[]}
 */
const failedSection = (results) => {
  const failures = results.filter((r) => FAILED_STATUSES.has(r.status))
  if (failures.length === 0) {
    return []
  }
  return [
    '',
    '### Failed Tests',
    '',
    '| Test | Details |',
    '|---|---|',
    ...failures.map((r) => `| ${cell(r.name)} | ${cell(r.message)} |`)
  ]
}

/**
 * @param {{
 *   results: Result[],
 *   outcome?: string,
 *   dockerSeconds?: number | null,
 *   testSeconds?: number | null
 * }} input
 * @returns {{ markdown: string }}
 */
export const buildSummary = ({
  results,
  outcome = '',
  dockerSeconds = null,
  testSeconds = null
}) => {
  const tests = toTests(results)
  const flaky = tests.filter(isFlaky).length
  const passed = tests.filter((t) => t.status === 'passed').length - flaky
  const failed = tests.filter((t) => FAILED_STATUSES.has(t.status)).length
  const skipped = tests.filter((t) => t.status === 'skipped').length
  const total = tests.length

  const lines = [
    '## Journey Tests',
    '',
    statusLine(failed, flaky, outcome),
    '',
    '| | Passed | Flaky | Failed | Skipped | Total |',
    '|---|---|---|---|---|---|',
    `| Tests | ${passed} | ${flaky} | ${failed} | ${skipped} | ${total} |`,
    ...failedSection(tests),
    ...flakySection(tests)
  ]

  if (dockerSeconds !== null && testSeconds !== null) {
    lines.push(
      '',
      `Docker build: ${formatDuration(dockerSeconds)} | Tests: ${formatDuration(testSeconds)}`
    )
  }

  const slow = slowest(tests)
  if (slow.length > 0) {
    lines.push(
      '',
      '### Slowest Journey Tests',
      '',
      '| Test | Duration |',
      '|---|---|',
      ...slow.map((s) => `| ${s.name} | ${formatDuration(s.seconds)} |`)
    )
  }

  lines.push('')
  return { markdown: lines.join('\n') }
}

/**
 * Writes the summary markdown to a file for a sticky PR comment. No-op when no
 * path is given (the caller may not want a comment).
 * @param {string | undefined} commentFile
 * @param {string} markdown
 * @returns {void}
 */
export const writeCommentFile = (commentFile, markdown) => {
  if (commentFile) {
    writeFileSync(commentFile, markdown)
  }
}

/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.RESULTS_DIR ?? 'allure-results'
  const dockerSeconds = process.env.DOCKER_SECONDS
    ? Number(process.env.DOCKER_SECONDS)
    : null
  const testSeconds = process.env.TEST_SECONDS
    ? Number(process.env.TEST_SECONDS)
    : null

  const { markdown } = buildSummary({
    results: readResults(dir),
    outcome: process.env.OUTCOME,
    dockerSeconds,
    testSeconds
  })
  process.stdout.write(markdown)
  writeCommentFile(process.env.COMMENT_FILE, markdown)
}
/* v8 ignore stop */
