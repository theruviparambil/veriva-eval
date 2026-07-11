# Results: validating an LLM judge

This repo ships the methodology and tooling plus a redacted real run. The full
private corpus stays private, but two panels are included: a synthetic sample
(`npm run replay`, the zero-key default) and a **redacted real panel** of seven
frontier models over 23 findings from public-OSS PRs (`npm run replay:real`).

```
npm run replay        # synthetic sample
npm run replay:real   # redacted real 7-model panel
```

`replay` reads a rater panel (a `truth.json` plus one `<model>.jsonl` per model)
and computes, for each model, its recall and precision against the adjudicated
truth, then panel-level agreement with **Fleiss' κ and Krippendorff's α** (the
recognized statistics for more than two raters). Point it at your own export with
`--dir=path/to/panel`.

## What it shows

The models disagree, and the disagreement is the signal:

- Some models catch nearly every real finding but over-call (high recall, lower
  precision). Others fire rarely but are almost always right (low recall, high
  precision). On the synthetic sample one rater labels everything a true positive
  and lands at κ ≈ 0: the rubber-stamp failure mode, made visible.
- Panel agreement (Fleiss' κ and Krippendorff's α) across independent frontier
  models tends to be *low*, often "poor" to "fair" on the standard scale. That
  isn't a flaw. They genuinely split on hard findings. A single judge hides that
  variance behind one confident answer; a panel measured by these coefficients
  surfaces it, which is what the human adjudication step then resolves. (Pairwise
  Cohen's κ is also reported, but only as a per-rater redundancy view.)

This is the core lesson: **you validate an LLM judge the way you validate human
raters, with chance-corrected agreement, not accuracy.** On an imbalanced label
set, a judge that always picks the majority class scores high "accuracy" and adds
zero signal; κ exposes it as noise (see `src/__tests__/kappa.test.ts` for a test
that proves exactly this).

## Adversarial cross-model review

The panel is one half of the method. The other is using a *different* model to
attack a result rather than confirm it.

In the system this harness came from, an adversarial review by an independent
model (told to refute, not agree) caught a **train/serve skew** in a calibration
scorer: the trainer was learning from a feature the runtime serves as `null`, so
the lab number could never be reproduced in production. A single model grading
its own work would not have caught it. A second, independent model told to break
it did.

That is the generalizable takeaway, not any one number. The most valuable thing
an eval can do is falsify a result you already believed.

## On absolute numbers

Be careful with headline precision/recall figures:

- Measuring a model against labels produced by a similar model (or rubric) is
  partly circular: you measure agreement with yourself, not correctness.
  Cohesion is not accuracy.
- Absolute numbers move with the label set. The defensible claims are the
  **controlled comparisons** (same corpus, same seed, one variable changed) and
  the **methodology**, not a single precision figure quoted out of context.
- A number measured against your own labels will not match a number measured
  against independent ground truth. The honest move is to report both and treat
  the gap as a finding, not to publish the friendlier one.

## See also

- [`../labeling/RUBRIC.md`](../labeling/RUBRIC.md): the judge contract + calibration anchors.
- [`corpus-criteria.md`](./corpus-criteria.md): how the evaluation corpus is selected.
