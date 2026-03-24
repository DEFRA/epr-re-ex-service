---
allowed-tools: Bash(git *)
description: Create a feature branch in a submodule
---

## Your task

Create a feature branch in the current submodule (or a specified one).

The user will provide `$ARGUMENTS` as a ticket ID (e.g. `PAE-853`) and an optional branch description (e.g. `PAE-853 extra validation against status history`).

If no ticket ID is provided, ask the user for it.

---

## Step 1: Check current branch state

```bash
git status
git branch --show-current
git log --oneline origin/main..HEAD
```

Handle these scenarios:

### On `main` with unpushed commits

1. Count how many commits are ahead of `origin/main`
2. Create the feature branch from the current HEAD
3. Reset `main` back to `origin/main`:
   ```bash
   git branch <new-branch>
   git reset --hard origin/main
   git checkout <new-branch>
   ```
4. Confirm with the user before resetting main

### Already on a feature branch

Use the existing branch. If the branch name doesn't match the ticket ID, ask the user if they want to rename it.

### Uncommitted changes present

Warn the user and ask:

- **Commit first** — stage and commit, then continue
- **Stash** — stash changes and continue with existing commits
- **Cancel** — stop and let the user sort it out

---

## Step 2: Branch naming

Format: `<TICKET>-<kebab-case-description>`

Examples:

- `PAE-853-extra-validation-against-status-history`
- `PAE-971-remove-feature-flag-sqs-commands`

If the user only provided a ticket ID without a description, generate one from the commit messages. If there are no commits so far, ask the user for a description.

---

## Step 3: Create and checkout the branch

```bash
git checkout -b <branch-name>
```

---

## Step 4: Return the result

Show the user:

- The branch name
- Which submodule it was created in
