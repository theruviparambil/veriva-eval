# veriva-eval

An eval harness for LLM-as-judge systems. It validates the judge the way you'd
validate a panel of human graders: with inter-rater agreement (Fleiss' κ and
Krippendorff's α), not accuracy. Before you trust a model to grade AI-generated
code, you first prove the grader itself is reliable.

Extracted from a production AI code-governance pipeline. This repo ships the
**methodology and tooling** (the judge, the κ validation, the rubric, the
benchmark harness) plus a **redacted real run**: seven frontier models scored
over 23 findings from public-OSS pull requests, with `npm run replay:real`. The
private corpus stays private, but you can reproduce the real panel's agreement
numbers yourself, and a synthetic sample lets you see the machinery with zero
setup. Self-contained, MIT, no cloud account required.

## Quickstart (no key needed)

```bash
npm install
npm run replay
```

`replay` reads a rater panel (a `truth.json` plus one `<model>.jsonl` per model),
computes each model's recall and precision against the adjudicated truth, and
reports panel-level agreement with **Fleiss' κ and Krippendorff's α** (the
recognized statistics for more than two raters; averaging pairwise Cohen's κ is
not). The default panel under `data/sample/panel/` is **synthetic**. Point it at
your own export with `--dir=path/to/panel`.

On the synthetic panel you'll see per-model recall/precision, then panel agreement:

```
rater       recall (caught real TP)   precision (TP calls correct)
model-a     100% (5/5)                63% (5/8)
model-b     40% (2/5)                 100% (2/2)
model-c     80% (4/5)                 100% (4/4)

Fleiss' kappa:        -0.018 (poor)
Krippendorff's alpha:  0.024 (poor)
```

`model-a` catches every true positive but over-calls; `model-b` fires rarely but
is never wrong. They genuinely disagree. A single judge hides that variance; a
panel measured by κ exposes it, which a human adjudication step then resolves.

### The real run

```bash
npm run replay:real
```

The same tooling over a **redacted real panel**: seven frontier models (Claude,
GPT, Gemini, Grok, Qwen, DeepSeek, GLM) labeling 23 findings from merged PRs in
public OSS repos (Cal.com, Discourse), against an independently adjudicated truth
set. The model reasoning ships with the labels, so you can read why they split.

```
rater       recall (caught real TP)   precision (TP calls correct)
claude      80% (12/15)               92% (12/13)
gemini      100% (15/15)              83% (15/18)
gpt         67% (10/15)               100% (10/10)
grok        13% (2/15)                100% (2/2)
...
Fleiss' kappa:        0.135 (poor)
Krippendorff's alpha: 0.141 (poor)
```

Real models, real disagreement. Gemini catches every true positive and
over-calls; Grok fires twice and is never wrong. Low panel agreement is the
finding, not a bug: independent frontier models split on hard findings, and that
split is what the quorum and adjudication exist to resolve.

## Why κ instead of accuracy

Say your corpus of findings is 90% false positives. A lazy judge that always
says "false positive" scores 90% accuracy and is worthless. Accuracy lies on
imbalanced data. Cohen's κ subtracts out the agreement you'd get by chance, so
that rubber-stamp judge scores near zero. It's the correct metric for validating
a judge, and most teams reach for accuracy by mistake.

```bash
npm test          # unit tests, including a case proving accuracy lies where κ doesn't
```

## The live judge (needs an API key)

```bash
cp .env.example .env     # add one key: OPENROUTER_API_KEY, or ANTHROPIC/OPENAI/GOOGLE
npm run eval
```

`eval` runs a small set of judge cases through a cross-model panel in parallel.
Each model returns a 0–1 score with a rationale; the panel passes a case by
quorum (default: ≥2 of 3 models score ≥0.8). It writes `results.jsonl` +
`summary.json` and **exits non-zero if the pass-rate drops below a bar**, so you
can wire it into CI and a prompt regression fails the build like a unit test.

One OpenRouter key runs a true cross-family panel (Anthropic + OpenAI + Google).
Or set native keys and the judge uses whatever's present, skipping the rest.

## The competitor benchmark (needs `gh` + a key)

```bash
PROVIDERS_ENABLED=baseline,qodo npm run bench
```

This is the harness, not a shipped result. It needs your `gh` login and API
keys, and writes the comparison to `out/` when you run it. Each tool runs over
the same PR corpus and reports findings, cost, and latency in one normalized
shape. `baseline` is one direct LLM call; `qodo` shells out to
[pr-agent](https://github.com/qodo-ai/pr-agent). Hold the base model constant
across both and the only variable left is the orchestration framework, which is
what the benchmark isolates. Add your own tool by implementing the `Provider`
interface in `src/providers/`.

## The result worth talking about

It isn't a precision number: it's that the method catches results you already
believed. An adversarial review by a *different* model (told to refute, not
confirm) caught a train/serve skew in a calibration scorer: the trainer was
learning from a feature the runtime serves as `null`, so the lab number could
never reproduce in production. A single model grading its own work misses that; a
second, independent model told to break it doesn't.

The other half is honesty about measurement. A model graded against labels that
correlate with it (cohesion) scores higher than the same model graded against
independent truth (accuracy). The defensible claims are the controlled
comparisons and the methodology, not a precision figure quoted out of context.
See [`docs/RESULTS.md`](docs/RESULTS.md) for the full write-up.

## How it fits together

```
data/sample/panel/          SYNTHETIC rater panel (truth.json + <model>.jsonl)
data/panel-real/            REDACTED REAL 7-model panel (npm run replay:real)
      │
      ├── npm run replay ──►  src/replay.ts ──► src/kappa.ts
      │                       recall/precision + Fleiss' κ + Krippendorff's α
      │
data/sample/cross-eval-cases.jsonl   synthetic judge cases
      │
      └── npm run eval ───►  src/cross-eval.ts ──► src/judge.ts ──► src/providers.ts
                              quorum-aggregated verdict + CI gate    (fetch, any vendor)

labeling/   RUBRIC.md (judge contract + calibration anchors)
            cohens-kappa.mts (two-pass Cohen's κ) · rater-reliability.mts
            (panel Fleiss' κ / Krippendorff's α + per-rater KEEP/DROP)
            RATER_HANDOFF.md · rater-prompts/ (run a blind, multi-vendor panel)

src/bench.ts + src/providers/   multi-tool head-to-head over a PR corpus
scripts/    fetch-corpus.mjs · fetch-multilang-corpus.mjs · fetch-ground-truth.mjs
            build-panel-comparison.mts (panel dir → reliability input)
docs/       RESULTS.md (methodology) · corpus-criteria.md
```

## What's in `labeling/`

The methodology, not just the math:

- **`RUBRIC.md`**: the decision contract every rater applies. A verification
  protocol (verify, don't confirm) plus worked calibration anchors mined from
  the cases where strong models split. This is what makes κ measure rubric
  clarity instead of prompt drift.
- **`cohens-kappa.mts`**: reconciles two label passes into a confusion matrix
  and Cohen's κ (the right statistic for two passes). `npm run kappa`.
- **`rater-reliability.mts`**: per-rater report headed by the panel-level
  **Fleiss' κ / Krippendorff's α**, then abstention, label skew, redundant pairs
  (high *pairwise* κ = paying twice for one signal), and a KEEP / DOWN-WEIGHT /
  DROP call per model. `npm run reliability` (synthetic) or `npm run
  reliability:real` (the real 7-model panel). All three share `src/kappa.ts`.
- **`RATER_HANDOFF.md` + `rater-prompts/`**: how to run a blind, cross-vendor
  panel through a plain file contract (read `findings.jsonl`, write
  `verdicts-<key>.jsonl`, compare).

## Requirements

- Node ≥ 20 (uses built-in `fetch`, no model SDKs).
- For `eval`: one API key (see `.env.example`).
- For `bench`: an authenticated `gh` CLI, plus `uvx` for the `qodo` provider.

## Tests

```bash
npm test             # vitest: κ math + judge parse/aggregate
npm run test:smoke   # rate-pacer + pr-agent parser
npm run check-types  # tsc, no emit
```

## License

MIT. See [LICENSE](LICENSE).
