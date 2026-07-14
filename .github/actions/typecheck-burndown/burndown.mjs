import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * @typedef {{ lever: string; prod: number; tests: number }} LeverResult
 */

const CONCURRENCY = 4

/**
 * Flags that are `true` in the strict config but not yet `true` in the base
 * config — i.e. the candidate levers still to be burned down. Non-boolean
 * options (types, paths) are ignored.
 *
 * @param {string} baseText
 * @param {string} strictText
 * @returns {string[]}
 */
export const leversFromConfigs = (baseText, strictText) => {
  const base = JSON.parse(baseText).compilerOptions ?? {}
  const strict = JSON.parse(strictText).compilerOptions ?? {}
  return Object.entries(strict)
    .filter(([flag, value]) => value === true && base[flag] !== true)
    .map(([flag]) => flag)
}

/**
 * @param {string} tscOutput
 * @returns {number}
 */
export const countErrors = (tscOutput) =>
  (tscOutput.match(/error TS\d+/g) ?? []).length

/**
 * @param {{ prod: number; tests: number }} result
 * @returns {'ready-all' | 'ready-prod' | 'ready-tests' | 'chip'}
 */
export const categorise = ({ prod, tests }) => {
  if (prod === 0 && tests === 0) {
    return 'ready-all'
  }
  if (prod === 0) {
    return 'ready-prod'
  }
  if (tests === 0) {
    return 'ready-tests'
  }
  return 'chip'
}

/**
 * @param {LeverResult[]} results
 * @param {{ runUrl?: string }} [options]
 * @returns {{ markdown: string }}
 */
export const buildBurndown = (results, { runUrl } = {}) => {
  const byCat = Map.groupBy(results, categorise)
  const readyAll = byCat.get('ready-all') ?? []
  const readyProd = byCat.get('ready-prod') ?? []
  const readyTests = byCat.get('ready-tests') ?? []
  const chip = (byCat.get('chip') ?? []).toSorted(
    (a, b) => a.prod + a.tests - (b.prod + b.tests)
  )

  const lines = [
    '## Typecheck strictness — burndown (soft / non-blocking)',
    '',
    '_Marginal errors each lever adds over the current hard config, measured' +
      " in isolation. They don't sum to a combined-strict total (flags interact)._"
  ]

  if (readyAll.length > 0) {
    lines.push(
      '',
      '### :white_check_mark: Ready to enforce everywhere (0 / 0)',
      'Move from `jsconfig.typecheck.strict.json` into `jsconfig.typecheck.base.json`:',
      ...readyAll.map((r) => `- \`${r.lever}\``)
    )
  }
  if (readyProd.length > 0) {
    lines.push(
      '',
      '### :arrow_up: Ready for prod (prod clean, tests remaining)',
      'Move into `jsconfig.typecheck.json`:',
      ...readyProd.map((r) => `- \`${r.lever}\` — ${r.tests} in tests`)
    )
  }
  if (readyTests.length > 0) {
    lines.push(
      '',
      '### :arrow_up: Ready for tests (tests clean, prod remaining)',
      'Move into `jsconfig.typecheck.tests.json`:',
      ...readyTests.map((r) => `- \`${r.lever}\` — ${r.prod} in prod`)
    )
  }
  if (chip.length > 0) {
    lines.push(
      '',
      '### :hourglass_flowing_sand: Chip away (fewest remaining first)',
      '| lever | prod | tests |',
      '| --- | ---: | ---: |',
      ...chip.map((r) => `| \`${r.lever}\` | ${r.prod} | ${r.tests} |`)
    )
  }
  if (runUrl) {
    lines.push('', `[View full run](${runUrl})`)
  }
  lines.push('')

  return { markdown: lines.join('\n') }
}

/* v8 ignore start */
/**
 * @param {(...args: any[]) => any} fn
 * @param {any[]} items
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
const mapPool = async (fn, items, limit) => {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * @param {string} tsc
 * @param {string} config
 * @param {string | null} flag
 * @returns {Promise<number>}
 */
const runPass = async (tsc, config, flag) => {
  const args = ['-p', config]
  if (flag) {
    args.push(`--${flag}`)
  }
  try {
    const { stdout } = await execFileAsync(tsc, args, {
      maxBuffer: 64 * 1024 * 1024
    })
    return countErrors(stdout)
  } catch (error) {
    return countErrors(`${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tsc = process.env.TSC_BIN ?? './node_modules/.bin/tsc'
  const baseConfig = process.env.BASE_CONFIG ?? 'jsconfig.typecheck.base.json'
  const strictConfig =
    process.env.STRICT_CONFIG ?? 'jsconfig.typecheck.strict.json'
  const prodConfig = process.env.PROD_CONFIG ?? 'jsconfig.typecheck.json'
  const testsConfig = process.env.TESTS_CONFIG ?? 'jsconfig.typecheck.tests.json'

  const levers = leversFromConfigs(
    readFileSync(baseConfig, 'utf8'),
    readFileSync(strictConfig, 'utf8')
  )

  const surfaces = [
    { key: 'prod', config: prodConfig },
    { key: 'tests', config: testsConfig }
  ]

  const baselines = Object.fromEntries(
    await Promise.all(
      surfaces.map(async ({ key, config }) => [
        key,
        await runPass(tsc, config, null)
      ])
    )
  )

  const tasks = surfaces.flatMap(({ key, config }) =>
    levers.map((lever) => ({ key, config, lever }))
  )
  const counts = await mapPool(
    async ({ config, lever }) => runPass(tsc, config, lever),
    tasks,
    CONCURRENCY
  )

  const results = levers.map((lever) => {
    const marginal = (key) => {
      const index = tasks.findIndex((t) => t.key === key && t.lever === lever)
      return Math.max(0, counts[index] - baselines[key])
    }
    return { lever, prod: marginal('prod'), tests: marginal('tests') }
  })

  const { markdown } = buildBurndown(results, { runUrl: process.env.RUN_URL })
  process.stdout.write(markdown)

  if (process.env.COMMENT_FILE) {
    writeFileSync(process.env.COMMENT_FILE, markdown)
  }
}
/* v8 ignore stop */
