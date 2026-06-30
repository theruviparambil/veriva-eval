import { describe, expect, it } from "vitest";
import { cohensKappa, fleissKappa, interpretKappa, krippendorffAlpha } from "../kappa.js";

const TWO = ["TP", "FP"] as const;

function ratersFrom(rows: Array<Array<number | null>>, cats: readonly string[]): Map<string, string>[] {
  return rows.map((row) => {
    const m = new Map<string, string>();
    row.forEach((v, i) => {
      if (v !== null) m.set(`u${i}`, cats[v]!);
    });
    return m;
  });
}

describe("cohensKappa", () => {
  it("returns 1.0 for perfect agreement", () => {
    const a = new Map([["1", "TP"], ["2", "FP"], ["3", "TP"], ["4", "FP"]]);
    const r = cohensKappa(a, a, TWO);
    expect(r.n).toBe(4);
    expect(r.agreement).toBe(1);
    expect(r.kappa).toBe(1);
  });

  it("matches a hand-computed kappa (0.5)", () => {
    // observed agreement 3/4 = 0.75; expected-by-chance 0.5; kappa = 0.5
    const a = new Map([["1", "TP"], ["2", "TP"], ["3", "FP"], ["4", "FP"]]);
    const b = new Map([["1", "TP"], ["2", "FP"], ["3", "FP"], ["4", "FP"]]);
    const r = cohensKappa(a, b, TWO);
    expect(r.agreement).toBeCloseTo(0.75, 10);
    expect(r.kappa).toBeCloseTo(0.5, 10);
  });

  it("only counts items both raters labeled", () => {
    const a = new Map([["1", "TP"], ["2", "FP"], ["3", "TP"]]);
    const b = new Map([["1", "TP"], ["2", "FP"]]);
    expect(cohensKappa(a, b, TWO).n).toBe(2);
  });

  it("rubber-stamping one label yields kappa 0, not high accuracy", () => {
    // Both raters say FP on 9/10 imbalanced items: high agreement, no real signal.
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    for (let i = 0; i < 10; i += 1) {
      const l = i === 0 ? "TP" : "FP";
      a.set(String(i), l);
      b.set(String(i), "FP");
    }
    const r = cohensKappa(a, b, TWO);
    expect(r.agreement).toBeCloseTo(0.9, 10); // would look "90% accurate"
    expect(r.kappa).toBeLessThanOrEqual(0); // but kappa exposes it as no signal
  });

  it("interpretation bands", () => {
    expect(interpretKappa(0.1)).toBe("poor");
    expect(interpretKappa(0.5)).toBe("moderate");
    expect(interpretKappa(0.9)).toBe("near perfect");
  });
});

const FIVE = ["1", "2", "3", "4", "5"] as const;

describe("fleissKappa", () => {
  it("returns 1.0 when every rater agrees on every item", () => {
    const a = new Map([["1", "TP"], ["2", "FP"], ["3", "TP"]]);
    const r = fleissKappa([a, a, a], TWO);
    expect(r.value).toBeCloseTo(1, 10);
    expect(r.raters).toBe(3);
  });

  it("matches the published Fleiss example (kappa ~= 0.21)", () => {
    // Fleiss (1971) worked example: 10 subjects, 14 raters, 5 categories.
    // Each row is the count of raters assigning the subject to each category.
    const counts = [
      [0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7],
    ];
    const raters: Map<string, string>[] = Array.from({ length: 14 }, () => new Map<string, string>());
    counts.forEach((row, subject) => {
      let slot = 0;
      row.forEach((c, cat) => {
        for (let x = 0; x < c; x += 1) raters[slot++]!.set(`s${subject}`, FIVE[cat]!);
      });
    });
    expect(fleissKappa(raters, FIVE).value).toBeCloseTo(0.21, 2);
  });
});

describe("krippendorffAlpha", () => {
  it("returns 1.0 for perfect agreement", () => {
    const a = new Map([["1", "TP"], ["2", "FP"], ["3", "TP"]]);
    expect(krippendorffAlpha([a, a, a], TWO).value).toBeCloseTo(1, 10);
  });

  it("matches Krippendorff's canonical example with missing data (alpha ~= 0.743)", () => {
    // Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability": 4 coders,
    // 12 units, nominal, with missing values. Reference nominal alpha = 0.743.
    const rows: Array<Array<number | null>> = [
      [1, 2, 3, 3, 2, 1, 4, 1, 2, null, null, null],
      [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, null, 3],
      [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, null],
      [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, null],
    ].map((r) => r.map((v) => (v === null ? null : v - 1)));
    expect(krippendorffAlpha(ratersFrom(rows, FIVE), FIVE).value).toBeCloseTo(0.743, 2);
  });
});
