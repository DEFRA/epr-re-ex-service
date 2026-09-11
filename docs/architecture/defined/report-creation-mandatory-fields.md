# Report Creation Mandatory Fields

This document describes the **report-creation completeness gate**: the rules that decide whether a Monthly Report can be created from a Summary Log. When any of these rules is unsatisfied, report creation is blocked and the operator is told which fields are missing.

## Overview

The gate runs at **report creation time**, not at Summary Log upload. It is separate from the row validation and Waste Balance classification rules described in [Summary Log Row Validation Classification](summary-log-row-validation-classification.md), and it answers a different question:

- **Row validation and classification** decide whether a row can be submitted and whether its tonnage counts towards the Waste Balance ("can this tonnage be counted?").
- **The report-creation gate** decides whether a Monthly Report can be created at all, based on regulatory completeness of contact and traceability details ("is this report complete enough to submit to the regulator?").

The two rule sets overlap on only a couple of fields (the overseas-site ID and the date of export) and diverge on the rest. They are kept deliberately separate: adding a report-mandatory contact field to the Waste Balance required set would drop the row's tonnage out of the balance, which is not the intent. A field being mandatory for report creation does not make it required for the Waste Balance, and vice versa.

## How the gate works

The gate checks the **whole Summary Log**, not only the rows that fall in the report's own reporting period. Each rule has:

- a **trigger** - a condition that decides whether the rule applies to a given row, and
- a set of **required fields** - fields that must all be filled when the trigger holds.

A rule contributes a violation for every unfilled required field on every row whose trigger holds, anywhere in the Summary Log. If there are no violations the report is created; otherwise creation is refused.

### Triggers

| Trigger          | Fires when                                                          |
| ---------------- | ------------------------------------------------------------------- |
| Positive tonnage | A tonnage field on the row holds a finite number greater than zero. |
| Answered "yes"   | A yes/no field on the row is answered "yes".                        |

A blank, non-numeric or zero tonnage does not fire the positive-tonnage trigger, so a row that reports no tonnage for a leg is not required to carry that leg's details.

## Rules

Each rule is identified by a stable reason code (the `requiredBy` code), which labels why its fields are mandatory. The gate reports the missing **field names**; the reason codes group the rules and are the intended breakdown key for reporting on completeness across live data.

| Rule (`requiredBy`) | Trigger                                                      | Required fields                                                                                                               |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `supplier_details`  | Positive received tonnage                                    | Supplier name, supplier address, supplier postcode, supplier email, supplier phone number, activities carried out by supplier |
| `final_destination` | Positive sent-on tonnage                                     | Final destination name, final destination facility type, final destination address, final destination postcode                |
| `overseas_site`     | Positive exported tonnage                                    | Overseas reprocessing site ID (OSR_ID)                                                                                        |
| `export_date`       | Positive exported tonnage                                    | Date of export                                                                                                                |
| `interim_site`      | "Did the waste pass through an interim site?" answered "yes" | Interim site ID                                                                                                               |

## Rules by template

Only the sections and rules relevant to each template apply. The three reprocessor templates carry no overseas-site, export-date or interim-site concepts, so those rules have no counterpart there.

| Template                        | `supplier_details` | `final_destination` | `overseas_site` | `export_date` | `interim_site` |
| ------------------------------- | :----------------: | :-----------------: | :-------------: | :-----------: | :------------: |
| Exporter (accredited)           |         ✅         |         ✅          |       ✅        |      ✅       |       ✅       |
| Exporter (registered only)      |         ✅         |         ✅          |       ✅        |      ✅       |       -        |
| Reprocessor input (accredited)  |         ✅         |         ✅          |        -        |       -       |       -        |
| Reprocessor output (accredited) |         ✅         |         ✅          |        -        |       -       |       -        |
| Reprocessor (registered only)   |         ✅         |         ✅          |        -        |       -       |       -        |

The accredited exporter template is the only one with an interim-site rule; the registered-only exporter template has no interim-site column and so cannot express it.

## What the operator sees

When the gate blocks creation, the response is a validation failure carrying:

- a **total** count of missing mandatory fields across the whole Summary Log, and
- a **list of the missing fields**, each locating the sheet and row it belongs to.

The field list is capped (the total remains truthful even when the list is truncated) so a pathological Summary Log cannot produce an unbounded payload. The frontend maps each field name to its human-facing label.

## Where the rules live

The rules are implemented in the `epr-backend` service under `src/reports/domain/report-mandatory/`:

- the policy registry maps each template to its rules,
- one policy module per template defines the rules as trigger plus required-field sets,
- shared trigger predicates and the `requiredBy` reason codes back them.

The gate and any completeness diagnostics share a single rule-evaluation function, so a diagnostic reporting how much live data would be blocked cannot drift from what the gate actually enforces.

## Related Requirements

| Area                           | Jira     | Status      |
| ------------------------------ | -------- | ----------- |
| Exporter completeness rules    | PAE-1420 | Implemented |
| Reprocessor completeness rules | PAE-1280 | Implemented |
