import { describe, it, expect } from 'vitest'
import { findUnpinned, scanFiles } from './check-pins.mjs'

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

  it.for([
    { kind: 'override $ref', value: '$eslint' },
    { kind: 'git url', value: 'git+https://github.com/user/repo.git#v1.0.0' },
    { kind: 'file path', value: 'file:../local-pkg' },
    { kind: 'npm alias', value: 'npm:lodash@4.17.21' },
    { kind: 'workspace', value: 'workspace:*' }
  ])('should not flag $kind values', ({ value }) => {
    const pkg = { dependencies: { foo: value } }
    expect(findUnpinned(pkg)).toEqual([])
  })
})

describe('scanFiles', () => {
  it('should tag each offender with its source file path', async () => {
    const files = {
      'a/package.json': JSON.stringify({ dependencies: { foo: '^1.0.0' } }),
      'b/package.json': JSON.stringify({ dependencies: { bar: '2.0.0' } })
    }
    const readFile = async (p) => files[p]
    expect(await scanFiles(['a/package.json', 'b/package.json'], readFile)).toEqual([
      {
        file: 'a/package.json',
        section: 'dependencies',
        name: 'foo',
        range: '^1.0.0'
      }
    ])
  })
})
