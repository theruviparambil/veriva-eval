/**
 * Conformance: this implementation must still reproduce the committed fixture.
 *
 * `data/panel-real/panel-comparison.json` is the contract between this repo and
 * `judgecheck`, the Python port of these same statistics. judgecheck ships a
 * byte-identical copy and asserts its own output against it. Until now only
 * that side was checked, so drift could only ever be caught in one direction:
 * change `kappa.ts` and nothing here would notice.
 *
 * What this catches and what it cannot:
 *
 *   It catches DRIFT. If either implementation changes what it computes, the
 *   other's conformance run goes red and the two cannot silently diverge.
 *
 *   It cannot catch a SHARED bug. Two implementations wrong the same way agree
 *   perfectly, and that is exactly what happened: both returned 1.0 ("near
 *   perfect") for a panel of raters that used one category, in both languages,
 *   for weeks. A conformance test would have been green throughout.
 *
 * Shared bugs need an outside reference, which is judgecheck's job: it checks
 * Fleiss and all 21 Cohen pairs against `statsmodels` and alpha against the
 * `krippendorff` package. That is the reason judgecheck is the reference
 * implementation and this file asserts conformance TO it rather than being a
 * second opinion.
 *
 * The fixture is frozen with NEEDS_INVESTIGATION as a category, which is what
 * the harness computed in July. `replay.ts` now treats NI as an abstention for
 * its headline, and that is a reporting decision, not a change to the math. The
 * contract is "given these labels and this label set, produce these numbers",
 * so it is asserted with the label set the fixture was built from.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cohensKappa } from "../kappa.js";
import { LABELS, type Label } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = resolve(HERE, "../../data/panel-real");

interface PairEntry {
  kappa: number;
  observedAgreement: number;
}
interface Fixture {
  generatedFrom: string;
  raters: Record<string, { name: string }>;
  pairwiseKappa: Record<string, PairEntry>;
  consensus: { entries: Array<{ findingId: string; labels: Record<string, string> }> };
}

const fixture = JSON.parse(readFileSync(join(PANEL, "panel-comparison.json"), "utf8")) as Fixture;

const labelsByRater = new Map<string, Map<string, string>>();
for (const file of readdirSync(PANEL).filter((f) => f.endsWith(".jsonl"))) {
  const rows = readFileSync(join(PANEL, file), "utf8").trim().split("\n");
  const map = new Map<string, string>();
  for (const line of rows) {
    const row = JSON.parse(line) as { findingId?: string; label?: string };
    if (row.findingId && row.label) map.set(row.findingId, row.label);
  }
  labelsByRater.set(file.replace(/\.jsonl$/, ""), map);
}

describe("conformance to the committed fixture", () => {
  it("the panel on disk is the panel the fixture was generated from", () => {
    expect([...labelsByRater.keys()].sort()).toEqual(Object.keys(fixture.raters).sort());
  });

  it("covers every pair the fixture records", () => {
    const pairs = Object.keys(fixture.pairwiseKappa);
    const n = Object.keys(fixture.raters).length;
    expect(pairs).toHaveLength((n * (n - 1)) / 2);
  });

  it.each(Object.keys(fixture.pairwiseKappa))("reproduces pairwise kappa: %s", (key) => {
    // Rater names in this panel contain no underscore, which is what makes this
    // split safe. `scripts/build-panel-comparison.mts` documents that invariant.
    const [a, b] = key.split("_");
    const la = labelsByRater.get(a!);
    const lb = labelsByRater.get(b!);
    expect(la, `no rater file for ${a}`).toBeDefined();
    expect(lb, `no rater file for ${b}`).toBeDefined();

    const got = cohensKappa(la!, lb!, LABELS as readonly Label[]);
    const want = fixture.pairwiseKappa[key]!;
    // Exact to float tolerance: this is a port-fidelity check, not an
    // approximation. A drift of 1e-9 is a change in the math, not noise.
    expect(got.kappa).toBeCloseTo(want.kappa, 12);
    expect(got.agreement).toBeCloseTo(want.observedAgreement, 12);
  });

  it("reproduces every recorded consensus row", () => {
    for (const entry of fixture.consensus.entries) {
      for (const [rater, label] of Object.entries(entry.labels)) {
        expect(labelsByRater.get(rater)?.get(entry.findingId)).toBe(label);
      }
    }
  });

  it("the fixture has no field this suite leaves unchecked", () => {
    // Mirrors judgecheck's test of the same name. If the generator grows a
    // field, this fails until the contract covers it.
    expect(Object.keys(fixture).sort()).toEqual([
      "consensus",
      "generatedFrom",
      "pairwiseKappa",
      "raters",
    ]);
    const sample = Object.values(fixture.pairwiseKappa)[0]!;
    expect(Object.keys(sample).sort()).toEqual(["kappa", "observedAgreement"]);
  });
});
