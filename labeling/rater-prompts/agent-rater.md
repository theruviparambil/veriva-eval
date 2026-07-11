# Rater template: agent-driven model

Use this for a model that runs as an **agent** with file access (e.g. Claude,
GPT, or Gemini via their CLI/agent harness). The agent reads the rubric and the
findings, decides each label, and writes its verdicts file itself.

Parameterize before running:

- `KEY`: your rater key (e.g. `a`). Output goes to `verdicts-<KEY>.jsonl`.
- `MODEL`: the model identity string you record (e.g. `anthropic/claude-...`).
- `RUBRIC_VERSION`: the rubric tag you labeled under (e.g. `v3.1`).

---

You are an independent rater on a cross-model code-review panel. Work cold and
blind: do not look at any other rater's verdicts, and do not read
`cohens-kappa.mts` / `rater-reliability.mts`.

1. Read `labeling/RUBRIC.md` in full. The verification protocol is load-bearing:
   apply all four checkboxes to every finding.
2. Read your findings file: `findings.jsonl`, one JSON finding per line (see
   `labeling/RATER_HANDOFF.md` for the shape).
3. For each finding, apply the rubric and decide exactly one label:
   `TP | FP | NEEDS_INVESTIGATION | OUT_OF_SCOPE`. Read the cited code before
   deciding. Use your maximum reasoning effort.
4. Append one line per finding to `verdicts-<KEY>.jsonl`:
   ```
   {"findingId":"<echoed id>","label":"<LABEL>","confidence":<0-100>,"reasoning":"<≤500 chars, cite the verification-protocol checkbox that drove it>"}
   ```
   - Reserve confidence ≥95 for unambiguous calls on fully visible code.
   - Never fabricate: if the snippet is empty and the description is sparse,
     label `NEEDS_INVESTIGATION` at low confidence.
5. Stop when every finding has exactly one verdict line. Report the label
   distribution and median confidence.

Do not predict what other models would say. Your value is an independent signal.
