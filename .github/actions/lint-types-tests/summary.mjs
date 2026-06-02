import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { text } from 'node:stream/consumers'

import ts from 'typescript'

/**
 * @typedef {{ include: string[]; exclude?: string[] }} FilterGlobs
 *
 * @typedef {{
 *   tscOutput: string
 *   changedFiles: string[]
 *   tsCodeLookup: (code: number) => string
 * }} BuildSummaryInput
 *
 * @typedef {{
 *   tscOutput: string
 *   changedFiles: string[]
 *   runUrl?: string
 * }} BuildPrCommentInput
 *
 * @typedef {{ markdown: string; exitCode: number }} BuildSummaryResult
 *
 * @typedef {{ file: string; code: string; message: string; line: string }} ParsedError
 */

const errorLineRegex = /^([^(]+)\(\d+,\d+\): error (TS\d+): (.*)$/
const FILE_GROUP = 1
const CODE_GROUP = 2
const MESSAGE_GROUP = 3
const TS_PREFIX_LENGTH = 2
const TOP_CODES_LIMIT = 10

/**
 * @param {string[]} paths
 * @param {FilterGlobs} options
 * @returns {string[]}
 */
export const filterTestFiles = (paths, { include, exclude = [] }) =>
  paths.filter(
    (p) =>
      !exclude.some((g) => path.matchesGlob(p, g)) &&
      include.some((g) => path.matchesGlob(p, g))
  )

/**
 * Reads include/exclude globs from a tsconfig/jsconfig file's text. Tolerant of
 * comments and trailing commas; does not resolve `extends` (the test-surface
 * config declares its own include/exclude).
 *
 * @param {string} jsonText
 * @returns {FilterGlobs}
 */
export const tsconfigGlobs = (jsonText) => {
  const { config } = ts.parseConfigFileTextToJson('tsconfig.json', jsonText)
  return { include: config?.include ?? [], exclude: config?.exclude ?? [] }
}

/**
 * @param {string} tscOutput
 * @returns {{ errors: ParsedError[]; byFile: Map<string, ParsedError[]> }}
 */
const parseErrors = (tscOutput) => {
  const errors = tscOutput.split('\n').flatMap((line) => {
    const match = line.match(errorLineRegex)
    return match
      ? [
          {
            file: match[FILE_GROUP],
            code: match[CODE_GROUP],
            message: match[MESSAGE_GROUP],
            line
          }
        ]
      : []
  })
  return { errors, byFile: Map.groupBy(errors, (e) => e.file) }
}

/**
 * @param {ParsedError[]} errors
 * @returns {Array<{ code: string; count: number; message: string }>}
 */
const topCodes = (errors) =>
  [...Map.groupBy(errors, (e) => e.code).entries()]
    .map(([code, list]) => ({
      code,
      count: list.length,
      message: list[0].message
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CODES_LIMIT)

/**
 * @param {string[]} changedFiles
 * @param {Map<string, ParsedError[]>} byFile
 * @returns {{ section: string; prErrorTotal: number }}
 */
const buildPrSection = (changedFiles, byFile) => {
  const entries = [...changedFiles]
    .sort()
    .map((file) => ({ file, errors: byFile.get(file) ?? [] }))
    .filter(({ errors }) => errors.length > 0)

  const section = entries
    .map(
      ({ file, errors }) =>
        `<details><summary><code>${file}</code> (${errors.length} errors)</summary>\n\n` +
        '```\n' +
        errors.map((e) => e.line).join('\n') +
        '\n```\n\n</details>'
    )
    .join('\n\n')

  const prErrorTotal = entries.reduce(
    (sum, { errors }) => sum + errors.length,
    0
  )

  return { section, prErrorTotal }
}

/**
 * @param {number} prErrorTotal
 * @returns {string}
 */
const prHeader = (prErrorTotal) => {
  if (prErrorTotal === 0) {
    return ':white_check_mark: No type errors in test files changed in this PR'
  }
  return `:warning: **${prErrorTotal} type error(s) in test files changed in this PR**`
}

/**
 * @param {ParsedError[]} errors
 * @param {(code: number) => string} tsCodeLookup
 * @returns {string}
 */
const topCodesTable = (errors, tsCodeLookup) =>
  [
    '| Count | Code | Description |',
    '| ---: | --- | --- |',
    ...topCodes(errors).map(({ code, count, message }) => {
      const numericCode = Number(code.slice(TS_PREFIX_LENGTH))
      const description = (tsCodeLookup(numericCode) || message).replace(
        /\|/g,
        '\\|'
      )
      const slug = code.toLowerCase()
      return `| ${count} | [${code}](https://typescript.tv/errors/${slug}/) | ${description} |`
    })
  ].join('\n')

/**
 * @param {Map<string, ParsedError[]>} byFile
 * @returns {string}
 */
const errorsByFileBlock = (byFile) => {
  const counts = [...byFile.entries()]
    .map(
      ([file, errs]) => /** @type {[string, number]} */ ([file, errs.length])
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  return counts.map(([file, count]) => `${count} ${file}`).join('\n')
}

/**
 * @param {BuildPrCommentInput} input
 * @returns {BuildSummaryResult}
 */
export const buildPrComment = ({ tscOutput, changedFiles, runUrl }) => {
  const { byFile } = parseErrors(tscOutput)
  const { section, prErrorTotal } = buildPrSection(changedFiles, byFile)

  const lines = [
    '## Lint Types - Tests',
    '',
    '### Errors in this PR',
    '',
    prHeader(prErrorTotal)
  ]
  if (section) {
    lines.push('', section)
  }
  if (runUrl) {
    lines.push('', `[View full summary](${runUrl})`)
  }
  lines.push('')

  return { markdown: lines.join('\n'), exitCode: prErrorTotal > 0 ? 1 : 0 }
}

/**
 * @param {ParsedError[]} errors
 * @param {Map<string, ParsedError[]>} byFile
 * @param {(code: number) => string} tsCodeLookup
 * @returns {string}
 */
const allErrorsSection = (errors, byFile, tsCodeLookup) => {
  if (errors.length === 0) {
    return '### All errors\n\n:white_check_mark: Test type check passed'
  }
  return [
    '### All errors',
    '',
    `:warning: **${errors.length} type errors found in tests**`,
    '',
    '#### Top error codes',
    '',
    topCodesTable(errors, tsCodeLookup),
    '',
    '<details><summary>Errors by file (count)</summary>',
    '',
    '```',
    errorsByFileBlock(byFile),
    '```',
    '',
    '</details>',
    '',
    '<details><summary>Full error list</summary>',
    '',
    '```',
    errors.map((e) => e.line).join('\n'),
    '```',
    '',
    '</details>'
  ].join('\n')
}

/**
 * @param {BuildSummaryInput} input
 * @returns {BuildSummaryResult}
 */
export const buildSummary = ({ tscOutput, changedFiles, tsCodeLookup }) => {
  const { errors, byFile } = parseErrors(tscOutput)
  const { section: section1, prErrorTotal } = buildPrSection(
    changedFiles,
    byFile
  )
  const section2 = allErrorsSection(errors, byFile, tsCodeLookup)

  const lines = [
    '## Lint Types - Tests',
    '',
    '### Errors in this PR',
    '',
    prHeader(prErrorTotal)
  ]
  if (section1) {
    lines.push('', section1)
  }
  lines.push('', section2, '')
  const markdown = lines.join('\n')

  return { markdown, exitCode: prErrorTotal > 0 ? 1 : 0 }
}

/* v8 ignore start */
/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
const parseLinesEnv = (value) =>
  (value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * Resolves the changed-file filter. Explicit `include-globs` (if any) win as an
 * override; otherwise the globs are derived from the test-surface tsconfig the
 * npm script runs, keeping that config the single source of truth.
 *
 * @returns {FilterGlobs}
 */
const resolveFilterGlobs = () => {
  const include = parseLinesEnv(process.env.LINT_TYPES_TESTS_INCLUDE_GLOBS)
  if (include.length > 0) {
    return {
      include,
      exclude: parseLinesEnv(process.env.LINT_TYPES_TESTS_EXCLUDE_GLOBS)
    }
  }

  const tsconfig = process.env.LINT_TYPES_TESTS_TSCONFIG
  if (!tsconfig) {
    throw new Error(
      'either LINT_TYPES_TESTS_INCLUDE_GLOBS or LINT_TYPES_TESTS_TSCONFIG must be set'
    )
  }

  const globs = tsconfigGlobs(readFileSync(tsconfig, 'utf8'))
  if (globs.include.length === 0) {
    throw new Error(`${tsconfig} declares no include globs`)
  }
  return globs
}

const tsCodeLookupFromPackage = (() => {
  const tsInternals =
    /** @type {{ Diagnostics?: Record<string, { code?: number; message?: string }> }} */ (
      /** @type {unknown} */ (ts)
    )
  const diagnostics = tsInternals.Diagnostics ?? {}
  const map = new Map(
    Object.values(diagnostics).flatMap((d) =>
      d?.code && d?.message
        ? [/** @type {[number, string]} */ ([d.code, d.message])]
        : []
    )
  )
  return (/** @type {number} */ code) => map.get(code) ?? ''
})()

/**
 * @param {FilterGlobs} filterGlobs
 * @returns {string[]}
 */
const changedFilesFromGit = (filterGlobs) => {
  const baseRef = process.env.BASE_REF
  if (!baseRef) {
    return []
  }
  const out = execSync(
    `git diff --name-only origin/${baseRef}...HEAD`
  ).toString()
  return filterTestFiles(out.split('\n').filter(Boolean), filterGlobs)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tscOutput = await text(process.stdin)
  const changedFiles = changedFilesFromGit(resolveFilterGlobs())

  const summary = buildSummary({
    tscOutput,
    changedFiles,
    tsCodeLookup: tsCodeLookupFromPackage
  })
  process.stdout.write(summary.markdown)

  if (process.env.COMMENT_FILE) {
    const comment = buildPrComment({
      tscOutput,
      changedFiles,
      runUrl: process.env.RUN_URL
    })
    writeFileSync(process.env.COMMENT_FILE, comment.markdown)
  }

  process.exitCode = summary.exitCode
}
/* v8 ignore stop */
