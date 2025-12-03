# Summary Log Validation: Low Level Design

This document describes the implementation approach for the validation layer in summary log processing, extending the transformation architecture defined in ADR 0019.

For the architectural decision and rationale for the transformation pipeline, see [ADR 19: Layered Transformation Strategy for Summary Log to Waste Records](../decisions/0019-waste-record-transformation-pipeline.md).

<!-- prettier-ignore-start -->
<!-- TOC -->
- [Summary Log Validation: Low Level Design](#summary-log-validation-low-level-design)
  - [Context](#context)
  - [Technical approach](#technical-approach)
    - [Validation layer in the pipeline](#validation-layer-in-the-pipeline)
    - [Schema registry structure](#schema-registry-structure)
    - [Table schema definition](#table-schema-definition)
    - [Row transformers](#row-transformers)
  - [Testing strategy](#testing-strategy)
    - [Dependency injection for testability](#dependency-injection-for-testability)
    - [Test categories](#test-categories)
  - [Open questions](#open-questions)
<!-- TOC -->
<!-- prettier-ignore-end -->

## Context

ADR 0019 defines a four-layer transformation architecture for processing summary logs into waste records. It anticipated the need for a separate validation layer:

> "Possible enhancements: Separate validation layer if field validation becomes complex"

This design implements that validation layer using Joi schemas, with clean separation between:

- **Validation** (summary log schemas) - structural and data validation
- **Transformation** (row transformers) - mapping validated rows to waste records

## Technical approach

### Validation layer in the pipeline

The validation layer slots into ADR 0019's architecture:

| Layer | ADR 0019 Layer | Responsibility | Example |
|-------|----------------|----------------|---------|
| Processing Type Dispatch | Layer 1 | Route to correct schema/transformer | `PROCESSING_TYPE_TABLES[type][table]` |
| **Validation (new)** | - | Apply Joi schemas, collect issues | `validateDataSyntax(parsed)` |
| Table Iteration | Layer 2 | Generic mechanics (iteration, versioning) | `transformTable()` |
| Row Transformer | Layer 3 | Map validated row → waste record | `transformReceivedLoadsRow()` |
| Field Logic | Layer 4 | Business rules within transformer | Calculated fields, enrichment |

### Schema registry structure

Hierarchical folder structure organised by processing type:

```
src/domain/summary-log/
├── index.js                          # exports createDataSyntaxValidator, etc.
├── table-schemas/
│   ├── index.js                      # composes PROCESSING_TYPE_TABLES registry
│   ├── shared/
│   │   ├── joi-messages.js           # common validation message constants
│   │   └── row-id.schema.js          # ROW_ID failure schema factory
│   ├── reprocessor-input/
│   │   ├── index.js                  # TABLE_SCHEMAS for this type
│   │   ├── received-loads-for-reprocessing.js
│   │   ├── reprocessed-loads.js
│   │   └── sent-on-loads.js
│   ├── reprocessor-output/
│   │   ├── index.js
│   │   ├── received-loads-for-reprocessing.js  # may differ from input
│   │   ├── reprocessed-loads.js                 # has extra UK % fields
│   │   └── sent-on-loads.js
│   └── exporter/
│       ├── index.js
│       ├── received-loads-for-export.js        # 50+ columns, export-specific
│       └── sent-on-loads.js
└── validation/
    ├── data-syntax.js
    └── ... other validation logic
```

Processing type index files compose tables into a registry:

```javascript
// reprocessor-input/index.js
import { RECEIVED_LOADS_FOR_REPROCESSING } from './received-loads-for-reprocessing.js'
import { REPROCESSED_LOADS } from './reprocessed-loads.js'
import { SENT_ON_LOADS } from './sent-on-loads.js'

export const TABLE_SCHEMAS = {
  RECEIVED_LOADS_FOR_REPROCESSING,
  REPROCESSED_LOADS,
  SENT_ON_LOADS
}
```

Top-level index composes the full registry:

```javascript
// table-schemas/index.js
import { TABLE_SCHEMAS as REPROCESSOR_INPUT } from './reprocessor-input/index.js'
import { TABLE_SCHEMAS as REPROCESSOR_OUTPUT } from './reprocessor-output/index.js'
import { TABLE_SCHEMAS as EXPORTER } from './exporter/index.js'

export const PROCESSING_TYPE_TABLES = {
  REPROCESSOR_INPUT,
  REPROCESSOR_OUTPUT,
  EXPORTER
}
```

### Table schema definition

Each table schema file exports:

```javascript
export const RECEIVED_LOADS_FOR_REPROCESSING = {
  rowIdField: 'ROW_ID',
  requiredHeaders: ['ROW_ID', 'SITE_ADDRESS', ...],
  rowSchemas: {
    failure: Joi.object({ ROW_ID: ... }),   // FATAL errors - reject entire file
    concern: Joi.object({ ... })             // ERROR/WARNING level - row-level issues
  }
}
```

**Schema types:**

- `failure` schema - validates fields where invalid values should reject the entire spreadsheet (e.g. ROW_ID must be >= 10000)
- `concern` schema - validates fields where invalid values produce row-level errors/warnings but don't reject the file

### Row transformers

Per ADR 0019, row transformers live alongside the sync/transformation code:

```
src/domain/summary-log/
├── table-schemas/           # validation (this design)
│   └── ...
├── sync/
│   ├── sync-from-summary-log.js
│   └── row-transformers/    # transformation (ADR 0019)
│       ├── received-loads-for-reprocessing.js
│       ├── reprocessed-loads.js
│       ├── sent-on-loads.js
│       └── received-loads-for-export.js
└── ...
```

ADR 0019 defines a parallel `PROCESSING_TYPES` dispatch map for transformers:

```javascript
const PROCESSING_TYPES = {
  REPROCESSOR_INPUT: {
    RECEIVED_LOADS_FOR_REPROCESSING: transformReceivedLoadsRow,
    REPROCESSED_LOADS: transformReprocessedLoadsRow,
    SENT_ON_LOADS: transformSentOnLoadsRow
  },
  // ... same structure as schema registry
}
```

The same table name can have different transformers for different processing types (e.g. `SENT_ON_LOADS` for EXPORTER vs REPROCESSOR_INPUT).

## Testing strategy

### Dependency injection for testability

Unit tests should define minimal test schemas rather than using production schemas. The composition root injects the production registry:

```javascript
// validate.js (composition root)
import { PROCESSING_TYPE_TABLES } from './table-schemas/index.js'

export const createSummaryLogsValidator = ({ ... }) => {
  const validateDataSyntax = createDataSyntaxValidator(PROCESSING_TYPE_TABLES)
  // ...
}
```

Unit tests inject minimal test registries:

```javascript
// data-syntax.test.js
const TEST_SCHEMAS = {
  TEST_PROCESSING_TYPE: {
    TEST_TABLE: {
      rowIdField: 'ROW_ID',
      requiredHeaders: ['ROW_ID', 'TEXT_FIELD'],
      rowSchemas: {
        failure: Joi.object({ ROW_ID: Joi.number().min(10000) }),
        concern: Joi.object({ TEXT_FIELD: Joi.string() })
      }
    }
  }
}

const validateDataSyntax = createDataSyntaxValidator(TEST_SCHEMAS)
```

**Benefits:**

- **Simpler tests** - 2-3 field schemas vs 12+ column production schemas
- **Focused tests** - each test exercises specific behaviour
- **Schema independence** - production schema changes don't break unit tests
- **Clarity** - test data shows exactly what's being tested

### Test categories

| Category | Registry | Purpose |
|----------|----------|---------|
| Unit tests | Minimal test schemas | Test validation logic in isolation |
| Integration tests | Production schemas | Verify real schemas work correctly end-to-end |

## Open questions

1. **Schema reuse** - REPROCESSOR_INPUT and REPROCESSOR_OUTPUT currently identical for some tables. Share or duplicate?
2. **Required headers** - Should header validation be a separate phase or part of data-syntax validation?
3. **Registry unification** - Should `PROCESSING_TYPE_TABLES` (schemas) and `PROCESSING_TYPES` (transformers) be unified into a single registry per table?
