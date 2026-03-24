---
name: type-safety
description: Use when fixing type errors, adding JSDoc annotations, reviewing type changes, or working with tsc in JavaScript codebases. Triggers on type checker errors, JSDoc type work, or any PR that changes type annotations. Ensures types are strengthened not weakened and invalid states made unrepresentable.
---

# Type Safety in JSDoc JavaScript

Strengthen types to catch bugs at check time. Every change must make the type system MORE restrictive, not less.

## Core Principle

**Make invalid state unrepresentable.** If a value can't be null at runtime, the type shouldn't allow null. If a function only accepts a specific variant of a union type, the param type should be that variant, not the whole union.

## The Audit Question

For every type change, ask: **"Does this make it harder or easier to pass wrong data?"** If easier, it's a weakening. Find a different approach.

## Strengthening vs Weakening

| Weakening (NEVER do)                     | Strengthening (DO this)                                |
| ---------------------------------------- | ------------------------------------------------------ |
| Cast to `any`                            | Import and use the proper type                         |
| Cast to `object`                         | Use a specific structural type                         |
| Add a runtime null guard                 | Tighten the param type so null can't arrive            |
| Widen a param to accept more             | Push validation to the boundary, keep downstream tight |
| Use untyped `Array`                      | Use `Array<{specific, shape}>`                         |
| Use `unknown` for known shapes           | Import the proper type from its definition             |
| Remove a type annotation to fix "unused" | Fix the annotation pattern so tsc can see it           |

## Patterns

### Push validation to boundaries, keep internals tight

Don't scatter null guards across every function. Validate once at the entry point, then give downstream functions types that guarantee the data is valid.

```js
// BAD: Every function guards against undefined
/** @param {{ start?: string, end?: string }} range */
function isWithinRange(date, range) {
  if (!range.start || !range.end) return false
  // ...
}

// GOOD: Entry point narrows, downstream gets tight types
function processRecord(record) {
  if (!record.start || !record.end) return false
  return isWithinRange(date, { start: record.start, end: record.end })
}
/** @param {{ start: string, end: string }} range */
function isWithinRange(date, range) {
  // No guard needed - type guarantees both exist
}
```

This reduces branches, reduces test coverage burden, and makes the code clearer about what each function actually requires.

### Coerce at call sites, not in contracts

When a function expects `T | null` but callers have `T | undefined`, keep the contract tight and coerce where the data enters.

```js
// BAD: Widen the contract to accept both null and undefined
/** @param {{ value?: Thing | null | undefined }} ctx */

// GOOD: Keep the contract clean, coerce at the call site
/** @param {{ value: Thing | null }} ctx */
// Caller:
process({ value: source.value ?? null })
```

This keeps the function's contract honest about what it handles and pushes the `undefined` problem to where the data originates.

### Type the whole destructured parameter, not inner members

tsc cannot see `/** @type */` annotations inside destructuring patterns. The import appears unused and the annotation has no effect.

```js
// BAD: tsc can't see this - reports the type import as unused
({ /** @type {Thing | null} */ thing }) => {

// GOOD: tsc sees this - import registers as used, type is enforced
/** @type {{ thing: Thing | null }} */ { thing }) => {
```

### Don't leak implementation details through abstraction boundaries

Database-specific fields (`_id`, BSON types, collection shapes) stay in the database adapter. In-memory implementations and port/interface types use domain types only.

```js
// BAD: In-memory implementation knows about database internals
const id = item._id?.toString() ?? item.id

// GOOD: In-memory implementation uses domain identity only
const id = item.id
```

This applies to any adapter boundary - HTTP response shapes, queue message formats, cache keys. The domain layer should never import from adapter packages.

### `instanceof` fails across package boundaries

Node.js module resolution can give you different class instances from the same logical package (e.g. a type re-exported by a wrapper package). Always verify before using `instanceof`:

```js
// Check at the REPL first
import('pkg-a').then((a) =>
  import('pkg-b').then((b) =>
    console.log('Same class:', a.SomeType === b.SomeType)
  )
)
```

If they differ, use `in` operator narrowing instead of `instanceof`:

```js
// BAD: Fails when value comes from a different package
if (value instanceof SomeType) { ... }

// GOOD: Works regardless of which package created the value
if (typeof value === 'object' && value !== null &&
    'marker' in value && value.marker === 'ExpectedValue') {
  // value is now narrowed
}
```

### Use `@ts-expect-error` not `@ts-ignore`

When a type error is a known false positive (e.g. the type system can't see that a runtime invariant holds), use `@ts-expect-error` with a comment explaining the invariant. It will flag as an error if the suppression ever becomes unnecessary.

```js
// @ts-expect-error pagination logic guarantees non-empty array here
const last = items.at(-1).id
```

## Common Mistakes

**Casting to `any` to fix type errors.** There is always a better approach - import the right type, narrow with a type guard, or restructure the code.

**Adding null guards everywhere.** Each guard is a new branch that needs test coverage. Ask: can I tighten the type so this state is impossible?

**Removing type annotations to fix "unused" warnings.** The annotation might be providing real safety that tsc can't see. Fix the annotation pattern instead of removing safety.

**Fixing types in isolation.** Type changes ripple. Run the full type checker after each change, not just at the end.

**Widening a contract to make a caller happy.** If a caller can't satisfy the contract, fix the caller - don't weaken the contract.
