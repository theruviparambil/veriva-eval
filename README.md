# veriva-eval

An eval harness for LLM-as-judge systems. It validates the judge the way you'd
validate a panel of human graders: with inter-rater agreement (Cohen's κ), not
accuracy. Before you trust a model to grade AI-generated code, you first prove
the grader itself is reliable.

Extracted from a production AI code-governance pipeline. This repo is the
**methodology and tooling** — the judge, the κ validation, the rubric, the
benchmark harness. The real labeled corpus, model labelings, and run results are
kept private; everything shipped here runs on small **synthetic** samples so you
can see the machinery without a dataset. Self-contained, MIT, no cloud account
required.

## Quickstart (no API key, ~30 seconds)

```bash
npm install
npm run replay
```

`replay` reads a rater panel (a `truth.json` plus one `<model>.jsonl` per model)
and computes each model's recall and precision against the adjudicated truth,
plus the pairwise Cohen's κ between models. The shipped panel under
`data/sample/panel/` is **synthetic** — point it at your own export with
`npm run replay -- --dir=path/to/panel`.

On the synthetic panel you'll see:

```
rater       recall (caught real TP)   precision (TP calls correct)
model-a     100% (5/5)                63% (5/8)
model-b     40% (2/5)                 100% (2/2)
model-c     80% (4/5)                 100% (4/4)

panel mean pairwise kappa: 0.091 (poor)
```

That spread is the point. `model-a` catches every true positive but over-calls;
`model-b` fires rarely but is never wrong; they genuinely disagree. A single
judge hides that variance. A panel measured by κ exposes it — which is exactly
what a human adjudication step then resolves.

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
`summary.json` and **exits non-zero if the pass-rate drops below a bar** — so you
can wire it into CI and a prompt regression fails the build like a unit test.

One OpenRouter key runs a true cross-family panel (Anthropic + OpenAI + Google).
Or set native keys and the judge uses whatever's present, skipping the rest.

## The competitor benchmark (needs `gh` + a key)

```bash
PROVIDERS_ENABLED=baseline,qodo npm run bench
```

Runs each review tool over the same PR corpus and writes a normalized,
head-to-head comparison (findings, cost, latency). `baseline` is one direct LLM
call; `qodo` shells out to [pr-agent](https://github.com/qodo-ai/pr-agent). Hold
the base model constant across both and the only variable left is the
orchestration framework, which is the question the benchmark answers. Add your
own tool by implementing the `Provider` interface in `src/providers/`.

## The result worth talking about

It isn't a precision number — it's that the method catches results you already
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
      │
      ├── npm run replay ──►  src/replay.ts ──► src/kappa.ts
      │                       per-model recall/precision + pairwise Cohen's κ
      │
data/sample/cross-eval-cases.jsonl   synthetic judge cases
      │
      └── npm run eval ───►  src/cross-eval.ts ──► src/judge.ts ──► src/providers.ts
                              quorum-aggregated verdict + CI gate    (fetch, any vendor)

labeling/   RUBRIC.md (judge contract + calibration anchors)
            cohens-kappa.mjs · rater-reliability.mjs (κ + panel-reliability tools)
            RATER_HANDOFF.md · rater-prompts/ (run a blind, multi-vendor panel)

src/bench.ts + src/providers/   multi-tool head-to-head over a PR corpus
scripts/    fetch-corpus.mjs · fetch-multilang-corpus.mjs · fetch-ground-truth.mjs
            build-panel-comparison.mjs (panel dir → reliability input)
docs/       RESULTS.md (methodology) · corpus-criteria.md
```

## What's in `labeling/`

The methodology, not just the math:

- **`RUBRIC.md`** — the decision contract every rater applies. A verification
  protocol (verify, don't confirm) plus worked calibration anchors mined from
  the cases where strong models split. This is what makes κ measure rubric
  clarity instead of prompt drift.
- **`cohens-kappa.mjs`** — reconciles two label passes into a confusion matrix
  and κ. `npm run kappa` runs it on the synthetic sample passes.
- **`rater-reliability.mjs`** — per-rater report: abstention, label skew,
  redundant pairs (κ ≥ 0.85 means you're paying twice for one signal), and a
  KEEP / DOWN-WEIGHT / DROP call per model. `npm run reliability` runs it on the
  synthetic panel.
- **`RATER_HANDOFF.md` + `rater-prompts/`** — how to run a blind, cross-vendor
  panel through a plain file contract (read `findings.jsonl`, write
  `verdicts-<key>.jsonl`, compare).

## Requirements

- Node ≥ 20 (uses built-in `fetch` — no model SDKs).
- For `eval`: one API key (see `.env.example`).
- For `bench`: an authenticated `gh` CLI, plus `uvx` for the `qodo` provider.

## Tests

```bash
npm test             # vitest: κ math + judge parse/aggregate
npm run test:smoke   # rate-pacer + pr-agent parser
npm run check-types  # tsc, no emit
```

## License

MIT — see [LICENSE](LICENSE).
