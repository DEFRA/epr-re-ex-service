# 50. Registration and accreditation status as a dated timeline

Date: 2026-09-04

## Status

Proposed. Amends [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md):
the validity dates and the entitlement rules stand, but the representation they are expressed
against changes. Two parts of ADR-0044 do not survive it — the transition table, and rules 4 and 5,
which define a change's effective date to be the moment it was recorded. A third, that reinstating a
registration does not revive its force-cancelled accreditation, is raised as an open question below
rather than settled here.

## Context

Classification asks one question of an accreditation, over and over: **on the date this load was
received, what was the operator's status?** A date is all it has to ask with — summary-log rows
carry a calendar date, not a time.

What we hold to answer it is a status history: an append-only list of changes as they were made,
each stamped with the moment it was recorded. As an audit trail that is the right shape. The
trouble is that we also ask it to be a statement of what was true on each day, and it is not shaped
for that. Four things follow, and all four are live today.

**A change is recorded when it is actioned, not when it takes effect.** An entry is
`{ status, updatedAt, updatedBy? }` and `updatedAt` is always `new Date()` at the moment of the
write. There is nowhere to put an effective date, so ADR-0044 papers over the gap twice: approval
carries a separate `validFrom` because the determination date is rarely the day it was recorded
(rule 3), while suspension and cancellation are simply declared to take effect from their recording
timestamp (rules 4 and 5). When a regulator tells us about something that happened last month, the
only way to record it is to write down a moment that is not when we were told.

**So correcting the past means editing the past.** PAE-1809 added exactly that: the admin raw-JSON
editor accepts a rewritten `statusHistory`, letting an admin change any entry's `updatedAt`, and the
`status` of any entry after the first, in place. Redating the opening `created` entry shifts every
downstream answer to "was it live yet". It is guarded — entries cannot be added, removed or
reattributed, the history must still open at `created`, dates must stay strictly ascending, and the
result must walk a transition table — but that table is the routes' table with `approved → cancelled`
added, so that cascade-produced histories remain editable, and it is applied differently: across
adjacent pairs of a whole history, skipping pairs where the status is unchanged. Rewriting an entry
to match its neighbour is therefore explicitly permitted, which is to say a historical suspension can
be neutralised in the record itself, with only the system log holding what it said before.
`unnumbered-accreditation.js` already carries a comment conceding the point: the history is evidence,
not proof.

**The history has finer resolution than the question, and the two are reconciled inconsistently.**
Two changes on the same day are distinguishable in the events but invisible to the question, so the
earlier one is silently dropped the moment it starts to matter. Worse, the comparison itself is
wrong. `isWithinAccreditationDateRange` truncates
both sides to a calendar date, but `isSuspendedOrCancelledAtDate` compares the entry's millisecond
`updatedAt` against `new Date(loadDate)` — midnight. A suspension recorded at 14:22 on 15 March is
not at or before 15 March 00:00, so the finder skips it and falls through to the previous entry:
**loads dated 15 March count as pre-suspension**. Every suspension and cancellation quietly takes
effect the day after it is actioned, purely because the clock time is non-zero. Had the entry been
written at exactly midnight UTC it would have applied same-day. This contradicts ADR-0044 rules 4
and 5, and nothing in the model makes it visible.

**No single value answers the question, so every consumer answers it differently.** ADR-0044 has to
instruct consumers to combine the validity window with the status history, because neither alone is
enough. Predictably, they have diverged. There are at least five predicates asking the question, and
four of them sit in one file: `isRegistrationAccredited`, `resolveAccreditation`,
`resolveAccreditationNumber` and `activeAccreditationValidFrom` all read only the _current_ status,
while `isAccreditedAtDates` reads the window and the history at a date.

They disagree with each other in production. `isAccreditedAtDates` was deliberately written so that
a cancelled accreditation keeps the window it held while it was live, and both the credited-tonnage
report and the submit-time classifier depend on that — the report says so in a comment. But
`live-classified-row-states` and the CSV export resolve their accreditation through
`resolveAccreditation`, which returns `null` for anything not approved or suspended. So the same
rows are credited when they are submitted and reported as not applicable when they are read back.
ADR-0030 records a third axis again: the template check keys on `accreditationNumber`, which a
cancellation never clears.

Underneath all of it, current status is read from the **last array element** while status-at-a-date
is read from a **descending timestamp sort** — two orderings over one array, with no invariant in
the schema or the repository tying them together. Only the PAE-1809 edit route checks ordering at
all, and the dev-seeding route skips every guard.

The events are worth keeping. They are being asked to be something they are not.

## Decision

Today's status history does three jobs at once: it is the audit trail, it is where the current
status is read from, and it is where "what was true on date D" is read from. Almost everything in
the Context above is a symptom of that overloading. Split it, across three layers:

1. **Commands** — what a regulator asks for.
2. **Events** — what a command produces. The audit trail, and nothing else.
3. **The timeline** — a projection from the events. One status per day. What classification reads.

**Two things carry the decision.** The events are the audit trail, and the timeline is a projection
from them — never written directly, and with no second input. Everything else here follows from
those two, and would be revisited rather than rewritten if they changed.

Settling them does settle some further things, and they should be visible rather than smuggled in.
This ADR also fixes the timeline's own shape and read rule, the tie-break where two events claim one
day, the contract the projection needs from whatever the events turn out to be, that granting or
amending a validity window produces events like anything else, and that an accreditation's liveness
is derived rather than cascaded onto it. Each is argued for in its own section below.

What is **not** settled is the shape of the commands or the shape of the events. Both depend on what
regulators need to express, and neither has to be answered for the projection to be right. Open
shape is not open contract, though: projecting a timeline asks certain things of whatever the events
turn out to look like, and those are set out below.

### Commands: deliberately open-ended

A command is a regulator's instruction, and its vocabulary should follow what regulators actually
need to express rather than what is convenient to store. "Set this record to this state for this
period" is one plausible shape, and there are others; the choice depends on questions we have not
answered yet. Note that it is not for this ADR to say how many events such a command produces —
one carrying the period, or two bounding it, are both open — only that the timeline ends up with
two entries either way.

Note what this buys: **a period-shaped command does not imply a period-shaped representation.** A
regulator can say "suspended for March" while the timeline still holds only
`2026-03-01: suspended` and `2026-04-01: approved`. The `to` lives in the asking, where a person
naturally puts it, and never in the representation, where it would let gaps and overlaps be written
down. This is worth stating plainly because the instinct to carry a `to` through into the
representation is strong and the two concerns look alike.

### Events: the audit trail, and only that

A command produces one or more events. Their shape follows the commands, and they may be
considerably richer than a bare status change — carrying the regulator's intent, the instrument or
correspondence behind it, or whatever else a command turns out to need to preserve. That is left
open.

Four things are asked of them regardless. These are the contract the projection depends on, and
they are as much part of this decision as the projection itself:

- **They are append-only and never rewritten.** This is what the current model cannot offer, and
  the reason PAE-1809 had to add in-place editing of historical entries.
- **They carry enough to serve as an audit trail** — who, when, and why. Today's entries do not:
  `updatedBy` is in the schema but no code path populates it, and there is no reason field at all.
- **They can say when a change takes effect separately from when we were told about it.** Today's
  single `updatedAt` conflates the two, which is precisely why a retrospective change currently
  requires editing history. Separate them and a correction becomes a new event stating an earlier
  effective date; nothing already written is touched.
- **They have a deterministic order of recording.** Two events can claim the same effective date,
  and the projection has to resolve them the same way every time it runs.

One shape that satisfies all four, by way of illustration only:

```json
{
  "status": "suspended",
  "effectiveFrom": "2026-03-15",
  "recordedAt": "2026-04-02T14:22:07.913Z",
  "recordedBy": "…",
  "reason": "…"
}
```

An effective date expressed as a calendar date also removes the midnight-comparison defect at
source, rather than patching the comparison.

### The timeline

From the events we project a **status timeline**: a map from date to status.

```json
{
  "status": {
    "2026-01-01": { "status": "approved" },
    "2026-03-15": { "status": "suspended" },
    "2026-04-01": { "status": "approved" },
    "2027-01-01": { "status": "ended" }
  }
}
```

**The status on date D is the value at the greatest key less than or equal to D.** Before the first
key there is no status: the record did not yet have one.

The shape is chosen for what it makes impossible:

- **One status per day, by construction.** The keys are dates, so a day cannot appear twice. The
  representation has exactly the resolution the question has, and there is one comparison regime
  rather than two.
- **No `to`.** An entry runs until the next one. Gaps and overlaps — the two failure modes that make
  time-series data untrustworthy — cannot be written down.
- **Termination is an entry like any other.** The timeline is total: "what was the status a week
  after it ended?" answers "ended", rather than falling off the end of a window into whatever each
  consumer decided to do about that.
- **One ordering.** The current status is the greatest key not in the future — the same lookup, with
  today as the date. The array-position reading and the timestamp reading collapse into one.
- **A retrospective change needs no special handling.** The events absorb it, and the timeline is
  simply reprojected.

Where several events share an effective date, the day projects to **the last recorded** of them —
the state the record was in at the end of that day. This preserves the _outcome_ ADR-0044 rules 4
and 5 intend — a load dated on the day of a suspension is excluded — while discarding how they
reach it. Those rules get there by declaring the recording timestamp to be the effective date,
which is the conflation this ADR removes.

An event effective after the window has closed **extends the timeline** rather than being dropped:
its entry sits after the closing one and supersedes it, exactly as any later entry supersedes an
earlier one. So the claim above is that gaps, overlaps and duplicate days are unrepresentable — not
that a state cannot outlive its window. It can, and it should: a regulator reinstating an
accreditation after it expired is a real thing to record, and refusing the event would break the
guarantee that everything the timeline says is accounted for in the events.

### The timeline always agrees with the events

Being a projection is a property to hold, not just a way to build one. Whatever a consumer reads has
to be what the events say, every time it is read.

Worth naming the trap, because this service has hit it: [ADR-0047](./0047-reconcile-stale-prn-projections.md)
exists because a projection's self-healing held for records that keep transitioning and failed for
dormant ones. A status timeline is dormant by construction — a cancelled or expired accreditation
stops receiving events but goes on being read for years, by the credited-tonnage report and the
submit-time classifier among others. Deriving it wherever it is read cannot drift. Anything else is
an optimisation, and ADR-0047 sets out what an argument for one has to carry.

### Validity dates

`validFrom` and `validTo` remain facts about the accreditation: the entitlement window, determined
by the regulator, and what ADR-0044 says about them stands. They are also what opens and closes the
timeline — `validFrom` opens it as `approved`, and the day after `validTo` closes it as `ended`.

**So granting or amending a window has to produce events too**, or the timeline would have a second
input that moves without one, and it would no longer be true that everything the timeline says is
accounted for in the audit trail. This is not a technicality. Today, amending an accreditation's
window silently restates the classification of every load ever submitted under it, with no record
of what the window used to be — the same defect as editing a status entry in place, in a different
field. Bringing validity changes into the event stream closes both at once.

Registrations no longer carry a `validTo` (PAE-1904), so a registration timeline opens at
`validFrom` and closes only when something closes it.

Classification, then, reads the timeline alone. ADR-0044's standing instruction to combine the
window with the history goes away, and with it the opportunity for each consumer to combine them
slightly differently.

### Registration takes the same shape

Classification already consults both records, so both get a timeline, and an accreditation's
liveness on date D is derived from the two together. That replaces the cancellation cascade, which
today reaches across and writes `cancelled` onto the accreditation's own history — deliberately
bypassing the transition table to do it, since no user-driven arc allows `approved → cancelled`.
Deriving removes the write, the bypass, and the class of defect around them.

It also changes behaviour on appeal, which is open question 2 below.

## What this deliberately does not decide

**The shape of the commands, the shape of the events, and whether the business rules for moving
between statuses are ours to enforce.** All three wait on the same thing: what regulators need to achieve, and where they
consider the authority to sit. They may govern transitions out of band and use this service only to
tell us what is true, or the rules may be ours.

Nothing above depends on the answer. The timeline records what was true on each day without
asserting anything about which sequences of days are legal, and it is reached by projection whatever
sits upstream of the events.

What the shape does settle is **where enforcement could live, if it is ours.** Not on the timeline.
The timeline is lossy by design — one status per day — so it cannot see two changes within a day and
cannot see the order they were made in. Guards need both. They belong on the commands and the events,
which keep full resolution and ordering, and which are a record of what a regulator actually did. If
the rules turn out not to be ours, regulators assert dated statuses, there is nothing to guard, and
the projection is unaffected either way.

Either way, **ADR-0044's transition table cannot stand as written.** It validates a
`fromStatus → toStatus` pair, which is only meaningful for a change at the end of the timeline.
Record an event making 15 March `suspended` when the timeline already holds 1 April `approved`, and
you have manufactured a `suspended → approved` pair nobody performed. Enforcement, if we keep any,
has to be expressed against the command a regulator is issuing, not against pairs read back out of a
reordered history. The table has already failed to hold still: the JSON editor's variant accepts
`approved → cancelled`, because the routes' table refuses to produce a history the cascade
nonetheless creates. And the routes' table was never ADR-0044's table either — both
`VALID_REG_TRANSITIONS` and `VALID_ACC_TRANSITIONS` permit `approved → created`, which appears in
neither of ADR-0044's tables.

## Open questions

These are not rhetorical. Each needs an answer before the ADR can be accepted, and neither is a
modelling question the engineering team should settle alone.

**1. Is this a status timeline or an entitlement timeline?** The two readings are not compatible and
the document above leans on both.

Accreditation statuses are `created`, `approved`, `rejected`, `cancelled` and `suspended`. If the
timeline is the record's status over time, then `created` opens it — not `validFrom` — and `rejected`
needs a place on it. If instead it is the record's _entitlement_ over time, `created` and `rejected`
are application-lifecycle facts that never belonged on it, `ended` is a reasonable name for expiry,
and the admin UI keeps reading a separate current status for its tag. Classification only ever wanted
the entitlement reading.

The awkward consequence of choosing entitlement is that a grant back-dates it. ADR-0044 rule 3 says
`validFrom` may fall before the day approval was recorded, so a January `validFrom` granted in April
projects `approved` across three months the record spent under consideration. That is right for the
waste balance and wrong as a statement of what was true, which is why the two readings have to be
told apart and the timeline named for whichever it is.

**2. Should reinstating a registration revive the accreditation it force-cancelled?** ADR-0044 says
no: a cancelled registration force-cancels its accreditation, and reinstating the registration
deliberately leaves the accreditation cancelled, so an appeal cannot silently restore an
accreditation the regulator never re-granted.

Deriving liveness from both timelines reverses that, because the accreditation's own timeline never
recorded the force-cancellation and so has nothing to stop the derivation. Keeping ADR-0044's
behaviour means giving the accreditation its own terminal entry that derivation cannot override —
which brings back a write across records, though a smaller and more honest one. This is a question
about what an appeal should mean, not about how to model it.

## Consequences

### Positive

- Classification reads one value from one place, at the resolution the question is asked in. The
  midnight-comparison defect cannot be expressed.
- Retrospective correction is an ordinary event, and never edits or falsifies what was recorded.
- Gaps, overlaps, duplicate days and a current status that disagrees with the history all become
  unrepresentable rather than guarded against.
- One ordering replaces two, and the five divergent accredited-ness readers can be reconciled onto a
  single one.
- The status history stops doing three jobs and does one. The events are freed to be an audit
  trail: full resolution, ordered, attributed, never rewritten.

### Negative

- **The timeline is lossy, and that is the point.** Anything needing sub-day resolution, ordering,
  attribution or the reason for a change reads the events instead. Two things to consult where there
  was one, and a clear rule about which answers what.
- The projection rule — the last recorded event for a day wins — is a decision every consumer
  inherits without seeing it. It belongs stated where the projection is built.
- Existing histories carry no effective date, and their `updatedAt` values are not all recording
  moments: PAE-1809 lets an admin retype any of them, and the dev-seeding route writes histories
  with no guards at all. So a backfill is not simply reading recorded moments as effective dates —
  it cannot tell which stored values were ever meant as recording timestamps in the first place,
  and only the system log distinguishes them. That is a harder question to put to a regulator than
  "which of these dates are wrong".
- Both representations are live during adoption, and consumers move across one at a time.
- A projection has to be kept in step with the events it derives from. That is an obligation the
  current single-array model does not carry, and ADR-0047 is the record of what happens when it is
  not met.
- ADR-0044 needs revising. Its entitlement rules and validity dates survive; its transition table
  does not, nor do rules 4 and 5, which define a change's effective date as the moment it was
  recorded — the outcome they intend is preserved, their mechanism is not. Its instruction to
  combine the window with the history goes too, and the PAE-1809 edit route is superseded rather
  than amended.

## Related

- [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md) — the validity dates
  and status-management rules this amends
- [ADR-0030](./0030-registered-only-edge-cases.md) — records the divergent classification axes this
  is intended to reconcile. Rejected, and retained as a point-in-time record rather than a living
  specification, so some of its detail has since been overtaken by the code
- [ADR-0034](./0034-multi-year-accreditation-model.md) — one accreditation per scheme year, so one
  timeline per accreditation
