import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildSummary, formatDuration, readResults } from './summary.mjs'

const result = (overrides) => ({
  name: 'a test',
  status: 'passed',
  start: 1000,
  stop: 2000,
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
    it('should extract only the top-level fields from each result file', () => {
      const dir = withResults({
        'a-result.json': result({ name: 'one', steps: [{ name: 'nested' }] })
      })

      expect(readResults(dir)).toEqual([
        { name: 'one', status: 'passed', start: 1000, stop: 2000 }
      ])
    })

    it('should ignore files that are not allure results', () => {
      const dir = withResults({
        'a-result.json': result({ name: 'kept' }),
        'categories.json': { irrelevant: true }
      })

      expect(readResults(dir).map((r) => r.name)).toEqual(['kept'])
    })

    it('should skip unparseable files rather than throwing', () => {
      const dir = withResults({
        'bad-result.json': '{ not valid json',
        'good-result.json': result({ name: 'good' })
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
        { name: 'deep', status: 'passed', start: 0, stop: 3000 }
      ])
    })

    it('should return an empty array when the directory is missing', () => {
      expect(readResults(join(tmpdir(), 'does-not-exist-allure'))).toEqual([])
    })
  })

  describe('buildSummary', () => {
    it('should count passed, failed and broken results', () => {
      const results = [
        result({ status: 'passed' }),
        result({ status: 'failed' }),
        result({ status: 'broken' }),
        result({ status: 'skipped' })
      ]

      const { markdown } = buildSummary({ results })

      expect(markdown).toContain('| Tests | 1 | 2 | 4 |')
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
        result({ name: `t${i}`, start: 0, stop: secs * 1000 })
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
        results: [result({ start: undefined, stop: undefined })]
      })

      expect(markdown).not.toContain('### Slowest')
    })
  })
})
