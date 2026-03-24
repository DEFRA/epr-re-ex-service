---
allowed-tools: Bash(git *), Bash(npx lint-staged *), Bash(npx prettier *), Bash(npx gitleaks *), Bash(npm run *), Skill(createbranch)
description: Stage and commit changes with a descriptive message
---

## Your task

Stage and commit changes across submodules in this monorepo. **Never commit in the parent repo** — all commits happen inside the submodules that have changes.

---

## Step 1: Identify which submodules have changes

From the parent repo root, run:

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

Only proceed with submodules that show as modified or dirty.

---

## Step 2: For each changed submodule, check its branch

```bash
cd <submodule-path>
git branch --show-current
```

### If on a feature branch

Use it. Extract the ticket ID from the branch name (e.g. `PAE-853-some-description` → `PAE-853`).

### If on `main` (or detached HEAD with no feature branch)

You **must** create a branch before committing. Invoke the `/createbranch` skill for the submodule to create a branch. If the user has not provided a ticket ID, ask for one.

Return to the parent repo root between submodules.

---

## Step 3: Review changes in each submodule

For each submodule with changes:

```bash
cd <submodule-path>
git status
git diff
git diff --staged
```

Understand what has actually changed before writing any commit message. Read modified files if needed to understand the context.

---

## Step 4: Stage changes in each submodule

- Stage specific files by name — avoid `git add -A` or `git add .`
- Never stage files that may contain secrets (`.env`, `credentials.json`, etc.) — warn the user if they exist

---

## Step 5: Write the commit message

### Derive the ticket ID from the branch name

```bash
git branch --show-current
```

Extract the ticket prefix (e.g. `PAE-853-add-validation` → `PAE-853`).

### Format

Follow the project convention: `<TICKET>: <concise description>`

Examples from this repo:

- `PAE-971: Remove FEATURE_FLAG_SQS_COMMANDS and PISCINA_MAX_THREADS from compose files`
- `PAE-1138: move discovery docs`
- `PAE-1117: add gitleaks for pre-commit secret scanning`

### Rules

- The message must accurately describe **what changed and why** — not just "update files" or "fix bug"
- Use imperative mood ("add", "remove", "fix", "update")
- Keep the first line under 70 characters
- Add a body separated by a blank line if the change needs more context
- End the message with: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`

### Use a HEREDOC for the commit

```bash
git commit -m "$(cat <<'EOF'
PAE-XXX: description here

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Step 6: Handle pre-commit hook failures

Submodules use husky + lint-staged which may run:

- **prettier** on `*.{js,json,md}` files
- **ADR TOC generation** on `docs/architecture/decisions/*.md` files
- **gitleaks** secret scanning on all staged files

### If the hook fails:

1. **Read the error output carefully** — identify which check failed
2. **Fix the issue:**
   - Prettier failures: run `npx prettier --write <files>` and re-stage
   - ADR TOC failures: run `npm run adr:generate:toc` and re-stage
   - Gitleaks failures: check for accidentally staged secrets, remove them, and warn the user
3. **Re-stage the fixed files** and create a **new** commit (never amend the previous commit unless explicitly asked)
4. **Never use `--no-verify`** to bypass hooks

---

## Step 7: Verify

For each submodule that was committed:

```bash
cd <submodule-path>
git status
git log --oneline -3
```

Confirm all commits were created successfully and show the results to the user. Include which submodules were committed and which were skipped.
