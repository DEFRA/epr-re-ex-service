// The customer journeys behind the mandatory GDS KPIs, as agreed on PAE-1781.
//
// Each has exactly one start and one end so that completion rate is end over
// start and abandons are start minus end, with nothing double counted. Creating
// a note and issuing it are separate journeys because they are separate trips:
// every issued note has already been through created, so treating them as two
// endings of one journey would give one start and two ends.
//
// The dimension values are the agreed names and are what the dashboard's series
// labels are built from, so they must match what the frontend emits.

export const TRANSACTION_START = 'TransactionStart'
export const TRANSACTION_END = 'TransactionEnd'

/**
 * The services that emit custom metrics, and the CloudWatch namespace each
 * publishes under. The local metrics overlay sets the same namespaces, and
 * journeys.test.mjs holds the two in step.
 *
 * A journey names its service rather than assuming the frontend, so a dashboard
 * can draw a row from more than one -- which is how the operational dashboard
 * this row joins is already organised: by concern, not by service.
 */
/** @type {Record<string, { namespace: string, constants?: string }>} */
export const SERVICES = Object.freeze({
  frontend: Object.freeze({
    namespace: 'epr-frontend',
    constants: 'lib/epr-frontend/src/server/common/helpers/metrics/constants.js'
  }),
  backend: Object.freeze({ namespace: 'epr-backend' }),
  admin: Object.freeze({ namespace: 'epr-re-ex-admin-frontend' })
})

/**
 * @param {string} service
 * @returns {string}
 */
export const namespaceFor = (service) => {
  const known = SERVICES[service]

  if (!known) {
    throw new Error(`unknown service '${service}'`)
  }

  return known.namespace
}

/**
 * Dimension values the dashboard charts but the frontend does not emit yet.
 * Creating a note and issuing it turned out to be separate journeys rather than
 * two endings of one, which needs two start events that were not in the names
 * agreed on PAE-1781 -- so the dashboard is built for them ahead of the
 * instrumentation. Remove an entry as its journey lands.
 * @type {string[]}
 */
export const AWAITING_INSTRUMENTATION = [
  'IssuePRNPERNStart',
  'SubmitReportStart'
]

/**
 * @typedef {{ service: string, title: string, start: string, end: string }} Journey
 */

/** @type {Journey[]} */
export const JOURNEYS = [
  {
    service: 'frontend',
    title: 'Create a PRN/PERN',
    start: 'SaveOrIssuePRNPERNStart',
    end: 'SaveDraftPRNPERNEnd'
  },
  {
    service: 'frontend',
    title: 'Issue a PRN/PERN',
    start: 'IssuePRNPERNStart',
    end: 'IssuePRNPERNEnd'
  },
  {
    service: 'frontend',
    title: 'Create a report',
    start: 'SaveOrSubmitReportStart',
    end: 'SaveDraftReportEnd'
  },
  {
    service: 'frontend',
    title: 'Submit a report',
    start: 'SubmitReportStart',
    end: 'SubmitReportEnd'
  },
  {
    service: 'frontend',
    title: 'Upload and submit a summary log',
    start: 'UploadSummaryLogStart',
    end: 'UploadSummaryLogEnd'
  }
]
