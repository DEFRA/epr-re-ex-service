import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {{ name: string, status: string, start?: number, stop?: number }} Result
 */

const SLOWEST_LIMIT = 5
const FAILED_STATUSES = new Set(['failed', 'broken'])
const SECONDS_PER_MINUTE = 60
const MS_PER_SECOND = 1000

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
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        return [
          {
            name: parsed.name,
            status: parsed.status,
            start: parsed.start,
            stop: parsed.stop
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
 * @param {Result} result
 * @returns {number}
 */
const durationMs = (result) => (result.stop ?? 0) - (result.start ?? 0)

/**
 * @param {Result[]} results
 * @returns {Array<{ name: string, seconds: number }>}
 */
const slowest = (results) =>
  results
    .filter((r) => r.start != null && r.stop != null)
    .sort((a, b) => durationMs(b) - durationMs(a))
    .slice(0, SLOWEST_LIMIT)
    .map((r) => ({
      name: r.name,
      seconds: Math.round(durationMs(r) / MS_PER_SECOND)
    }))

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
  const total = results.length

  const lines = [
    '## Journey Tests',
    '',
    '| | Passed | Failed | Total |',
    '|---|---|---|---|',
    `| Tests | ${passed} | ${failed} | ${total} |`
  ]

  if (dockerSeconds != null && testSeconds != null) {
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
}
/* v8 ignore stop */
