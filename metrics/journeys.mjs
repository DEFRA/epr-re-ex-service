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

export const NAMESPACE = 'epr-frontend'

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
 * @typedef {{ title: string, start: string, end: string }} Journey
 */

/** @type {Journey[]} */
export const JOURNEYS = [
  {
    title: 'Create a PRN/PERN',
    start: 'SaveOrIssuePRNPERNStart',
    end: 'SaveDraftPRNPERNEnd'
  },
  {
    title: 'Issue a PRN/PERN',
    start: 'IssuePRNPERNStart',
    end: 'IssuePRNPERNEnd'
  },
  {
    title: 'Create a report',
    start: 'SaveOrSubmitReportStart',
    end: 'SaveDraftReportEnd'
  },
  {
    title: 'Submit a report',
    start: 'SubmitReportStart',
    end: 'SubmitReportEnd'
  },
  {
    title: 'Upload and submit a summary log',
    start: 'UploadSummaryLogStart',
    end: 'UploadSummaryLogEnd'
  }
]
