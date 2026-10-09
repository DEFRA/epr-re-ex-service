import { describe, expect, it } from 'vitest'

import {
  compareJobs,
  failedResults,
  jobIds,
  parseList,
  workflowPathFromRef
} from './gate.mjs'

describe('pr-gate', () => {
  describe('jobIds', () => {
    it('should list every top-level job id', () => {
      const workflow = `
name: Check Pull Request
on:
  pull_request:
    branches:
      - '*'
jobs:
  pr-prep:
    name: Preparation
  test-and-scan:
    name: Test and Scan
`

      expect(jobIds(workflow)).toStrictEqual(['pr-prep', 'test-and-scan'])
    })

    it('should not mistake nested keys for jobs', () => {
      const workflow = `
on:
  pull_request:
    types:
      - opened
concurrency:
  group: x
jobs:
  only-job:
    name: Only Job
`

      expect(jobIds(workflow)).toStrictEqual(['only-job'])
    })

    it('should return an empty list when a workflow declares no jobs', () => {
      expect(jobIds('name: Nothing\n')).toStrictEqual([])
    })
  })

  describe('parseList', () => {
    it('should split a multi-line input into trimmed entries', () => {
      expect(parseList('test-journey\n  journey-tests\n')).toStrictEqual([
        'test-journey',
        'journey-tests'
      ])
    })

    it.each([undefined, '', '\n  \n'])(
      'should return an empty list for %j',
      (value) => {
        expect(parseList(value)).toStrictEqual([])
      }
    )
  })

  describe('workflowPathFromRef', () => {
    it('should strip the owner, repo and ref from a workflow ref', () => {
      const ref =
        'DEFRA/epr-backend/.github/workflows/check-pull-request.yml@refs/heads/main'

      expect(workflowPathFromRef(ref)).toBe(
        '.github/workflows/check-pull-request.yml'
      )
    })

    it('should keep a ref containing an @ in the branch name', () => {
      const ref =
        'DEFRA/epr-backend/.github/workflows/pr.yml@refs/heads/at@sign'

      expect(workflowPathFromRef(ref)).toBe('.github/workflows/pr.yml')
    })
  })

  describe('compareJobs', () => {
    const allJobs = [
      'pr-prep',
      'test-and-scan',
      'pr-checks',
      'typecheck-burndown'
    ]

    it('should report no drift when needs covers every non-excluded job', () => {
      const result = compareJobs({
        jobIds: allJobs,
        exclude: ['pr-checks', 'typecheck-burndown'],
        gated: ['pr-prep', 'test-and-scan']
      })

      expect(result).toStrictEqual({ missing: [], stale: [] })
    })

    it('should report a blocking job that is absent from needs', () => {
      const result = compareJobs({
        jobIds: [...allJobs, 'format-check'],
        exclude: ['pr-checks', 'typecheck-burndown'],
        gated: ['pr-prep', 'test-and-scan']
      })

      expect(result).toStrictEqual({ missing: ['format-check'], stale: [] })
    })

    it('should report a needs entry whose job no longer exists', () => {
      const result = compareJobs({
        jobIds: allJobs,
        exclude: ['pr-checks', 'typecheck-burndown'],
        gated: ['pr-prep', 'test-and-scan', 'deleted-job']
      })

      expect(result).toStrictEqual({ missing: [], stale: ['deleted-job'] })
    })

    it('should not treat an excluded job as missing', () => {
      const result = compareJobs({
        jobIds: allJobs,
        exclude: ['pr-checks', 'typecheck-burndown', 'test-and-scan'],
        gated: ['pr-prep']
      })

      expect(result).toStrictEqual({ missing: [], stale: [] })
    })
  })

  describe('failedResults', () => {
    it('should return an empty list when every job succeeded or skipped', () => {
      const results = {
        'pr-prep': { result: 'success' },
        'test-and-scan': { result: 'skipped' }
      }

      expect(failedResults(results)).toStrictEqual([])
    })

    it.each(['failure', 'cancelled'])(
      'should report a job whose result is %s',
      (result) => {
        expect(failedResults({ 'type-check-prod': { result } })).toStrictEqual([
          `type-check-prod=${result}`
        ])
      }
    )

    it('should report every failing job', () => {
      const results = {
        'pr-prep': { result: 'success' },
        'test-and-scan': { result: 'failure' },
        'type-check-tests': { result: 'cancelled' }
      }

      expect(failedResults(results)).toStrictEqual([
        'test-and-scan=failure',
        'type-check-tests=cancelled'
      ])
    })
  })
})
