#!/usr/bin/env node
/**
 * Seed script for local JMeter performance testing
 *
 * Creates 50 test organisations matching the testinput.csv file used by JMeter.
 * Each organisation is created in ACTIVE status with an approved registration
 * and accreditation, ready for summary log uploads.
 *
 * Usage:
 *   node scripts/seed-perf-test-data.mjs [options]
 *
 * Options:
 *   --mongo-uri=<uri>  MongoDB URI (default: mongodb://localhost:27017/)
 *   --csv=<path>       Path to testinput.csv (auto-detected from epr-frontend-performance-tests)
 *   --dry-run          Show what would be inserted without actually inserting
 *   --force            Delete existing perf test orgs and re-seed
 */

import { MongoClient, ObjectId } from 'mongodb'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const COLLECTION_NAME = 'epr-organisations'
const DATABASE_NAME = 'epr-backend'

// Performance test organisations use orgId starting from 900000
// to distinguish from regular seed data (500000 range)
const PERF_TEST_ORG_ID_BASE = 900000

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = {
    mongoUri: 'mongodb://localhost:27017/',
    csvPath: null,
    dryRun: false,
    force: false
  }

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--mongo-uri=')) {
      args.mongoUri = arg.slice('--mongo-uri='.length)
    } else if (arg.startsWith('--csv=')) {
      args.csvPath = arg.slice('--csv='.length)
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--force') {
      args.force = true
    }
  }

  return args
}

/**
 * Find the testinput.csv file
 */
function findCsvPath(providedPath) {
  if (providedPath) {
    if (existsSync(providedPath)) {
      return providedPath
    }
    throw new Error(`CSV file not found: ${providedPath}`)
  }

  // Try common locations
  const candidates = [
    resolve(__dirname, '../../epr-frontend-performance-tests/main/scenarios/testinput.csv'),
    resolve(__dirname, '../../../epr-frontend-performance-tests/main/scenarios/testinput.csv'),
    '/Users/graemefoster/Development/Defra/epr-frontend-performance-tests/main/scenarios/testinput.csv'
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    'Could not find testinput.csv. Please provide path via --csv=<path>\n' +
    'Expected location: epr-frontend-performance-tests/main/scenarios/testinput.csv'
  )
}

/**
 * Parse the CSV file
 * @returns {Array<{orgId: string, regId: string, userOrgId: string, userEmail: string, userFirstName: string, userLastName: string, filename: string}>}
 */
function parseCsv(csvPath) {
  const content = readFileSync(csvPath, 'utf-8')
  const lines = content.trim().split('\n')
  const header = lines[0].split(',')

  const records = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = line.split(',')
    const record = {}
    for (let j = 0; j < header.length; j++) {
      record[header[j]] = values[j]
    }
    records.push(record)
  }

  return records
}

/**
 * Build a complete organisation document ready for MongoDB insert
 */
function buildPerfTestOrganisation(record, index) {
  const now = new Date().toISOString()
  const validFrom = new Date().toISOString().slice(0, 10)
  const validTo = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const accreditationId = new ObjectId().toString()

  return {
    _id: new ObjectId(record.orgId),
    orgId: PERF_TEST_ORG_ID_BASE + index,
    schemaVersion: 1,
    version: 1,
    status: 'active',
    statusHistory: [
      { status: 'created', updatedAt: now },
      { status: 'approved', updatedAt: now },
      { status: 'active', updatedAt: now }
    ],
    wasteProcessingTypes: ['reprocessor'],
    reprocessingNations: ['england'],
    businessType: 'limited_company',
    submittedToRegulator: 'environment_agency',
    formSubmissionTime: now,
    submitterContactDetails: {
      fullName: `${record.userFirstName} ${record.userLastName}`,
      email: record.userEmail,
      jobTitle: 'Manager',
      phone: '0123456789'
    },
    linkedDefraOrganisation: {
      orgId: record.userOrgId,
      orgName: `Perf Test Org ${index + 1}`,
      linkedBy: {
        email: record.userEmail,
        id: record.userOrgId
      },
      linkedAt: now
    },
    users: [
      {
        email: record.userEmail,
        fullName: `${record.userFirstName} ${record.userLastName}`,
        roles: ['standard_user']
      }
    ],
    registrations: [
      {
        id: record.regId,
        status: 'approved',
        statusHistory: [
          { status: 'created', updatedAt: now },
          { status: 'approved', updatedAt: now }
        ],
        registrationNumber: `REG-${PERF_TEST_ORG_ID_BASE + index}-001`,
        cbduNumber: `CBDU${String(index + 1).padStart(6, '0')}`,
        submittedToRegulator: 'environment_agency',
        orgName: `Perf Test Org ${index + 1}`,
        formSubmissionTime: now,
        site: {
          address: {
            line1: `${index + 1} Performance Test Road`,
            town: 'London',
            postcode: `SW1A ${String(index % 100).padStart(2, '0')}A`
          },
          gridReference: String(100000 + index),
          siteCapacity: [
            {
              material: 'paper',
              siteCapacityInTonnes: 1000,
              siteCapacityTimescale: 'yearly'
            }
          ]
        },
        material: 'paper',
        wasteProcessingType: 'reprocessor',
        reprocessingType: 'input',
        glassRecyclingProcess: null,
        accreditationId,
        wasteManagementPermits: [
          {
            type: 'environmental_permit',
            permitNumber: `WML${String(index + 1).padStart(6, '0')}`,
            authorisedMaterials: [
              {
                material: 'paper',
                authorisedWeightInTonnes: 1000,
                timeScale: 'yearly'
              }
            ]
          }
        ],
        approvedPersons: [
          {
            fullName: `${record.userFirstName} ${record.userLastName}`,
            email: record.userEmail,
            jobTitle: 'Manager',
            phone: '0123456789'
          }
        ],
        suppliers: 'Local suppliers',
        plantEquipmentDetails: 'Standard processing equipment',
        yearlyMetrics: [
          {
            year: new Date().getFullYear(),
            input: {
              type: 'actual',
              ukPackagingWasteInTonnes: 500,
              nonUkPackagingWasteInTonnes: 50,
              nonPackagingWasteInTonnes: 25
            },
            rawMaterialInputs: [
              {
                material: 'Waste paper',
                weightInTonnes: 500
              }
            ],
            output: {
              type: 'actual',
              sentToAnotherSiteInTonnes: 10,
              contaminantsInTonnes: 5,
              processLossInTonnes: 5
            },
            productsMadeFromRecycling: [
              {
                name: 'Recycled cardboard',
                weightInTonnes: 480
              }
            ]
          }
        ],
        submitterContactDetails: {
          fullName: `${record.userFirstName} ${record.userLastName}`,
          email: record.userEmail,
          jobTitle: 'Manager',
          phone: '0123456789'
        },
        samplingInspectionPlanPart1FileUploads: [],
        validFrom,
        validTo
      }
    ],
    accreditations: [
      {
        id: accreditationId,
        status: 'approved',
        statusHistory: [
          { status: 'created', updatedAt: now },
          { status: 'approved', updatedAt: now }
        ],
        accreditationNumber: `ACC-${PERF_TEST_ORG_ID_BASE + index}-001`,
        formSubmissionTime: now,
        submittedToRegulator: 'environment_agency',
        orgName: `Perf Test Org ${index + 1}`,
        site: {
          address: {
            line1: `${index + 1} Performance Test Road`,
            town: 'London',
            postcode: `SW1A ${String(index % 100).padStart(2, '0')}A`
          }
        },
        material: 'paper',
        glassRecyclingProcess: null,
        wasteProcessingType: 'reprocessor',
        reprocessingType: 'input',
        prnIssuance: {
          tonnageBand: 'up_to_10000',
          signatories: [
            {
              fullName: `${record.userFirstName} ${record.userLastName}`,
              email: record.userEmail,
              jobTitle: 'PRN signatory',
              phone: '0123456789'
            }
          ],
          incomeBusinessPlan: [
            {
              usageDescription: 'New reprocessing infrastructure and maintaining existing infrastructure',
              detailedExplanation: 'Infrastructure investment',
              percentIncomeSpent: 100
            }
          ]
        },
        submitterContactDetails: {
          fullName: `${record.userFirstName} ${record.userLastName}`,
          email: record.userEmail,
          jobTitle: 'PRN signatory',
          phone: '0123456789'
        },
        samplingInspectionPlanPart2FileUploads: [],
        validFrom,
        validTo
      }
    ],
    companyDetails: {
      name: `Perf Test Org ${index + 1}`,
      tradingName: `Perf Test ${index + 1}`,
      companiesHouseNumber: `PT${String(index + 1).padStart(6, '0')}`,
      registeredAddress: {
        line1: `${index + 1} Performance Test Road`,
        town: 'London',
        postcode: `SW1A ${String(index % 100).padStart(2, '0')}A`
      }
    }
  }
}

async function main() {
  const args = parseArgs()

  console.log('Performance Test Data Seeding')
  console.log('=============================\n')

  // Find and parse CSV
  const csvPath = findCsvPath(args.csvPath)
  console.log(`Reading CSV: ${csvPath}`)
  const records = parseCsv(csvPath)
  console.log(`Found ${records.length} test users\n`)

  if (args.dryRun) {
    console.log('DRY RUN - showing first 3 organisations that would be created:\n')
    for (let i = 0; i < Math.min(3, records.length); i++) {
      const org = buildPerfTestOrganisation(records[i], i)
      console.log(`Organisation ${i + 1}:`)
      console.log(`  _id: ${org._id}`)
      console.log(`  orgId: ${org.orgId}`)
      console.log(`  status: ${org.status}`)
      console.log(`  user: ${org.users[0].email}`)
      console.log(`  linkedDefraOrg: ${org.linkedDefraOrganisation.orgId}`)
      console.log(`  registration: ${org.registrations[0].id}`)
      console.log()
    }
    console.log(`... and ${records.length - 3} more organisations`)
    return
  }

  // Connect to MongoDB
  console.log(`Connecting to MongoDB: ${args.mongoUri}`)
  const client = new MongoClient(args.mongoUri)

  try {
    await client.connect()
    const db = client.db(DATABASE_NAME)
    const collection = db.collection(COLLECTION_NAME)

    // Check for existing perf test orgs
    const existingCount = await collection.countDocuments({
      orgId: { $gte: PERF_TEST_ORG_ID_BASE, $lt: PERF_TEST_ORG_ID_BASE + 1000 }
    })

    if (existingCount > 0) {
      if (args.force) {
        console.log(`Deleting ${existingCount} existing perf test organisations...`)
        await collection.deleteMany({
          orgId: { $gte: PERF_TEST_ORG_ID_BASE, $lt: PERF_TEST_ORG_ID_BASE + 1000 }
        })
      } else {
        console.log(`Found ${existingCount} existing perf test organisations.`)
        console.log('Use --force to delete and re-seed, or --dry-run to preview.')
        return
      }
    }

    // Build and insert organisations
    console.log(`\nCreating ${records.length} organisations...`)
    const organisations = records.map((record, index) =>
      buildPerfTestOrganisation(record, index)
    )

    const result = await collection.insertMany(organisations)
    console.log(`\nInserted ${result.insertedCount} organisations`)

    // Verify
    const finalCount = await collection.countDocuments({
      orgId: { $gte: PERF_TEST_ORG_ID_BASE, $lt: PERF_TEST_ORG_ID_BASE + 1000 }
    })
    console.log(`Verification: ${finalCount} perf test organisations in database`)

    console.log('\nSeeding complete!')
    console.log('\nNext steps:')
    console.log('1. Ensure Defra ID Stub recognises the test user emails')
    console.log('   (the stub auto-accepts any email by default)')
    console.log('2. Run JMeter tests:')
    console.log('   cd epr-frontend-performance-tests/main')
    console.log('   jmeter -n -t scenarios/epr-frontend-test.jmx \\')
    console.log('     -Jdomain=localhost -Jport=3000 -Jprotocol=http')

  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('Error:', error.message)
  process.exit(1)
})
