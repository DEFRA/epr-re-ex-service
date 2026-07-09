import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSummary,
  formatDuration,
  readResults,
  writeCommentFile
} from './summary.mjs'

/** A raw allure result file, as written to disk. */
const allureResult = (overrides) => ({
  name: 'a test',
  status: 'passed',
  start: 1000,
  stop: 2000,
  ...overrides
})

/** A normalised result, as returned by readResults / consumed by buildSummary. */
const result = (overrides) => ({
  name: 'a test',
  status: 'passed',
  durationMs: 1000,
  ...overrides
})

describe('journey test summary', () => {
  const tmpDirs = []

  const withResults = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'allure-'))
    tmpDirs.push(dir)
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(
        join(dir, name),
        typeof contents === 'string' ? contents : JSON.stringify(contents)
      )
    }
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('formatDuration', () => {
    it.each([
      [5, '5s'],
      [59, '59s'],
      [60, '1m 0s'],
      [125, '2m 5s']
    ])('should format %i seconds as %s', (seconds, expected) => {
      expect(formatDuration(seconds)).toBe(expected)
    })
  })

  describe('readResults', () => {
    it('should normalise each result to name, status and duration', () => {
      const dir = withResults({
        'a-result.json': allureResult({
          name: 'one',
          steps: [{ name: 'nested' }]
        })
      })

      expect(readResults(dir)).toEqual([
        { name: 'one', status: 'passed', durationMs: 1000 }
      ])
    })

    it('should set duration to null when timing is incomplete', () => {
      const dir = withResults({
        'a-result.json': { name: 'skipped one', status: 'skipped' }
      })

      expect(readResults(dir)[0].durationMs).toBeNull()
    })

    it('should ignore files that are not allure results', () => {
      const dir = withResults({
        'a-result.json': allureResult({ name: 'kept' }),
        'categories.json': { irrelevant: true }
      })

      expect(readResults(dir).map((r) => r.name)).toEqual(['kept'])
    })

    it('should skip unparseable files rather than throwing', () => {
      const dir = withResults({
        'bad-result.json': '{ not valid json',
        'good-result.json': allureResult({ name: 'good' })
      })

      expect(readResults(dir).map((r) => r.name)).toEqual(['good'])
    })

    it('should read a pathologically deep result without failing', () => {
      const depth = 50000
      const deepSteps = '[{"steps":'.repeat(depth) + '[]' + '}]'.repeat(depth)
      const dir = withResults({
        'deep-result.json': `{"name":"deep","status":"passed","start":0,"stop":3000,"steps":${deepSteps}}`
      })

      expect(readResults(dir)).toEqual([
        { name: 'deep', status: 'passed', durationMs: 3000 }
      ])
    })

    it('should capture the failure message from statusDetails', () => {
      const dir = withResults({
        'a-result.json': allureResult({
          status: 'failed',
          statusDetails: { message: 'expected 200, got 500', trace: 'a\nb' }
        })
      })

      expect(readResults(dir)[0].message).toBe('expected 200, got 500')
    })

    it('should return an empty array when the directory is missing', () => {
      expect(readResults(join(tmpdir(), 'does-not-exist-allure'))).toEqual([])
    })
  })

  describe('buildSummary', () => {
    it('should count passed, failed, broken and skipped results', () => {
      const results = [
        result({ status: 'passed' }),
        result({ status: 'failed' }),
        result({ status: 'broken' }),
        result({ status: 'skipped' })
      ]

      const { markdown } = buildSummary({ results })

      expect(markdown).toContain('| | Passed | Failed | Skipped | Total |')
      expect(markdown).toContain('| Tests | 1 | 2 | 1 | 4 |')
    })

    it('should show a failure status line when tests failed', () => {
      const { markdown } = buildSummary({
        results: [result({ status: 'passed' }), result({ status: 'failed' })]
      })

      expect(markdown).toContain(':x: **1 failed**')
    })

    it('should show a success status line when all tests passed', () => {
      const { markdown } = buildSummary({ results: [result(), result()] })

      expect(markdown).toContain(':white_check_mark: All tests passed')
    })

    it('should list failed and broken tests with their message', () => {
      const results = [
        result({ name: 'ok one' }),
        result({
          name: 'submit report',
          status: 'failed',
          message: 'expected 200, got 500\nstack trace here'
        }),
        result({ name: 'broken flow', status: 'broken', message: 'no element' })
      ]

      const { markdown } = buildSummary({ results })

      expect(markdown).toContain('### Failed Tests')
      expect(markdown).toContain('| submit report | expected 200, got 500 |')
      expect(markdown).toContain('| broken flow | no element |')
    })

    it('should omit the failed section when nothing failed', () => {
      const { markdown } = buildSummary({
        results: [result(), result({ status: 'skipped' })]
      })

      expect(markdown).not.toContain('### Failed Tests')
    })

    it('should escape pipes and truncate long failure messages', () => {
      const { markdown } = buildSummary({
        results: [
          result({
            name: 'a | b',
            status: 'failed',
            message: `${'x'.repeat(250)}\nsecond line`
          })
        ]
      })

      expect(markdown).toContain(`| a \\| b | ${'x'.repeat(200)}... |`)
    })

    it('should include the duration line when both durations are given', () => {
      const { markdown } = buildSummary({
        results: [result()],
        dockerSeconds: 45,
        testSeconds: 128
      })

      expect(markdown).toContain('Docker build: 45s | Tests: 2m 8s')
    })

    it('should omit the duration line when durations are absent', () => {
      const { markdown } = buildSummary({ results: [result()] })

      expect(markdown).not.toContain('Docker build:')
    })

    it('should list the slowest tests first, capped at five', () => {
      const results = [10, 50, 20, 5, 40, 30].map((secs, i) =>
        result({ name: `t${i}`, durationMs: secs * 1000 })
      )

      const { markdown } = buildSummary({ results })
      const slowSection = markdown.slice(markdown.indexOf('### Slowest'))

      expect(slowSection).toBe(
        [
          '### Slowest Journey Tests',
          '',
          '| Test | Duration |',
          '|---|---|',
          '| t1 | 50s |',
          '| t4 | 40s |',
          '| t5 | 30s |',
          '| t2 | 20s |',
          '| t0 | 10s |',
          ''
        ].join('\n')
      )
    })

    it('should omit the slowest section when there are no timed results', () => {
      const { markdown } = buildSummary({
        results: [result({ durationMs: null })]
      })

      expect(markdown).not.toContain('### Slowest')
    })
  })

  describe('writeCommentFile', () => {
    it('should write the markdown to the given path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'allure-'))
      tmpDirs.push(dir)
      const file = join(dir, 'comment.md')

      writeCommentFile(file, '## hello')

      expect(readFileSync(file, 'utf8')).toBe('## hello')
    })

    it('should do nothing when no path is given', () => {
      expect(() => writeCommentFile(undefined, '## hello')).not.toThrow()
    })
  })
})
