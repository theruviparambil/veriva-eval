# Corpus selection criteria

The eval corpus is the regression suite for the review system under test. Today's
choices become tomorrow's regression coverage, so the bar is "would I expect the
reviewer to behave correctly on this PR?" rather than "is this the most
statistically representative PR?"

Build a corpus with `npm run corpus` (TS/JS) or
`node scripts/fetch-multilang-corpus.mjs --language=PY|GO|JAVA` (Python/Go/Java).
Both pull merged PRs from public repos via the `gh` CLI using the criteria below.

## Inclusion criteria

A PR is eligible iff **all** of:

1. **Merged** to a public OSS repo (state `closed` with `merged_at != null`).
   Open/abandoned PRs are excluded — we want ground truth.
2. **Primary changed language** matches the target (TS/JS, or PY/GO/JAVA).
3. **Diff size between 5 and 1500 added lines.** Tiny diffs (a README typo)
   generate no signal; huge diffs are usually mass renames or dependency bumps
   that distort cost and don't represent real review load.
4. **Recent (merged within the last 12 months).** Older PRs may reference
   deprecated APIs that inflate false-positive verdicts.
5. **Repo is recognizable.** Popular (>10k stars) or a recognizable domain
   (data infra, framework tooling, ORM) — not arbitrary toy repos.
6. **Linked issue or descriptive title** (`Fixes #...` / a classifiable title),
   so each row carries partial ground truth.

## Mix targets (per 100 PRs)

| Type               | Target | Rationale                                            |
| ------------------ | ------ | ---------------------------------------------------- |
| Bug fixes          | ~40    | Most common review case                              |
| Features           | ~30    | Where new code is introduced                         |
| Refactors          | ~15    | High false-positive risk for "this looks suspicious" |
| Security-tagged    | ~10    | Where a security-focused reviewer should shine       |
| Tests / CI / chore | ~5     | Sanity check that the reviewer doesn't over-flag     |

| Size class | Target | Definition           |
| ---------- | ------ | -------------------- |
| Small      | ~30    | 5-50 added lines     |
| Medium     | ~50    | 50-300 added lines   |
| Large      | ~20    | 300-1500 added lines |

Skewed samples (e.g. all-features) make precision/recall numbers
unrepresentative and brittle to corpus selection.

## Compounding principles

- Every PR in the corpus is permanent. Once a finding regresses on a PR, the fix
  gets a regression test pinned to that PR id.
- The corpus is versioned (`v1`, `v2`, …). Existing items are append-only unless
  a row is found invalid (deleted PR, repo rename); fixes go in the changelog.
- Run results are reproducible: same corpus + same reviewer version + same prompt
  version → same output (modulo model determinism).

## Multi-language expansion

The same criteria extend to Python, Go, and Java via
`scripts/fetch-multilang-corpus.mjs`, which keeps per-language repo allow-lists
and the same type/size mix so the sub-corpora are directly comparable. Reporting
precision/recall *per language* is more honest than one blended number — it
forces attention on the worst-performing language instead of hiding it in an
average.
