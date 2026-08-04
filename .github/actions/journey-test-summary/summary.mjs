import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{
 *   name: string,
 *   status: string,
 *   durationMs: number | null,
 *   message?: string
 * }} Result
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
          statusDetails
        } = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        return [
          {
            name: testName,
            status,
            durationMs:
              start === undefined || stop === undefined ? null : stop - start,
            message: statusDetails?.message
          }
        ]
      } catch {
        return []
      }
    })
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export const formatDuration = (seconds) =>
  seconds >= SECONDS_PER_MINUTE
    ? `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`
    : `${seconds}s`

/**
 * @param {Result[]} results
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
 * @returns {string}
 */
const statusLine = (failed) =>
  failed > 0
    ? `:x: **${failed} failed**`
    : ':white_check_mark: All tests passed'

/**
 * @param {Result[]} results
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
 *   dockerSeconds?: number | null,
 *   testSeconds?: number | null
 * }} input
 * @returns {{ markdown: string }}
 */
export const buildSummary = ({
  results,
  dockerSeconds = null,
  testSeconds = null
}) => {
  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => FAILED_STATUSES.has(r.status)).length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const total = results.length

  const lines = [
    '## Journey Tests',
    '',
    statusLine(failed),
    '',
    '| | Passed | Failed | Skipped | Total |',
    '|---|---|---|---|---|',
    `| Tests | ${passed} | ${failed} | ${skipped} | ${total} |`,
    ...failedSection(results)
  ]

  if (dockerSeconds !== null && testSeconds !== null) {
    lines.push(
      '',
      `Docker build: ${formatDuration(dockerSeconds)} | Tests: ${formatDuration(testSeconds)}`
    )
  }

  const slow = slowest(results)
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
    dockerSeconds,
    testSeconds
  })
  process.stdout.write(markdown)
  writeCommentFile(process.env.COMMENT_FILE, markdown)
}
/* v8 ignore stop */
