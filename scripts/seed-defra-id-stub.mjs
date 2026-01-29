#!/usr/bin/env node
/**
 * Seeds the Defra ID stub with test user linked to seeded organisation
 *
 * This script automates the manual steps required to log in locally:
 * 1. Queries MongoDB for the seeded active organisation's DefraId UUID
 * 2. Registers a test user in the Defra ID stub with that organisation
 *
 * Prerequisites:
 * - Services must be running (npm run dev)
 * - Backend must have seeded data (wait for "Seed scenarios: created" logs)
 */
import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017'
const STUB_URL = process.env.DEFRA_ID_STUB_URL || 'http://localhost:3200'
const TESTER_EMAIL = process.env.SEED_TESTER_EMAIL || 'tester@example.com'
const ACTIVE_ORG_ID = 50030

async function main() {
  const client = new MongoClient(MONGO_URI)

  try {
    await client.connect()
    const db = client.db('epr-backend')

    // Get the seeded active organisation
    const org = await db.collection('epr-organisations').findOne(
      { orgId: ACTIVE_ORG_ID },
      { projection: { 'linkedDefraOrganisation.orgId': 1, 'companyDetails.name': 1 } }
    )

    if (!org?.linkedDefraOrganisation?.orgId) {
      console.error('Active organisation not seeded yet. Wait for backend to start.')
      process.exit(1)
    }

    const payload = {
      userId: crypto.randomUUID(),
      email: TESTER_EMAIL,
      firstName: 'Test',
      lastName: 'User',
      loa: '1',
      aal: '1',
      enrolmentCount: 1,
      enrolmentRequestCount: 1,
      relationships: [{
        // Note: stub has a bug where it uses relationshipId as organisationId
        relationshipId: org.linkedDefraOrganisation.orgId,
        organisationName: org.companyDetails?.name || 'Test Organisation',
        relationshipRole: 'Employee'
      }]
    }

    const response = await fetch(
      `${STUB_URL}/cdp-defra-id-stub/API/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    )

    if (!response.ok) {
      throw new Error(`Stub API error: ${response.status}`)
    }

    console.log(`Registered ${TESTER_EMAIL} with org ${org.linkedDefraOrganisation.orgId}`)
    console.log(`Visit http://localhost:3000 and click "Start now" to log in`)

  } finally {
    await client.close()
  }
}

main().catch(console.error)
