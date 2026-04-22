import { describe, it, expect } from 'vitest'
import { findUnpinned } from './check-pins.mjs'

describe('findUnpinned', () => {
  it('should return an empty array for a package with only exact versions', () => {
    const pkg = {
      dependencies: { foo: '1.2.3' },
      devDependencies: { bar: '4.5.6' }
    }
    expect(findUnpinned(pkg)).toEqual([])
  })

  it('should flag caret ranges in dependencies', () => {
    const pkg = { dependencies: { foo: '^1.2.3' } }
    expect(findUnpinned(pkg)).toEqual([
      { section: 'dependencies', name: 'foo', range: '^1.2.3' }
    ])
  })
})
