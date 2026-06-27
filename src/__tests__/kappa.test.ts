import { describe, expect, it } from "vitest";
import { cohensKappa, interpretKappa } from "../kappa.js";

const TWO = ["TP", "FP"] as const;

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
