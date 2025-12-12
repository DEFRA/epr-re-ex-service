import { ORG_1_ID } from './constants'
import { fetchBackend } from './fetch-backend.ts'
;(async (): Promise<void> => {
  const payload = {
    organisation: {
      statusHistory: [
        {
          status: 'approved',
          updatedAt: new Date().toISOString()
        }
      ]
    }
  }

  const data = await fetchBackend(
    `/organisations/${ORG_1_ID}`,
    'PATCH',
    payload
  )

  console.log(
    '\n\nIf the status history does not include "approved", then it has failed to update'
  )
  console.log(
    'data.organisations.statusHistory',
    data.organisation.statusHistory
  )
})()
