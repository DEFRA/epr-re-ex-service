# 51. Registration and accreditation status as a dated timeline

Date: 2026-09-04

## Status

Proposed. Amends [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md).
Its entitlement rules and a registration's `validFrom` stand. An accreditation's `validFrom` and
`validTo` are replaced by a scheme `year`. Its transition table does not survive, nor do rules 4
and 5, which define a change's effective date as the moment it was recorded. Whether reinstating a
registration revives its force-cancelled accreditation is an open question below.

## Context

Classification asks one question of an accreditation, over and over: **on the date this load was
received, what was the operator's status?** It asks with a calendar date, because that is all a
summary-log row carries.

What we hold to answer it is a status history: an append-only list of changes, each stamped with
the moment it was recorded. That is the right shape for an audit trail. It is the wrong shape for a
statement of what was true on each day, and we use it as both. Four problems follow, all live
today.

**A change is recorded when it is actioned, not when it takes effect.** An entry's `updatedAt` is
always the moment of the write, and there is nowhere to put an effective date. ADR-0044 works
around the gap twice: approval carries a separate `validFrom` (rule 3), while suspension and
cancellation are declared to take effect from their recording timestamp (rules 4 and 5). When a
regulator tells us about something that happened last month, we cannot record it truthfully.

**So correcting the past means editing the past.** PAE-1809 lets an admin rewrite `statusHistory`
in place: any entry's `updatedAt`, and the `status` of any entry after the first. The edit is
guarded, but the guards permit rewriting an entry to match its neighbour. A historical suspension
can be removed from the record itself, with only the system log holding what it said before.

**The history has finer resolution than the question.** Two changes on one day are distinct in the
history, but the question can see only one of them. The comparison is also wrong.
`isSuspendedOrCancelledAtDate` compares an entry's millisecond `updatedAt` against midnight on the
load date, so a suspension recorded at 14:22 on 15 March does not apply to loads dated 15 March.
Every suspension and cancellation takes effect the day after it is actioned, which contradicts
rules 4 and 5.

**No single value answers the question, so consumers answer it differently.** ADR-0044 has to tell
consumers to combine the validity window with the status history, and at least five predicates now
do so. They disagree in production. The submit-time classifier and the credited-tonnage report let
a cancelled accreditation keep the window it held while it was live. `live-classified-row-states`
and the CSV export treat anything not approved or suspended as unaccredited. So the same rows are
credited when they are submitted and reported as not applicable when they are read back.

## Decision

Today's status history does three jobs: it is the audit trail, it is where the current status is
read from, and it is where "what was true on date D" is read from. Split it across three layers:

1. **Commands** are what a regulator asks for.
2. **Events** are what a command produces. They are the audit trail, and nothing else.
3. **The timeline** is a projection from the events, with one status per day. It is what
   classification reads.

Two things carry the decision. The events are the audit trail, and the timeline is a projection
from them, never written directly and with no second input. The shapes of the commands and of the
events are left open.

### Commands

A command's vocabulary should follow what regulators need to express, which we have not yet
established. "Set this record to this state for this period" is one plausible shape.

**A period-shaped command does not imply a period-shaped representation.** A regulator can say
"suspended for March" while the timeline holds only `2026-03-01: suspended` and
`2026-04-01: approved`. The `to` lives in the asking and never in the representation, where it
would let gaps and overlaps be written down.

### Events

A command produces one or more events. Their shape follows the commands, and they may carry far
more than a bare status change. The projection needs four things of them whatever shape they take:

- **They are append-only and never rewritten.**
- **They carry who, when and why.** Today `updatedBy` is in the schema but nothing populates it,
  and there is no reason field.
- **They say when a change takes effect separately from when it was recorded.** A correction is
  then a new event with an earlier effective date, and nothing already written is touched.
- **They have a deterministic order of recording,** because two events can claim the same
  effective date.

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

An effective date held as a calendar date also removes the midnight-comparison defect at source.

### The timeline

From the events we project a **status timeline**: a map from date to status.

```json
{
  "status": {
    "2026-01-01": { "status": "approved" },
    "2026-03-15": { "status": "suspended" },
    "2026-04-01": { "status": "approved" }
  }
}
```

**The status on date D is the value at the greatest key less than or equal to D.** Before the first
key the record has no status.

The shape is chosen for what it makes impossible:

- **One status per day.** The keys are dates, so a day cannot appear twice, and the representation
  has exactly the resolution the question has.
- **No `to`.** An entry runs until the next one, so gaps and overlaps cannot be written down.
- **No terminal entry.** An accreditation's timeline covers its scheme year, and outside that year
  the accreditation does not apply.
- **One ordering.** The current status is the same lookup with today as the date.

Where several events share an effective date, the day takes **the last recorded** of them. This
keeps the outcome ADR-0044 rules 4 and 5 intend, that a load dated on the day of a suspension is
excluded.

An event dated outside the accreditation's scheme year is recorded rather than refused. It has no
effect on classification, which only asks about dates within the year.

**Whatever a consumer reads has to be what the events say, every time it is read.**
[ADR-0047](./0047-reconcile-stale-prn-projections.md) exists because a stored projection healed
itself only for records that kept changing. A status timeline is dormant by construction: a
cancelled accreditation stops receiving events but is read for years. Deriving the timeline
wherever it is read cannot drift. Anything else is an optimisation, and ADR-0047 sets out what an
argument for one has to carry.

### Validity dates

An accreditation carries a `year` instead of `validFrom` and `validTo`. ADR-0034 already gives one
accreditation per scheme year, so the year bounds its timeline: 1 January to 31 December. A
registration keeps `validFrom`, which opens its timeline, and has no `validTo` (PAE-1904).

**Anything that changes what the timeline says has to be an event,** or the timeline would have a
second input that the audit trail does not account for. So an accreditation's grant is an event
dated at the approval's effective date, and granting or amending a registration's `validFrom`
produces events too. Today, amending an accreditation's window silently reclassifies every load
submitted under it, with no record of what the window used to be.

Classification then reads the timeline alone. ADR-0044's instruction to combine the window with the
history goes away.

### Registration takes the same shape

Classification already consults both records, so both get a timeline, and an accreditation's
liveness on date D is derived from the two together. That replaces the cancellation cascade, which
today writes `cancelled` onto the accreditation's own history and bypasses the transition table to
do it. It also changes behaviour on appeal, which is open question 2.

## What this does not decide

**The shape of the commands, the shape of the events, and whether the rules for moving between
statuses are ours to enforce.** All three wait on what regulators need to achieve and where they
consider the authority to sit. Nothing above depends on the answer.

If the rules are ours, they are enforced on the commands and the events, not on the timeline. The
timeline holds one status per day, so it cannot see two changes within a day or the order they were
made in, and guards need both.

Either way, **ADR-0044's transition table cannot stand as written.** It validates a
`fromStatus → toStatus` pair, which only means something for a change at the end of the timeline.
Record an event making 15 March `suspended` when the timeline already holds 1 April `approved`, and
you have manufactured a `suspended → approved` pair nobody performed. The code has already moved
away from the table: the routes permit `approved → created`, and the PAE-1809 editor permits
`approved → cancelled`, and neither appears in ADR-0044.

## Open questions

Each needs an answer before this ADR can be accepted, and neither is for the engineering team to
settle alone.

**1. Is this a status timeline or an entitlement timeline?** Accreditation statuses are `created`,
`approved`, `rejected`, `cancelled` and `suspended`. If the timeline is the record's status over
time, `created` opens it and `rejected` needs a place on it. If it is the record's _entitlement_
over time, `created` and `rejected` are application-lifecycle facts that do not belong on it, and
the admin UI reads a separate current status. Classification only ever wanted the entitlement
reading.

Choosing entitlement means a grant back-dates it. An approval effective in January but granted in
April projects `approved` across three months the record spent under consideration. That is right
for the waste balance and wrong as a statement of what was true.

**2. Should reinstating a registration revive the accreditation it force-cancelled?** ADR-0044 says
no, so that an appeal cannot silently restore an accreditation the regulator never re-granted.
Deriving liveness from both timelines reverses that, because the accreditation's own timeline never
recorded the force-cancellation. Keeping ADR-0044's behaviour means giving the accreditation its own
terminal entry that derivation cannot override, which brings back a smaller write across records.
This is a question about what an appeal should mean, not about how to model it.

## Consequences

### Positive

- Classification reads one value from one place, at the resolution the question is asked in, and
  the five divergent readers can be reconciled onto it.
- A retrospective correction is an ordinary event, and never edits what was recorded.
- Gaps, overlaps, duplicate days and a current status that disagrees with the history become
  unrepresentable rather than guarded against.

### Negative

- The timeline is lossy by design. Anything needing sub-day resolution, ordering, attribution or the
  reason for a change reads the events instead, so there are two things to consult where there was
  one.
- Every consumer inherits the rule that the last recorded event for a day wins, without seeing it.
- Existing histories carry no effective date, and a backfill cannot simply read `updatedAt` as one.
  PAE-1809 lets an admin retype any of those values, and only the system log shows which were ever
  recording moments.
- Both representations are live during adoption, and consumers move across one at a time.
- Accreditations need migrating from `validFrom` and `validTo` to `year`, and PRN year attribution,
  which ADR-0044 takes from `validFrom`, reads `year` instead.
- ADR-0044 needs revising as set out under Status, and the PAE-1809 edit route is superseded.

## Related

- [ADR-0044](./0044-registration-and-accreditation-validity-and-status-rules.md) — the validity
  dates and status-management rules this amends
- [ADR-0030](./0030-registered-only-edge-cases.md) — records the divergent classification axes this
  is intended to reconcile. Rejected, and retained as a point-in-time record
- [ADR-0034](./0034-multi-year-accreditation-model.md) — one accreditation per scheme year, so one
  timeline per accreditation
- [ADR-0047](./0047-reconcile-stale-prn-projections.md) — what happens when a projection is not
  kept in step with its source
