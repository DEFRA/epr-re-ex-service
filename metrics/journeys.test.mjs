describe('#journeys', () => {
  it('should attribute every journey to a known service', () => {
    const unknown = JOURNEYS.map(({ service }) => service).filter(
      (service) => !SERVICES[service]
    )

    expect(unknown).toStrictEqual([])
  })

  it('should resolve a service to the namespace it publishes under', () => {
    expect(namespaceFor('frontend')).toBe('epr-frontend')
  })

  it('should refuse a service it does not know', () => {
    expect(() => namespaceFor('nope')).toThrow(/nope/)
  })

  // The overlay has to state each namespace as a literal, so it is the one place
  // these can drift out of step with the registry -- and the symptom would be a
  // dashboard quietly reading zero.
  it('should agree with the namespaces the metrics overlay sets', () => {
    const overlay = readFileSync(fromRepoRoot('compose.metrics.yml'), 'utf8')

    const missing = Object.values(SERVICES)
      .map(({ namespace }) => namespace)
      .filter((namespace) => !overlay.includes(`:-${namespace}}`))

    expect(missing).toStrictEqual([])
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  AWAITING_INSTRUMENTATION,
  JOURNEYS,
  SERVICES,
  namespaceFor
} from './journeys.mjs'

const fromRepoRoot = (relative) =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

// The frontend is symlinked in for local development but is not present in CI,
// so this checks what it can when it can. A rename there is the failure worth
// catching: the dashboard would query a metric nobody emits any more, and
// Grafana renders that as zero rather than as an error.
// Only services that declare their journey names in code can be checked. The
// others are in the registry so the machinery supports them, not because they
// have journeys yet.
const declared = Object.entries(SERVICES)
  .filter(([, { constants }]) => constants)
  .map(([service, { constants }]) => [service, fromRepoRoot(constants)])

const emittedValues = async () => {
  const modules = await Promise.all(declared.map(([, path]) => import(path)))

  return modules.flatMap(({ JOURNEY }) =>
    Object.values(JOURNEY).flatMap((journey) => Object.values(journey))
  )
}

// Symlinked in for local development but absent in CI, so this checks what it
// can when it can.
const available = declared.every(([, path]) => existsSync(path))

describe.runIf(available)('#journeys against the services', () => {
  it('should only chart dimension values the frontend emits', async () => {
    const emitted = await emittedValues()
    const charted = JOURNEYS.flatMap(({ start, end }) => [start, end])

    expect(
      charted.filter(
        (value) =>
          !emitted.includes(value) && !AWAITING_INSTRUMENTATION.includes(value)
      )
    ).toStrictEqual([])
  })

  it('should not hold back values the frontend already emits', async () => {
    const emitted = await emittedValues()

    expect(
      AWAITING_INSTRUMENTATION.filter((value) => emitted.includes(value))
    ).toStrictEqual([])
  })
})
