---
allowed-tools: Bash(git *), Bash(gh pr *), Bash(gh api *), Skill(createbranch), Skill(createpr)
description: Push changes and ensure PR description is up to date
---

## Your task

Push committed changes in submodules to their remotes. Ensure each submodule has a feature branch and a PR whose description reflects the current changes.

---

## Step 1: Identify submodules with unpushed commits

From the parent repo root, check each submodule for commits ahead of the remote:

```bash
git status
```

The submodules are:

- `lib/epr-backend`
- `lib/epr-backend-journey-tests`
- `lib/epr-frontend`
- `lib/epr-frontend-journey-tests`
- `lib/epr-re-ex-admin-frontend`
- `lib/epr-re-ex-admin-frontend-tests`

For each submodule that has changes, `cd` into it and check:

```bash
git branch --show-current
git log --oneline origin/$(git branch --show-current)..HEAD 2>/dev/null
```

Only proceed with submodules that have unpushed commits.

---

## Step 2: Ensure a feature branch exists

For each submodule with unpushed commits:

```bash
git branch --show-current
```

### If on a feature branch

Continue to Step 3.

### If on `main` or detached HEAD

Invoke the `/createbranch` skill to create a feature branch before pushing. If no ticket ID is known, ask the user for one.

---

## Step 3: Push

```bash
git push -u origin <branch-name>
```

---

## Step 4: Ensure PR exists and description is current

After pushing, invoke the `/createpr` skill. This will either:

- **Create a new PR** if one doesn't exist yet
- **Update the existing PR** description to reflect the current branch diff against main

---

## Step 5: Return the result

Show the user a summary per submodule:

- Branch name
- Push result (commits pushed)
- PR URL
- Which submodules were skipped (no unpushed commits)
