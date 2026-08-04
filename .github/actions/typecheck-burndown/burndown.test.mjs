import { describe, expect, it } from 'vitest'

import {
  buildBurndown,
  categorise,
  countErrors,
  leversFromConfigs
} from './burndown.mjs'

describe('typecheck burndown', () => {
  describe(leversFromConfigs, () => {
    it('should return flags true in strict but not in base', () => {
      const base = JSON.stringify({
        compilerOptions: { strictNullChecks: true, noUnusedLocals: true }
      })
      const strict = JSON.stringify({
        compilerOptions: {
          strictNullChecks: true,
          noUnusedLocals: true,
          noImplicitAny: true,
          strictFunctionTypes: true
        }
      })

      expect(leversFromConfigs(base, strict)).toStrictEqual([
        'noImplicitAny',
        'strictFunctionTypes'
      ])
    })

    it('should ignore non-boolean options like types and paths', () => {
      const base = JSON.stringify({ compilerOptions: {} })
      const strict = JSON.stringify({
        compilerOptions: {
          types: ['vitest/globals'],
          paths: { '#x/*': ['./x/*'] },
          noImplicitAny: true
        }
      })

      expect(leversFromConfigs(base, strict)).toStrictEqual(['noImplicitAny'])
    })

    it('should tolerate a missing compilerOptions block', () => {
      expect(leversFromConfigs('{}', '{}')).toStrictEqual([])
    })
  })

  describe(countErrors, () => {
    it('should count each tsc error line once', () => {
      const output = [
        "src/a.js(1,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
        "src/b.js(2,3): error TS2532: Object is possibly 'undefined'.",
        'Found 2 errors in 2 files.'
      ].join('\n')

      expect(countErrors(output)).toBe(2)
    })

    it('should return 0 for clean output', () => {
      expect(countErrors('')).toBe(0)
    })
  })

  describe(categorise, () => {
    it('should be ready-all when both surfaces are clean', () => {
      expect(categorise({ prod: 0, tests: 0 })).toBe('ready-all')
    })

    it('should be ready-prod when only prod is clean', () => {
      expect(categorise({ prod: 0, tests: 5 })).toBe('ready-prod')
    })

    it('should be ready-tests when only tests is clean', () => {
      expect(categorise({ prod: 3, tests: 0 })).toBe('ready-tests')
    })

    it('should be chip when both surfaces have errors', () => {
      expect(categorise({ prod: 3, tests: 5 })).toBe('chip')
    })
  })

  describe(buildBurndown, () => {
    const results = [
      { lever: 'noImplicitThis', prod: 0, tests: 0 },
      { lever: 'noImplicitAny', prod: 409, tests: 1916 },
      { lever: 'strictFunctionTypes', prod: 10, tests: 11 },
      { lever: 'noUnusedLocals', prod: 0, tests: 4 }
    ]

    it('should list ready-all levers under the enforce-everywhere heading', () => {
      const { markdown } = buildBurndown(results)

      expect(markdown).toContain('Ready to enforce everywhere')
      expect(markdown).toContain('`noImplicitThis`')
    })

    it('should list ready-prod levers with their tests remainder', () => {
      const { markdown } = buildBurndown(results)

      expect(markdown).toContain('Ready for prod')
      expect(markdown).toContain('`noUnusedLocals`')
    })

    it('should rank chip-away levers by fewest remaining first', () => {
      const { markdown } = buildBurndown(results)

      expect(markdown.indexOf('strictFunctionTypes')).toBeLessThan(
        markdown.indexOf('noImplicitAny')
      )
    })

    it('should note that marginals do not sum', () => {
      const { markdown } = buildBurndown(results)

      expect(markdown).toContain('interact')
    })

    it('should link to the run when a runUrl is given', () => {
      const { markdown } = buildBurndown(results, {
        runUrl: 'https://github.com/o/r/actions/runs/1'
      })

      expect(markdown).toContain('https://github.com/o/r/actions/runs/1')
    })
  })
})
