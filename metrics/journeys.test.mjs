import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AWAITING_INSTRUMENTATION, JOURNEYS } from './journeys.mjs'

// The frontend is symlinked in for local development but is not present in CI,
// so this checks what it can when it can. A rename there is the failure worth
// catching: the dashboard would query a metric nobody emits any more, and
// Grafana renders that as zero rather than as an error.
const CONSTANTS = fileURLToPath(
  new URL(
    '../lib/epr-frontend/src/server/common/helpers/metrics/constants.js',
    import.meta.url
  )
)

const emittedValues = async () => {
  const { JOURNEY } = await import(CONSTANTS)

  return Object.values(JOURNEY).flatMap((journey) => Object.values(journey))
}

describe.runIf(existsSync(CONSTANTS))('#journeys against the frontend', () => {
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
