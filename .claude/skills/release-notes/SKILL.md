---
name: release-notes
description: Generate a combined Slack-ready release summary covering epr-backend, epr-frontend, epr-re-ex-admin-frontend, and EPR-related cdp-app-config changes. Use when preparing a release announcement or asked to summarise changes between two deployed versions.
---

# release-notes

Generate a combined Slack-ready release summary covering epr-backend, epr-frontend, epr-re-ex-admin-frontend, and EPR-related cdp-app-config changes.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated (`gh auth status`) with read access to the `DEFRA/epr-backend`, `DEFRA/epr-frontend`, `DEFRA/epr-re-ex-admin-frontend`, and `DEFRA/cdp-app-config` repositories
- `jq` available on `PATH`
- `JIRA_EMAIL` and `JIRA_TOKEN` environment variables set — used to fetch PAE issue summaries for the user-facing changes step (see the [jira skill](../jira/SKILL.md) for setup)
- No local clone of any of the above repos is required — everything is fetched via the GitHub API

## Usage

```
/release-notes --backend <from> <to> --frontend <from> <to> --admin <from> <to> --config <from-commit> [to-commit]
```

- `<from>` is the version **currently in production** — all changes after it are included
- `<to>` is the version being released
- Tags may be given with or without the `.0` patch suffix; normalise to `<major>.<minor>.0` before running
- All flags are optional — include only the repos/config that changed

Examples:
- `/release-notes --backend 0.785.0 0.810.0 --frontend 0.505.0 0.508.0`
- `/release-notes --backend 0.810 0.815 --admin 0.232 0.236 --config abc1234`
- `/release-notes --config abc1234 def5678`

## Repo details

| Arg | Repo name | GitHub URL |
|-----|-----------|-----------|
| `--backend` | `epr-backend` | `https://github.com/DEFRA/epr-backend` |
| `--frontend` | `epr-frontend` | `https://github.com/DEFRA/epr-frontend` |
| `--admin` | `epr-re-ex-admin-frontend` | `https://github.com/DEFRA/epr-re-ex-admin-frontend` |
| `--config` | `cdp-app-config` | `https://github.com/DEFRA/cdp-app-config` (via `gh api`) |

## Steps

All repos use the same two-step pattern: one `compare` API call for the full range, then process the output.

`<from>` is the version currently in production — all changes **after** it (up to and including `<to>`) are included.

### Step 1 — single compare call (all repos)

```bash
gh api "repos/DEFRA/<repo>/compare/<from>...<to>" > compare.json
```

- **Code repos** (`--backend`, `--frontend`, `--admin`): returns all commits after `<from>` up to `<to>`
- **Config repo** (`--config`): `<from>` is the `<from-commit>` argument; returns all changed files in the range

### Step 2 — post-processing

#### For --backend, --frontend, --admin (if provided)

**Build sha→tag map** for tags after `<from>` up to `<to>` (one paginated API call):
```bash
gh api repos/DEFRA/<repo>/tags --paginate \
  | jq -r '.[] | [.name, .commit.sha] | @tsv' \
  | sort -V \
  | awk -v from="<from>" -v to="<to>" \
      'p && index($0, to)==1 {print; exit} p {print} index($0, from)==1 {p=1}'
```

This captures every tag strictly after `<from>` up to and including `<to>`, skipping `<from>` itself since it is already in production.

**Attribute commits to tags:**
Walk the commits from `compare.json` in order. Each time a commit SHA matches a tag boundary in the sha→tag map, advance the current tag. Attribute each PAE commit to the current tag.

For each commit message:
- Extract PAE number: `grep -oE 'PAE-[0-9]+'`
- Extract PR number from `(#NNN)` suffix
- Strip the PR ref from the title
- Mark reverts with ` (revert)` at end
- Include all commits — do not skip PAE-000 or commits with no PAE number

#### For --config (if provided)

Use the GitHub API — no local clone required, always reflects latest state.

**Resolve `to-commit`** (one API call, only if not supplied):
```bash
TO=${to_commit:-$(gh api repos/DEFRA/cdp-app-config/git/ref/heads/main | jq -r '.object.sha')}
FROM_SHORT=$(echo <from-commit> | cut -c1-7)
TO_SHORT=$(echo $TO | cut -c1-7)
```

**Filter files by EPR path** from `compare.json` — only `defaults.env` and `prod/` files:
```bash
jq -r '.files[] | select(.filename | test("^services/epr-(backend|frontend|re-ex-admin-frontend)/(defaults\\.env|prod/)")) | [.filename, .status, .patch // ""] | @tsv' compare.json
```
This covers only `defaults.env` (all environments) and `prod/<service>.env` files — dev, test, and other environment files are ignored.

**Summarise per service:**
- Group by `services/<service>/` prefix
- Note which files changed: `defaults.env` affects all environments; `prod/<service>.env` affects prod only
- For each changed file, list keys added (`+KEY=value`), removed (`-KEY=value`), or modified
- Ignore comment-only lines (`# ...`) and blank lines in patches
- If a file is newly created or deleted, state that
- If all changes for a service are placeholder-only (comment-only), omit it

If there are no meaningful changes, output: `_(no EPR service config changes)_`

## Output format

Print markdown to the terminal only — no clipboard copy:

```
# Release notes — <date>

**User-facing changes**
- [PAE-XXXX](https://eaflood.atlassian.net/browse/PAE-XXXX): plain-English description of what changed for the user
_(or: no user-facing changes)_

**epr-backend  0.NNN.0 → 0.MMM.0**
- [PAE-XXXX](https://eaflood.atlassian.net/browse/PAE-XXXX): commit title (0.NNN.0)
- [PAE-XXXX](https://eaflood.atlassian.net/browse/PAE-XXXX): commit title (0.NNN.0, 0.MMM.0)
...

**epr-frontend  ...**
**epr-re-ex-admin-frontend  ...**

**cdp-app-config  <from-short>...<to-short>**
- **epr-backend** (defaults → all envs): FEATURE_FLAG_X added: true
- **epr-backend** (prod): FEATURE_FLAG_X removed
_(or: no EPR service config changes)_
```

## Notes

- One bullet per commit in tag order ascending
- Sort bullets by tag ascending
- The Jira base URL is `https://eaflood.atlassian.net/browse/`
- The **User-facing changes** section appears first, before any per-repo sections

## Step 3 — identify user-facing changes

After printing the release notes, ask the user which changes are user-facing so the summary can be finalised:

1. **Collect candidate PAE numbers** from all commits processed above (exclude PAE-000 and commits with no PAE number). For each, fetch the issue summary from JIRA so the question is readable.

2. **Ask the user** using `AskUserQuestion`, `multiSelect: true`:
   > Which of these PAE issues are user-facing? (these will appear in the User-facing changes section)

   One option per PAE issue: label = `PAE-XXXX`, description = issue summary. Plus a **"None"** option. Pre-select issues that came from `--frontend` or `--admin` repos as a hint (user can override).

3. **Re-render the release notes** with the User-facing changes section populated based on the user's answer. For each selected issue, write a plain-English bullet describing what changed for the end user (derive from the commit title / JIRA summary — avoid technical jargon). Print the final release notes to the terminal.
