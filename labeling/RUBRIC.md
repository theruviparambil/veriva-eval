# Code-review judge rubric — v3.1

> This rubric evolved across three revisions, each closing a failure mode that
> surfaced when independent frontier models labelled the same findings and
> disagreed. The history stays because the *reasons* are the load-bearing part.
>
> **Version 3.1** — adds Critical principle 6 (the in-snippet guard establishes
> the precondition → TP) after the strict-NI rule was found to over-NI crash-class
> defects where the code guards for a null/empty case (`x ?? []`) then dereferences
> it unguarded. Principle 6 sharpens what "unconfirmable" means: the *possibility*
> of the bad input, not the specific caller. See the
> "guards-then-derefs-unguarded" calibration anchor.
>
> **Version 3** — adds an explicit **TP-threshold rule** (Critical principle 5)
> and a set of worked **calibration examples** after a multi-model panel showed
> *systematic* (not random) disagreement: raters split on *where the TP line
> sits*. Some confirmed the description and over-called TP; others reflexively
> FP/NI; and several confidently labelled real defects FP via reasoning errors
> (e.g. misreading Python `or` short-circuiting). Principles alone didn't pin the
> threshold — the worked examples below do. Match the *reasoning*, not the keywords.
>
> **Version 2** — tightened after a κ run revealed a **description-anchoring
> failure mode**: raters confirming the description's claim from the cited code
> instead of verifying it against context. The "verification protocol" and
> test-code rules below address that directly.

## Goal

For a given finding (from any review tool) on a given PR, decide
whether the finding describes a real defect that the developer should
act on. Grade every tool's findings against this rubric blind to which
tool produced them.

## Critical principles (read first)

The single most common rater failure: treating the finding's
description/title as **proven**, then confirming it from the cited
code. That's consistency-checking, not truth-checking.

Right mental model:

- **The description is a HYPOTHESIS** ("I claim defect X exists at
  this file:line").
- **The cited code is EVIDENCE** (what's actually written).
- **This rubric is the TEST** (what conditions must hold for the
  hypothesis to be a TP).

Your job is to apply the test, not confirm the hypothesis.

1. **Verify, don't confirm.** Read the cited code on its own. Does the
   defect _exist there as written_ — or only in the description's
   words? Example: a finding claims "recovery codes stored in
   plaintext" but the cited code sits inside a hashing pipeline that
   already converted plaintext to a hash upstream. The description is
   wrong → **FP**.
2. **Look at context, not just lines.** Upstream code (validators,
   hashers, sanitizers, framework primitives like Prisma's parameterized
   queries) and downstream code (consumers, output escaping) often
   resolve the concern entirely. Read at least 10 lines before/after.
3. **Apply the rubric's TP requirements explicitly**, not vibes. For
   SECURITY: reachable from external input AND concrete attack scenario
   AND meaningful risk reduction. All three, every time.
4. **Do not let the title's phrasing carry weight.** A finding titled
   "SQL injection in user query" on Prisma code is not TP just because
   "SQL injection" sounds bad.
5. **Unconfirmable from context → `NEEDS_INVESTIGATION`, never TP.**
   When a finding is plausible but its defect depends on code you cannot
   see — a concurrency model, another file, an interface's other
   implementations, whether a value can be null — the honest label is
   `NEEDS_INVESTIGATION`, naming the missing artifact. **Not TP.** A
   credible reviewer asserts only what the evidence substantiates and
   never publishes a finding it cannot stand behind — that discipline is
   what a high precision bar depends on. (It is also
   not an automatic `FP`: "I can't see the rest" is not evidence the
   defect is absent — name what you'd need and pick `NEEDS_INVESTIGATION`.)
6. **The in-snippet guard establishes the precondition → TP (v3.1).**
   "Unconfirmable" in principle 5 means the *possibility* of the bad input is
   unestablished. When the cited code itself guards for a null/empty/error
   case — `x ?? []`, `x?.y`, a `length === 0` check, a `try`/`catch` — and then
   uses that same value **unguarded** (e.g. `const [a] = arr ?? []; a.foo`), the
   guard is in-snippet proof that the bad input is expected. The internal
   inconsistency (guard for it, then dereference it unguarded) is a confirmable
   defect → **TP**, not NI. You need not prove a specific caller triggers it —
   the code's own guard establishes the precondition. This matters most for
   crash-class defects: a missed null-dereference costs far more than a one-line
   `?.` over-flag (risk asymmetry), and a reviewer would flag it on sight.

## Verification protocol (apply per finding)

Before deciding a label, answer all four:

1. **☐ Does the cited code, _as written_, contain the defect described
   — not just text matching the description's claim?**
2. **☐ Have you considered upstream code** (validators, hashers,
   sanitizers, framework primitives) that may handle the concern before
   this code runs?
3. **☐ Have you considered downstream code** (consumers, callers,
   output sanitization) that may make the concern moot?
4. **☐ Is the file path production code?** Not `testsuite/`,
   `__tests?__/`, `tests?/`, `spec/`, `vendor/`, `dist/`, `build/`,
   `node_modules/`, `.generated.*`, `*.min.*`, `*-lock.*`?

If any answer is "I'm not sure" → `NEEDS_INVESTIGATION`, naming the
specific missing artifact.
If any answer is "no" → `FP` (Q1-3) or `OUT_OF_SCOPE` (Q4).

## Labels

- **TP** (true positive) — the cited code, in its real-world context,
  contains a real defect or risk per the rubric. Developer should fix.
- **FP** (false positive) — the description is wrong as applied to
  this code. Either the defect doesn't exist (misread, upstream/
  downstream handles it, framework primitive prevents it) or the
  "issue" is stylistic preference rather than a defect.
- **NEEDS_INVESTIGATION** — you cannot decide without **specific**
  additional information. Name what's missing ("would need to see
  the calling middleware to confirm req.user is always set" / "would
  need to know whether the X env var is required by deploy"). Generic
  "I'd want more context" is not allowed — pick a leaning label
  instead.
- **OUT_OF_SCOPE** — finding is technically valid but not creditable
  because:
  - File path matches a test/vendor/generated glob (Q4 above)
  - Comment/docstring nitpick (no code defect)
  - File the PR didn't actually change
  - Duplicate of another finding in the same row

## Test-code disambiguation (v2)

A test file asserting _current_ behavior of production code (e.g.
`expect(payload).toEqual({…})`) is **not itself a defect**, even if the
description claims the asserted behavior is wrong. The defect (if any)
is in the production code that the test is asserting against — not the
assertion.

Label such findings:

- **FP** if the production behavior the test asserts is correct.
- **OUT_OF_SCOPE** if the rule fired on a test file when it should
  have fired on the production code being tested.

Do **not** label a "test asserts X" finding as TP just because "X is
wrong" — the test is the messenger, not the bug.

## Severity-specific rubric

Different finding categories require different bars for TP. The
verification protocol above applies to all.

### SECURITY findings (highest bar)

TP requires ALL of:

1. The cited code path is reachable from external input (or trusted
   internal input that crosses a boundary).
2. There is a concrete attack scenario or mishandled input — not a
   theoretical "what if".
3. The fix would meaningfully reduce risk (not just "cleaner code").

FP examples:

- "Use parameterized queries" on code that already uses Prisma (which
  parameterizes by default).
- "Validate input" on an internal function whose only callers already
  validated.
- Generic "consider rate limiting" with no specific endpoint.
- "Stored in plaintext" on code inside a hashing pipeline that already
  produced a hash upstream.

### QUALITY findings

TP requires:

1. The cited code has a concrete defect that would manifest at runtime
   (e.g. null dereference, race condition, off-by-one), OR
2. The code violates an invariant the surrounding codebase clearly
   relies on (e.g. mutating a frozen object, ignoring a documented
   precondition).

FP examples:

- "Consider extracting a helper" — opinion, not a defect.
- "This could be more readable" — taste.
- "Add JSDoc here" — DOCUMENTATION, not QUALITY.

### PRACTICES findings

TP requires:

1. The pattern flagged is genuinely problematic (e.g. ignoring promise
   rejections, swallowing errors silently, leaking secrets to logs).

FP examples:

- "Inconsistent naming" without a concrete bug from the inconsistency.
- "Not using the latest pattern" — stylistic.

### DOCUMENTATION findings

Almost always **OUT_OF_SCOPE** unless the missing/incorrect doc
actively misleads (e.g. a function comment that contradicts the
implementation in a way that would mislead future callers).

## Confidence calibration

Your `confidence` is part of the signal, not decoration. Reserve **100**
for cases where the rubric is unambiguous AND the cited code is fully
visible AND the defect (or non-defect) is clear without reading more. If
you would hesitate, or the call depends on code you cannot see,
confidence belongs in **[50, 90]** — and the label is usually
`NEEDS_INVESTIGATION`. Emitting `100` on every finding makes your column
useless for κ; a calibrated `70` is worth more than an over-confident
`100`.

## Calibration examples (worked borderline cases)

Real findings from the seven-rater panel where strong reasoners split.
Each gives the cited code, the correct label, the checkbox that drove it,
and why the tempting wrong call is wrong. **Match the reasoning, not the
surface keywords.** Note the shape: borderline findings are mostly `FP`
or `NEEDS_INVESTIGATION` — a real `TP` is one you can confirm from the
evidence in hand (the first example), not one you assume from the
description.

### TP — a confirmable true positive (contrast anchor)

- `SECURITY.SQL_INJECTION` — `src/routes/search.js`
- Cited: `db.query("SELECT * FROM products WHERE name = '" + req.query.q + "'")`
- **TP.** All three SECURITY conditions hold *on the snippet itself*:
  Q1 reachable (`req.query.q` is external HTTP input), Q2 concrete attack
  (`' OR 1=1; --`), Q3 the parameterized-query fix removes the surface.
  No unshown code is needed to confirm the defect — that is exactly what
  separates a TP from the `NEEDS_INVESTIGATION` cases below.

### TP — guards for empty, then dereferences unguarded (v3.1)

- `QUALITY` (null deref) — `EventManager.ts`
- Cited: `const [cal] = evt.destinationCalendar ?? []; if (evt.location === Meet && cal.integration !== "google_calendar")`
- **TP** (principle 6). The `?? []` is in-snippet proof the array can be empty —
  then `cal.integration` is dereferenced with no `?.`, so an empty array throws
  `TypeError`. The defect is confirmable from the snippet: the code guards for
  the empty case, then uses the value unguarded. Do NOT NI on "is the empty case
  reachable for this caller" — the guard already establishes the possibility;
  the fix is `cal?.integration`. Contrast the Python `or` NI case below, where
  nothing in the snippet established the value could be null.

### FP — security finding on a non-reachable path

- `SECURITY.SQL_INJECTION` — `migrations/…_rename_audit_cols.sql`
- Cited: `ALTER TABLE audit_log RENAME COLUMN ${columnName} TO ${newName};`
- **FP.** Fails SECURITY Q1. Migration files run by ops at deploy time;
  they are not reached by external user input, so there is no attack
  scenario. "String interpolation in SQL" *sounds* like injection, but
  reachability is the gate. Tempting wrong call: TP on the keyword.

### FP — the description's claim is contradicted by the cited code

- `QUALITY` (variable scope) — `handleCancelBooking.ts`
- Cited: `for (const credential of calendarCredentials) { const calendar = await getCalendar(credential); apiDeletes.push(calendar?.deleteEvent(...)); }`
- **FP.** The description claims `calendar` is referenced out of scope in
  an `else` branch and is `undefined`. The cited code shows `calendar`
  declared and used *inside* the loop — in scope — and the alleged `else`
  branch is not in the snippet. Q1 fails: the defect does not exist as
  written. Tempting wrong call: TP (even "ReferenceError") by trusting the
  description over the code. Description is hypothesis; code is evidence.

### FP — PRACTICES nitpick below the "genuinely problematic" bar

- `PRACTICES.UNUSED_IMPORT` — `src/providers/toast.tsx`
- Cited: `import { toast as hotToast } from 'react-hot-toast';`
- **FP.** An unused import is a lint nit with no runtime behaviour —
  below the PRACTICES bar. (And it may not even be unused — but either
  way, not a TP.)

### FP — exposing non-sensitive config is not a security defect

- `PRACTICES` — `pkg/api/dtos/frontend_settings.go`
- Cited: `AnonymousDeviceLimit int64 \`json:"anonymousDeviceLimit"\``
- **FP.** A capacity-limit value is operational metadata, not a secret;
  exposing it has no concrete attack scenario (the "craft limit-1 devices
  to abuse" concern exists whether or not the number is visible).
  Speculative "could be abused" is not a SECURITY TP.

### NEEDS_INVESTIGATION — defect depends on a nullability you cannot see

- `QUALITY` (null deref) — `organization_auditlogs.py`
- Cited: `enable_advanced = request.user.is_superuser or organization_context.member.has_global_access`
- **NEEDS_INVESTIGATION** — name the artifact: "can `member` be None for
  a non-superuser reaching this endpoint?" The crash requires a
  *non-superuser* (so the `or` does **not** short-circuit — it only
  short-circuits on a truthy *left*) **and** `member is None`. The
  nullability needs the endpoint's auth/membership model, which is not
  shown. Two wrong calls to avoid: (a) FP via "`or` short-circuits so the
  RHS is safe" — **false**, the RHS is evaluated whenever the left is
  falsy; (b) TP by assuming `member` can be None without confirming it.
  Confirm the language semantics, then NI on the unconfirmable fact.

### NEEDS_INVESTIGATION — defect depends on a concurrency model you cannot see

- `QUALITY.RACE_CONDITION` — `src/auth/session.ts`
- Cited: `if (token.expiresAt < Date.now()) { return await issueNewToken(userId); }`
- **NEEDS_INVESTIGATION** — "need whether concurrent refreshes for the
  same userId occur, and whether `issueNewToken` is idempotent." A
  two-line expiry-then-issue *looks* like a double-issue race, but whether
  the race is reachable depends on the unshown concurrency/locking model.
  Do not TP the pattern; do not FP it as "can't see it from two lines"
  either — name the missing artifact.

### NEEDS_INVESTIGATION — security claim whose reachability is unverified

- `SECURITY.SECRET_IN_CLIENT` — `src/lib/github/client.ts`
- Cited: `import { GITHUB_PAT } from '@/env';`
- **NEEDS_INVESTIGATION** — "does this module actually reach the browser
  bundle?" A server secret in the *client* bundle would be a real
  CRITICAL — but the file is `client.ts` in `lib/`, most likely a
  server-side API client, not a React client component. The description's
  "imported into a client component" is unverified. Confirm bundle
  reachability before asserting; until then, NI. Tempting wrong call: TP
  on the "PAT" + "client" keywords.

### NEEDS_INVESTIGATION — breakage hypothesis about code not in the diff

- `PRACTICES` (breaking change) — `metrics_middleware.go` / `ifaces.go`
- Cited: a renamed exported symbol / a new method added to a public interface
- **NEEDS_INVESTIGATION** — "are there implementations or callers outside
  this diff, and is this a supported external API?" The cited diff shows
  only the *new* symbol; whether anything breaks depends on unseen
  consumers. Real if external implementations exist, harmless if not — and
  the snippet cannot tell you which. Do not TP the hypothesis; do not
  FP-dismiss it as "invented" either.

## Process

1. **Pass 1**: read finding + open the linked PR file + line in
   browser. Read the surrounding code (≥10 lines before/after). Apply
   the rubric. Save label + 1-line reason.
2. **Pass 2 (separate session, 24h+ later if possible)**: re-label all
   from scratch without looking at pass-1 results. Same process.
3. **Reconcile**: where pass 1 ≠ pass 2, mark as ambiguous. Investigate
   each ambiguous one a third time, deciding the canonical label.
4. **Compute Cohen's κ** between pass 1 and pass 2. κ > 0.8 = strong,
   0.6–0.8 = substantial, < 0.6 = labels are unreliable.

## Reasons (free-text field)

Always include a 1-sentence reason that's anchored in the cited code
or specific context. Examples:

- TP: "auth.ts:47 dereferences req.user.id without checking req.user;
  route handler runs before middleware can produce undefined"
- FP: "rule fires on Prisma findUnique, which already returns null
  safely; no actual SQL injection surface"
- NEEDS_INVESTIGATION: "would need to know if the calling middleware
  always sets x-tenant-id; can't tell from this PR alone"
- OUT_OF_SCOPE: "comment-only change in this hunk; no actual code
  defect described"

Generic reasons ("looks fine" / "could be wrong") are not acceptable.

## Anti-patterns to avoid

- Labeling TP because the rule sounds reasonable in general, without
  checking that it applies on **this** code.
- Labeling FP because you disagree with the suggested fix — even if
  the fix is wrong, the underlying defect may be real.
- Skipping the surrounding code read. Always look at lines −10 to +10.
- Letting your own tool's findings get a more lenient bar than a
  competitor's, or vice versa. Same rubric, blind to provider.
- **Description-anchoring**: confirming the title from the cited code
  rather than verifying the defect from the cited code. (See "Critical
  principles" above.)
