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

  it.for([
    { section: 'dependencies', range: '~1.2.3' },
    { section: 'devDependencies', range: '^2.0.0' },
    { section: 'optionalDependencies', range: '~3.0.0' },
    { section: 'peerDependencies', range: '^4.0.0' }
  ])('should flag $range in $section', ({ section, range }) => {
    const pkg = { [section]: { foo: range } }
    expect(findUnpinned(pkg)).toEqual([{ section, name: 'foo', range }])
  })

  it('should ignore engines even with caret ranges', () => {
    const pkg = { engines: { node: '^24.10.0' } }
    expect(findUnpinned(pkg)).toEqual([])
  })

  it('should flag caret ranges in flat overrides', () => {
    const pkg = { overrides: { 'follow-redirects': '^1.16.0' } }
    expect(findUnpinned(pkg)).toEqual([
      { section: 'overrides', name: 'follow-redirects', range: '^1.16.0' }
    ])
  })

  it('should recurse into nested overrides', () => {
    const pkg = {
      overrides: {
        foo: {
          bar: '^1.0.0'
        }
      }
    }
    expect(findUnpinned(pkg)).toEqual([
      { section: 'overrides', name: 'foo > bar', range: '^1.0.0' }
    ])
  })
})
