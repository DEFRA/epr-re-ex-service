## Working Philosophy

### Augmented Coding

This is augmented coding, not vibe coding. AI handles implementation; the human handles decisions, design, and quality judgement. The values of hand-written code — tidy, well-tested, easy to reason about — still apply. AI is a power tool, not a replacement for engineering discipline.

### Context Engineering

Less context is better context. Anthropic's own guidance: "an agent's effectiveness goes down when it gets too much context." Two types of context matter:

- **Instructions** — task-specific, prescriptive: "validate with Joi"
- **Guidance** — principle-oriented, constraining: "test behaviour not implementation," "dependencies point inward"

Instructions belong in project CLAUDE.md files. Guidance belongs in rules. Don't mix them.

---

## Development Process

### Development sequence

Work flows through these phases. Don't skip ahead.

1. **Plan** — Define what you're building before writing code. For significant work, this means ADR and/or API definition changes in `docs/architecture/`. For smaller work, a clear scope with acceptance criteria is sufficient. Plans should target small, focused PRs.
2. **Review the plan** — Get human approval before implementation begins.
3. **Implement and test** — Write code and tests together.
4. **Verify** — All checks must pass before requesting review: formatting, linting, JSDoc types (all errors resolved), and 100% test coverage.
5. **Review** — Both automated and human review before merging.
6. **Commit and deliver** — Commit, push, and open a PR.

### Spec-driven development

Separate planning from implementation. Before writing code, define what you're building:

- Problem/opportunity statement in domain language
- Acceptance criteria in Given/When/Then format
- Interface contracts (inputs, outputs, error cases)
- Constraints and invariants

### JSDoc types

Use JSDoc types on all functions, parameters, and return values. This is a plain JavaScript codebase with no TypeScript — JSDoc is the type system. All JSDoc type errors must be resolved before requesting review.

### Conventional commits

Format: `type(scope): description` in imperative present tense.

---

## Shell Commands — CRITICAL

**NEVER chain shell commands with `&&` or `;`**. Always use separate Bash tool calls — one command per call. The working directory persists between calls, so chaining is never necessary.

Wrong: `cd /some/path && git status`
Right: Two separate Bash calls — first `cd /some/path`, then `git status`

Do not use command substitution patterns when creating git commit messages:
Wrong: git commit -m "$(cat <<'EOF' refactor(reports): fix SonarQube issues…)"
Right: git commit -m "refactor(reports): fix SonarQube issues…"

---

## Working Practices

- Present changes file by file — give the user a chance to spot mistakes
- Do not invent changes beyond what's explicitly requested
- Do not remove unrelated code or functionalities — preserve existing structures
- Do not suggest changes to files when no actual modifications are needed
- Never use apologies or feedback about your own understanding
- Commits happen inside submodules, never in the parent repo (except docs/architecture changes)

### Confidence — ALWAYS STATE IT

Every response must include a confidence signal. Be honest about how sure you are — the user needs to calibrate how much scrutiny to give your output. Use plain language, not percentages:

- **"Dead certain"** — you've read the code, checked the docs, this is fact
- **"Pretty confident"** — strong evidence but haven't verified every detail
- **"Best guess"** — reasoning from patterns, not direct evidence
- **"Not sure"** — speculating, could easily be wrong

Place it naturally in context rather than as a mechanical prefix. If confidence varies across parts of a response, signal per-section.
