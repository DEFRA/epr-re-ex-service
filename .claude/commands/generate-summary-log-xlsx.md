---
allowed-tools: Bash(npm run generate:spreadsheet*), Bash(ls *), Bash(pwd), Bash(docker compose*exec mongodb mongosh*), Bash(cp *)
description: Generate a summary log spreadsheet for local development
---

## Your task

Generate a summary log XLSX spreadsheet using the generator in `epr-backend-journey-tests`.

The generator must be run from the journey tests directory:
`lib/epr-backend-journey-tests`

### Determine the waste processing type

Ask the user if not provided as an argument. Three types are available:

| Type               | Command                                 |
| ------------------ | --------------------------------------- |
| Reprocessor Output | `npm run generate:spreadsheet:output`   |
| Reprocessor Input  | `npm run generate:spreadsheet:input`    |
| Exporter           | `npm run generate:spreadsheet:exporter` |

### Gather parameters

These are passed as environment variables prefixed to the command. **Ask the user for any that were not provided as arguments.** Use a single multi-question prompt to collect all missing values at once.

| Variable     | Description                      | Example                    |
| ------------ | -------------------------------- | -------------------------- |
| `ROWS`       | Number of data rows (default 10) | `ROWS=20`                  |
| `MATERIAL`   | Material suffix                  | `MATERIAL=ST`              |
| `REG_NUMBER` | Registration number              | `REG_NUMBER=REG-50030-001` |
| `ACC_NUMBER` | Accreditation number             | `ACC_NUMBER=ACC-50030-001` |

**Available materials:** AL (Aluminium), FB (Fibre-based composite), GR (Glass remelt), GO (Glass other), PA (Paper/board), PL (Plastic), ST (Steel), WO (Wood)

When asking, offer sensible defaults as options (e.g. 10 rows, common materials) and always allow the user to type a custom value.

### Run the generator

Construct the command from the user's input. For example:

```bash
ROWS=20 MATERIAL=ST npm run generate:spreadsheet:output
```

Run it from the journey tests directory. The output file will be saved to `./data/` within that directory.

### After generation

#### Backdate accreditation validFrom

The generator uses `faker.date.recent()` which produces dates in the recent past. The backend marks rows as `IGNORED` when their dates fall before the accreditation's `validFrom` date. Since Docker seed data sets `validFrom` to the date the containers were created, generated rows will be silently excluded unless we backdate it.

**Extract the accreditation number** from the generator output. The log line looks like:

```
Updated Cover sheet -- Material: ..., Registration: ..., Accreditation: <ACC_NUMBER>
```

If the user provided `ACC_NUMBER` as an environment variable, use that value directly.

**Run a mongosh command** to set `validFrom` to 1 year before today:

```bash
docker compose exec mongodb mongosh --quiet --eval '
    const result = db.getSiblingDB("epr-backend")["epr-organisations"].updateOne(
      { "accreditations.accreditationNumber": "<ACC_NUMBER>" },
      { $set: { "accreditations.$.validFrom": new Date("<YYYY-MM-DD>") } }
    );
    print("Matched: " + result.matchedCount + ", Modified: " + result.modifiedCount);
  '
```

Replace `<ACC_NUMBER>` with the actual accreditation number and `<YYYY-MM-DD>` with the date 1 year before today (e.g. if today is 2026-02-12, use 2025-02-12).

If the update reports `Matched: 0`, warn the user that no matching accreditation was found in MongoDB — they may need to check that the accreditation number exists in the seed data, or create it.

#### Copy to Downloads

Copy the generated file from `./data/` to `~/Downloads/`. Parse the output filename from the generator's log line:

```
Successfully generated spreadsheet: ./data/<filename>.xlsx
```

```bash
cp lib/epr-backend-journey-tests/data/<filename>.xlsx ~/Downloads/
```

#### Show output

- Show the user a clickable link to the file in Downloads: file://~/Downloads/<filename>.xlsx
- Remind them to open the file in Excel (or equivalent) and save it once before uploading, as the README requires this for the file to be readable by the service
