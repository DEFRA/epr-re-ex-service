import { describe, it, expect } from 'vitest'
import { isAutomatedBranch, parseBranch } from './check-branch.mjs'

describe('check-branch', () => {
  describe('parse-branch', () => {
    it.each([
      ['PAE-1234-add-delete-report-link', 'PAE-1234', 'jira'],
      ['PAE-000-tidy-up', 'PAE-000', 'jira'],
      ['PAE-1234_add_delete_report_link', 'PAE-1234', 'jira'],
      ['pae-1234-lowercase-key', 'PAE-1234', 'jira'],
      ['ADR-0027-branch-name-check', 'ADR-0027', 'adr'],
      ['adr-27-short-number', 'ADR-27', 'adr'],
      ['ADR-0027_underscore_separator', 'ADR-0027', 'adr']
    ])('should accept %s as %s of kind %s', (branchName, key, kind) => {
      expect(parseBranch(branchName)).toStrictEqual({ key, kind })
    })

    it.each([
      ['ADR-0027'],
      ['PAE-1234'],
      ['PAE-1234-'],
      ['PAE-add-delete-report-link'],
      ['ADR-branch-name-check'],
      ['ADRIAN-0027-not-an-adr'],
      ['feature/PAE-1234-nested'],
      ['main'],
      ['']
    ])('should reject %s', (branchName) => {
      expect(parseBranch(branchName)).toBeNull()
    })
  })

  describe('is-automated-branch', () => {
    it.each([
      ['dependabot/npm_and_yarn/vitest-4.1.10'],
      ['renovate/node-24.x'],
      ['revert-410-PAE-1791-reapply-link'],
      ['snyk-fix-a1b2c3']
    ])('should treat %s as automated', (branchName) => {
      expect(isAutomatedBranch({ branchName, actor: 'someone' })).toBe(true)
    })

    it.each([['dependabot[bot]'], ['renovate[bot]']])(
      'should treat any branch from %s as automated',
      (actor) => {
        expect(
          isAutomatedBranch({ branchName: 'not-a-valid-branch', actor })
        ).toBe(true)
      }
    )

    it.each([
      ['PAE-1234-add-delete-report-link'],
      ['ADR-0027-branch-name-check'],
      ['dependabot-but-not-really'],
      ['reverted-by-hand']
    ])('should not treat %s as automated', (branchName) => {
      expect(isAutomatedBranch({ branchName, actor: 'someone' })).toBe(false)
    })
  })
})
