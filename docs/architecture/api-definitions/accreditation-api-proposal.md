# Proposal: an accreditation API for Reg Accred to serve REEX

Date: 2026-10-27
Status: Draft proposal for the Reg Accred team
Relates to: PAE-2142; ADR-0034 (multi-year accreditation model), ADR-0051 (status as a dated timeline), ADR-0052 (organisation read model), ADR-0053 (address resources by natural key and year) in `epr-re-ex-service/docs/architecture/decisions`

## Summary

REEX reads every accreditation through one port, whatever the year. For 2026 the port reads
REEX's own data. From 2027 it would call this API in Reg Accred. This proposal has the API serve an
accreditation in the shape REEX already uses: the `Accreditation` of the organisation read model
(ADR-0052). Then REEX's adapter passes the response through without mapping it.

REEX needs accreditations individually (for accreditation specific pages/functionality), across an
organisation (e.g. for an organisation's dashboard), and across multiple organisations (eg. public register).

This proposal starts with one endpoint, which serves one accreditation. Reads of multiple
accreditations can follow once the shape/auth strategy established with this proposal are agreed.

## Get one accreditation

```
GET /organisations/{organisationNumber}/registrations/{registrationNumber}/accreditations/{year}
```

| Parameter            | Description                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `organisationNumber` | The organisation's number, a positive integer                                                                              |
| `registrationNumber` | The registration's number, as issued when it was approved                                                                  |
| `year`               | The scheme year the accreditation covers, such as `2027`. A registration holds at most one accreditation a year (ADR-0034) |

The path addresses the accreditation by its domain keys, as REEX's own routes do (ADR-0053). It
carries no version. If the representation ever has to change in a way that isn't additive, the
client will ask for a new media type in the `Accept` header at the same address.

### Authentication

The endpoint uses HTTP basic authentication (RFC 7617). REEX sends the username and password Reg
Accred issues to it in the `Authorization` header on every request, over TLS. REEX holds them as
secrets in its configuration.

### Responses

| Status | When                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | The accreditation, in the shape below                                                                                             |
| `401`  | The credentials are missing or wrong                                                                                              |
| `404`  | No organisation has the number, the registration isn't that organisation's, or the registration has no accreditation for the year |

An error body is an RFC 9457 problem details object. REEX acts on the status code alone.

A `404` also covers an accreditation that is still an application, or was rejected or withdrawn.
REEX only reads accreditations that have been approved, so their status is `approved`,
`suspended` or `cancelled`.

### Response shape

The body is the read model's `Accreditation`, from `src/organisation-read-model/domain/model.js`
in `epr-backend`:

- **Common fields:** every accreditation has a number, its PRN issuance details and its status.
- **Exporter accreditations:** these also carry the overseas sites they're approved for, keyed by
  the registration's ORS id.
- **Taken from the registration:** material, processing type, site and regulator are left out,
  because REEX reads them from the registration.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://defra.gov.uk/epr/accreditation.schema.json",
  "title": "Accreditation",
  "oneOf": [
    { "$ref": "#/$defs/reprocessorAccreditation" },
    { "$ref": "#/$defs/exporterAccreditation" }
  ],
  "$defs": {
    "accreditationCommon": {
      "type": "object",
      "required": ["accreditationNumber", "prnIssuance", "status"],
      "properties": {
        "accreditationNumber": {
          "type": "string",
          "description": "The number issued when the accreditation was approved"
        },
        "prnIssuance": {
          "type": "object",
          "required": ["signatories", "tonnageBand"],
          "properties": {
            "signatories": {
              "type": "array",
              "description": "The people who may sign PRNs, in the order they were given",
              "items": { "$ref": "#/$defs/contact" }
            },
            "tonnageBand": {
              "type": "string",
              "description": "The tonnage of PRNs the operator plans to issue. Clients must handle a value they don't know",
              "examples": [
                "up_to_500",
                "up_to_5000",
                "up_to_10000",
                "over_10000"
              ]
            }
          }
        },
        "status": {
          "type": "object",
          "required": ["current", "timeline"],
          "properties": {
            "current": {
              "type": "string",
              "description": "The status today. Clients must handle a value they don't know",
              "examples": ["approved", "suspended", "cancelled"]
            },
            "timeline": {
              "type": "array",
              "description": "Every status change, oldest first. Changes at the same time keep the order they were recorded in (ADR-0051)",
              "items": {
                "type": "object",
                "required": ["status", "at"],
                "properties": {
                  "status": { "type": "string" },
                  "at": {
                    "type": "string",
                    "format": "date-time",
                    "description": "When the change took effect, as an ISO 8601 date-time"
                  }
                }
              }
            }
          }
        }
      }
    },
    "reprocessorAccreditation": {
      "allOf": [{ "$ref": "#/$defs/accreditationCommon" }],
      "not": { "required": ["overseasSites"] }
    },
    "exporterAccreditation": {
      "allOf": [{ "$ref": "#/$defs/accreditationCommon" }],
      "required": ["overseasSites"],
      "properties": {
        "overseasSites": {
          "type": "object",
          "description": "The registration's overseas sites, keyed by ORS id, each with its approval under this accreditation",
          "additionalProperties": { "$ref": "#/$defs/accreditedOverseasSite" }
        }
      }
    },
    "accreditedOverseasSite": {
      "oneOf": [
        {
          "type": "object",
          "required": ["status"],
          "properties": { "status": { "const": "pending" } }
        },
        {
          "type": "object",
          "required": ["status", "approvedOn"],
          "properties": {
            "status": { "const": "approved" },
            "approvedOn": {
              "type": "string",
              "format": "date",
              "description": "The day the site was approved, as an ISO 8601 date"
            }
          }
        }
      ]
    },
    "contact": {
      "type": "object",
      "required": ["email", "fullName"],
      "properties": {
        "email": { "type": "string", "format": "email" },
        "fullName": { "type": "string" },
        "phone": {
          "type": "string",
          "description": "Left out when the contact gave none"
        }
      }
    }
  }
}
```

Example: an exporter's 2027 accreditation, suspended in March.

```json
{
  "accreditationNumber": "A27ER5000000001PA",
  "prnIssuance": {
    "signatories": [{ "email": "sam@example.com", "fullName": "Sam Smith" }],
    "tonnageBand": "up_to_5000"
  },
  "status": {
    "current": "suspended",
    "timeline": [
      { "status": "created", "at": "2026-11-02T09:14:00.000Z" },
      { "status": "approved", "at": "2027-01-01T00:00:00.000Z" },
      { "status": "suspended", "at": "2027-03-18T15:40:00.000Z" }
    ]
  },
  "overseasSites": {
    "001": { "status": "approved", "approvedOn": "2027-01-10" },
    "002": { "status": "pending" }
  }
}
```

### Changing the shape later

Reg Accred can add fields at any time. REEX ignores fields it doesn't know, and handles status and
tonnage band values it doesn't know. Removing, renaming or reusing a field would break REEX. The
statuses and bands are open lists, so the schema gives the current values as examples rather
than as an `enum`.

## Gaps

These are the differences between this proposal and Reg Accred's draft spec
(`docs/openapi/registration-accreditation-api.yaml` in `epr-register-enrol-backend`,
v0.1.0-draft, commit `f329d4b`, 2026-10-15). The field-by-field comparison comes first, then
each gap in turn.

### Field by field

The draft column refers to the draft's `Accreditation` schema.

| This API                            | Reg Accred draft                                                                                                                                                     | Gap                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `year` in the path                  | `year` (integer, required)                                                                                                                                           | None                                                                   |
| `accreditationNumber`               | `accreditationReference` (string, required)                                                                                                                          | The name only                                                          |
| `status.current`                    | `status` (string, required, values not listed)                                                                                                                       | The values are unknown, and have no `suspended` or `cancelled` (gap 2) |
| `status.timeline`                   | Not served                                                                                                                                                           | Missing (gap 1)                                                        |
| `prnIssuance.tonnageBand`           | `prnIssuance.plannedIssuance` (string, nullable, values not listed). The application has `prns.plannedTonnageBand` (`UpTo500`, `UpTo5000`, `UpTo10000`, `Over10000`) | The source and values are unclear (gap 3)                              |
| `prnIssuance.signatories`           | `prnIssuance.signatories` (nullable list of `ContactDetails`)                                                                                                        | Can be null (gap 5)                                                    |
| Not served                          | `submitterContactDetails` (nullable `ContactDetails`)                                                                                                                | Not needed (gap 10)                                                    |
| `Contact.email`, `Contact.fullName` | `ContactDetails.email`, `.fullName` (both nullable)                                                                                                                  | Can be null (gap 5)                                                    |
| `Contact.phone`                     | `ContactDetails.phone` (nullable)                                                                                                                                    | None. This API leaves it out rather than sending null                  |
| Exporter `overseasSites`            | `overseasSites`: a list of ORS ids only. Approval (`selected`, `validFrom`) is on `.../accreditations/{year}/overseas-sites`, paged at 100 or fewer                  | The approval isn't on the accreditation (gap 4)                        |

### What the draft doesn't serve yet

1. **The status timeline.** The draft serves only the current status. REEX reads an
   accreditation's status on a given date: to classify waste records, to work out which monthly
   reports are owed, and to check for suspension before a PRN is issued or a waste balance
   changes (ADR-0051).
2. **The suspended and cancelled statuses.** The draft's status values aren't listed. The
   application lifecycle it comes from (`Saved` … `Approved`, `Rejected`, `Withdrawn`) has no
   `suspended` or `cancelled`. So it isn't clear how a suspension or cancellation of an approved
   accreditation is recorded.
3. **The tonnage band.** It isn't clear whether `prnIssuance.plannedIssuance` or the application's
   `prns.plannedTonnageBand` carries the band, or whether its values map to the four above.
4. **Overseas site approvals.** For an exporter, the draft lists only ORS ids on the
   accreditation. Approval is on a separate, paged sub-resource, which would mean one or more extra
   calls for every exporter accreditation.

### What the draft allows to be missing

5. **Contacts.** The draft allows `prnIssuance.signatories`, and a contact's `email` and
   `fullName`, to be null. On an approved accreditation, REEX needs all of
   them. Today REEX leaves out, and logs, any accreditation that lacks one.

### What isn't decided

6. **Authentication.** The draft says "no authentication scheme is defined yet". This proposal
   asks for basic authentication, with credentials Reg Accred issues to REEX.
7. **The 404 cases.** The draft uses the same path, but its last segment also takes a 12-character
   reference. REEX uses the year form only, and needs the cases in the table above to return
   `404`.
8. **Where 2027 data comes from.** The draft builds the accreditation from the organisation model,
   joined to the approved application for its year and reference. It isn't clear which of the two
   is the record of truth once an accreditation is approved.

### Where the models conflict

9. **One accreditation a year.** The draft's `Registration` has a single `accreditationReference`.
   A registration holds one accreditation each year (ADR-0034), so one reference can't link it to
   both its 2026 and 2027 accreditations. This endpoint doesn't need that field, but the models
   need to agree.

### Served but not needed

10. **Fields REEX doesn't read.** The draft's accreditation also carries fields REEX doesn't need. Highlighting here for completeness.

- `material`, `glassRecyclingProcess`, `wasteProcessingType` and `siteAddress`, which REEX
  reads from the registration;
- `contactDetails` and `submitterContactDetails`;
- `businessPlan` and `prnIssuance.prnIncomeBusinessPlan`;
- `recyclingProcess`, `samplingInspectionPlan` and `formSubmissionTime`.

### Other questions for Reg Accred

11. **Registration numbers.** A registration number can be regenerated
    (`PreviousRegistrationNumbers`). Can that happen after the registration is approved? This
    endpoint is addressed by the registration number, and REEX keys its own data by registration
    and accreditation numbers (ADR-0053).
12. **Records without numbers.** `RegistrationReference` and `OrgId` are nullable on the
    application. Will the API leave out records that lack them, as REEX does for records that
    have no number?
13. **Lookups.** Lookups by organisation number and registration number aren't indexed on Reg
    Accred's side. REEX will call this endpoint for each accreditation it reads, so these lookups
    need to be fast.

### Open question for REEX

14. **Which shape an accreditation has.** The response doesn't say whether the accreditation
    belongs to a reprocessor or an exporter. The read model doesn't need to say, because the
    registration it sits under does. A client of this endpoint alone can only tell from whether
    `overseasSites` is present. Adding `wasteProcessingType` would make the two shapes explicit,
    but it would depart from the read model.
15. **Approved at point in year.** REEX only cares about accreditations that were approved for at least part of the year. Is filtering these from the response a Reg Accred or a REEX concern?

## Sources

- `epr-register-enrol-backend` (main, 2026-10-21):
  - `docs/openapi/registration-accreditation-api.yaml`
  - `docs/openapi/registration-accreditation-api.mapping.md`
  - `EprRegisterEnrolBackend/AccreditationApplication/Models/AccreditationApplicationModel.cs`
- `epr-backend`:
  - `src/organisation-read-model/domain/model.js` (the response shape, without
    `submitterContactDetails` from DEFRA/epr-backend#1949)
  - `src/organisation-read-model/repository/adapter.js` (how REEX builds it today)
  - `src/domain/organisations/model.js` (`TONNAGE_BAND`)
