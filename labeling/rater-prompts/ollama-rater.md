# Rater template: external / non-agentic model (Ollama driver)

Use this to include a model that is **not** an agent with file access, you drive
it one finding at a time through a local runner. The reference panel used Ollama
(`ollama run <model> --format json`) for open models like qwen3-coder, deepseek,
and glm, but any "prompt in → JSON out" runner works.

Parameterize:

- `KEY`: rater key (e.g. `d`). Output: `verdicts-<KEY>.jsonl`.
- `MODEL`: the runner's model tag (e.g. `qwen3-coder:480b`, `deepseek-v3.1:671b`).
- `RUBRIC_VERSION`: the rubric tag you label under.

The driver loop (pseudocode, adapt to your runner):

```
rubric = read("labeling/RUBRIC.md")
out = open("verdicts-<KEY>.jsonl", "w")
for finding in readlines("findings.jsonl"):
    prompt = f"""
{rubric}

Apply the rubric to ONE finding. Return STRICT JSON only:
{{"findingId": "...", "label": "TP|FP|NEEDS_INVESTIGATION|OUT_OF_SCOPE", "confidence": 0-100, "reasoning": "<=500 chars citing the verification-protocol checkbox"}}

FINDING:
{finding}
"""
    # e.g. echo "$prompt" | ollama run <MODEL> --format json
    verdict = run_model(MODEL, prompt)          # JSON-constrained output
    out.write(json.dumps(parse(verdict)) + "\n")
```

Rules that matter for a clean κ signal:

- Constrain the model to JSON output (`--format json` or equivalent) so parsing
  is deterministic.
- One finding per call: don't batch; long contexts cause the model to anchor
  earlier verdicts onto later ones.
- Echo back the exact `findingId` from the input so the comparison can align rows.
- If the model returns malformed JSON, retry once, then record
  `NEEDS_INVESTIGATION` at confidence 0 rather than dropping the row.

When `verdicts-<KEY>.jsonl` has one line per finding, measure agreement with
`npm run replay` (full panel) or `npm run kappa` (two passes).
