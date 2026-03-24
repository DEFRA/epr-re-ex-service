---
allowed-tools: Bash(git *), Bash(gh pr *), Bash(gh api *)
description: Create or update a PR with a structured description
---

## Your task

Create a pull request for the current branch, or update an existing one if the PR already exists.

The user may provide `$ARGUMENTS` as a ticket ID (e.g. `PAE-853`). If not provided, extract it from the branch name.

---

## Step 1: Check current state

```bash
git branch --show-current
git log --oneline origin/main..HEAD
```

Extract the ticket ID from the branch name (e.g. `PAE-853-some-description` → `PAE-853`).

If on `main` or detached HEAD, warn the user — a branch is required before creating a PR.

---

## Step 2: Check for existing PR

```bash
gh pr view --json number,title,body,url 2>/dev/null
```

If a PR already exists, skip to Step 5 to update it.

---

## Step 3: Generate PR description

Analyse the changes:

```bash
git diff main...HEAD
git log --oneline main..HEAD
```

Read the changed files to understand the full context. If there are no changes so far, create something from what you know so far.

### Title

`<TICKET>: <concise summary>` — keep under 70 characters.

### Body

```markdown
## Summary

<2-4 bullet points explaining what changed and why>

## Changes

<list of modified files with a brief description of each change>

## Test plan

<bulleted checklist based on test files changed/added>
```

---

## Step 4: Create the PR

```bash
gh pr create --draft --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

If the repo has a PR template, incorporate its structure.

---

## Step 5: Update existing PR (if applicable)

If the PR already exists and new changes have been pushed, update the description to reflect the current state of changes:

```bash
git diff main...HEAD
git log --oneline main..HEAD
```

Then update:

```bash
gh pr edit --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

---

## Step 6: Return the result

Show the user:

- The PR URL
- The title and summary for quick review
- Any warnings (e.g. if coverage is below 100%)
