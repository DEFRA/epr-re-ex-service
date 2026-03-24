## Working Philosophy

### Augmented Coding

This is augmented coding, not vibe coding. AI handles implementation; the human handles decisions, design, and quality judgement. The values of hand-written code — tidy, well-tested, easy to reason about — still apply. AI is a power tool, not a replacement for engineering discipline.

### Context Engineering

Less context is better context. Anthropic's own guidance: "an agent's effectiveness goes down when it gets too much context." Two types of context matter:

- **Instructions** — task-specific, prescriptive: "validate with Joi"
- **Guidance** — principle-oriented, constraining: "test behaviour not implementation," "dependencies point inward"

Instructions belong in project CLAUDE.md files. Guidance belongs in rules. Don't mix them.

### Spec-Driven Development

Separate planning from implementation. Before writing code, define what you're building:

- Problem/opportunity statement in domain language
- Acceptance criteria in Given/When/Then format
- Interface contracts (inputs, outputs, error cases)
- Constraints and invariants

### Shell Commands — CRITICAL

**NEVER chain shell commands with `&&` or `;`**. Always use separate Bash tool calls — one command per call. The working directory persists between calls, so chaining is never necessary.

Wrong: `cd /some/path && git status`
Right: Two separate Bash calls — first `cd /some/path`, then `git status`

Do not use command substitution patterns when creating git commit messages:
Wrong: git commit -m "$(cat <<'EOF' refactor(reports): fix SonarQube issues…)"
Right: git commit -m "refactor(reports): fix SonarQube issues…"

### Working Practices

- Present changes file by file — give the user a chance to spot mistakes
- Do not invent changes beyond what's explicitly requested
- Ask clarifying questions until all details are known
- Do not remove unrelated code or functionalities — preserve existing structures
- Do not suggest changes to files when no actual modifications are needed

### Red Flags

Watch for these in AI-generated code — they indicate the AI is off-piste:

- Unrequested functionality or "improvements" nobody asked for
- Test manipulation to make failing tests pass rather than fixing the code
- Complexity without corresponding simplification elsewhere
- Loops or retry patterns where a direct solution would do

### The Exhaling Problem

AI is excellent at adding features (inhaling) but poor at simplifying (exhaling). After feature work, actively request a simplification pass. Ask: "What can we remove? What's redundant now? Can this be simpler?" Left unchecked, AI-assisted codebases accumulate cruft faster than hand-written ones.

---

## Engineering Principles

Universal standards regardless of project, client, or tech stack.

### Testing

- Test behaviour, not implementation — tests should survive refactoring
- Descriptive test names that read as specifications
- Test pyramid: more unit tests than integration, more integration than E2E
- Flaky tests get fixed or deleted immediately — never skipped

### Code Quality

- Write for humans to read, not just machines to execute
- Meaningful names that express intent without requiring comments
- Small, focused functions doing one thing well
- Don't log and re-throw — pick one. Structured logging only
- Remove dead code; don't comment it out

### Architecture

- Isolate domain logic from infrastructure concerns (ports and adapters)
- Dependencies point inward — domain core has no outward dependencies
- Design interfaces based on client needs, not implementation capabilities
- Prefer composition over inheritance
- Be pragmatic — not every call needs its own abstraction layer

### API Design

- RESTful: nouns for resources, HTTP methods for actions
- Consistent error responses with meaningful status codes
- Validate all input at system boundaries

### Security

- Secrets never in code or version control
- Authenticate and authorise every non-public endpoint — they're different checks
- Validate and sanitise all external input
- Never log sensitive data (passwords, tokens, PII)

### Version Control

- Conventional commits: `type(scope): description` in imperative present tense
- Small, focused PRs — one concern per PR
- Never commit directly to main; never force-push to shared branches

### Task Execution

- Implement the simplest thing that works
- Run quality checks before requesting review
- Wait for review — don't assume approval
