# Independent rater handoff: inter-vendor Cohen's κ panel

## What this is for

A precision/recall claim about an LLM-as-judge is only trustworthy if
independent raters (models that don't share architecture or training)
agree on the labels. Cohen's κ between independent raters tells you
whether the rubric is well-defined enough that different reasoners assign
the same TP / FP / NEEDS_INVESTIGATION / OUT_OF_SCOPE.

You (the model reading this) are one rater on the panel. Your identity
(model + a `rubricVersion` tag) comes from the `rater-prompts/` template
you were started with. Each rater writes under a unique `(model,
rubricVersion)` tuple so the comparison keeps them cleanly separated.

The reference panel is seven models across seven vendors, the same families
shipped in `data/panel-real/`:

| Rater    | Vendor    |
| -------- | --------- |
| claude   | Anthropic |
| gpt      | OpenAI    |
| gemini   | Google    |
| grok     | xAI       |
| qwen     | Alibaba   |
| deepseek | DeepSeek  |
| glm      | Zhipu     |

Cross-family is the point: same-family raters share blind spots and inflate
agreement. The panel mixes vendors so κ measures rubric clarity, not shared
training.

## The file contract (no database, no network)

Everything is plain files so the panel runs anywhere:

- **Input**: `findings.jsonl`, one finding per line, of this shape:
  ```
  {
    "findingId": "…",            // opaque id, echoed back in your output
    "ruleId": "SEC-002",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
    "category": "SECURITY|QUALITY|PRACTICES|DOCUMENTATION|SUPPLY_CHAIN",
    "language": "typescript|python|go|…",
    "filePath": "src/lib/foo.ts",
    "startLine": 42, "endLine": 56,
    "title": "…", "description": "…", "codeSnippet": "…"
  }
  ```
- **Output**: `verdicts-<key>.jsonl`, one line per finding, of this shape:
  ```
  {"findingId":"…","label":"TP","confidence":85,"reasoning":"≤500 char rationale anchored in the cited code"}
  ```
  - `label` ∈ `{TP, FP, NEEDS_INVESTIGATION, OUT_OF_SCOPE}`, uppercase.
  - `confidence` ∈ `[0,100]`. Reserve ≥95 for unambiguous calls on fully
    visible code. If you'd hesitate, use `[50, 90]`.
  - `reasoning` cites the specific verification-protocol checkbox from
    `RUBRIC.md` that drove the call. Generic reasons are not acceptable.

## What you must NOT see (anti-anchoring)

The whole value of an extra rater is an *independent* signal. So:

- Do **not** read any other rater's `verdicts-*.jsonl`.
- Do **not** read `cohens-kappa.mts` / `rater-reliability.mts` "to check
  your work". That's a side channel to the other raters' labels.
- Do **not** try to predict what another model would say and match it.

If you're unsure whether some context is anchoring, skip it.

## Calibration discipline (read carefully)

- **Description-anchoring**: confirming the title from the cited code
  instead of verifying the defect against context. The dominant failure
  mode; the rubric's verification protocol exists to kill it.
- **Sycophancy**: labeling TP because the description sounds plausible.
  The defect must exist in the cited code on this PR, in context.
- **Confidence inflation**: 100 on calls a careful human would hesitate
  on makes your column useless for κ.
- **Confidence deflation**: labeling everything NEEDS_INVESTIGATION to
  dodge commitment. NI is valid only when you can name a specific missing
  artifact.

## Steps

1. Read `RUBRIC.md`. The verification protocol is load-bearing: apply it
   per finding.
2. Label every line of `findings.jsonl` cold, sequentially, at your
   model's max reasoning effort. Read the cited code before deciding.
3. Write `verdicts-<key>.jsonl`.
4. Measure agreement:
   - Two passes from the same rater (intra-rater reliability):
     `npm run kappa -- --pass1=verdicts-a.jsonl --pass2=verdicts-a-pass2.jsonl --out=kappa.json`
   - The full shipped panel (inter-rater): `npm run replay`.

Flush any pre-existing context about the codebase before you start. You
are a cold, independent rater applying the rubric. Nothing else.
