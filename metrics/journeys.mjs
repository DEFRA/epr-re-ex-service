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
 * Dimension values the dashboard charts but no service emits yet, so a panel
 * reading zero is expected rather than broken. Remove an entry as its journey
 * lands; the tests fail either way round, so the list cannot quietly rot.
 * @type {string[]}
 */
export const AWAITING_INSTRUMENTATION = []

/**
 * `outcome` is what reaching the end of this journey means in the operator's
 * words, for panels that show a start and an end as two labelled figures.
 * @typedef {{ end: string, outcome: string, service: string, start: string, title: string }} Journey
 */

/**
 * Order is the order the dashboard table reads in. Uploading a summary log
 * leads because it is what the others depend on -- it is the summary log that
 * builds the waste balance a note is issued against and a report declares, so a
 * fall in its completion rate explains a fall in theirs.
 * @type {Journey[]}
 */
export const JOURNEYS = [
  {
    service: 'frontend',
    title: 'Upload and submit a summary log',
    start: 'UploadSummaryLogStart',
    end: 'UploadSummaryLogEnd',
    outcome: 'Uploaded'
  },
  {
    service: 'frontend',
    title: 'Create a PRN/PERN',
    start: 'SaveOrIssuePRNPERNStart',
    end: 'SaveDraftPRNPERNEnd',
    outcome: 'Saved as draft'
  },
  {
    service: 'frontend',
    title: 'Issue a PRN/PERN',
    start: 'IssuePRNPERNStart',
    end: 'IssuePRNPERNEnd',
    outcome: 'Issued'
  },
  {
    service: 'frontend',
    title: 'Create a report',
    start: 'SaveOrSubmitReportStart',
    end: 'SaveDraftReportEnd',
    outcome: 'Saved as draft'
  },
  {
    service: 'frontend',
    title: 'Submit a report',
    start: 'SubmitReportStart',
    end: 'SubmitReportEnd',
    outcome: 'Submitted'
  }
]
