import { describe, expect, it } from "vitest";
import { aggregateJudgements, parseJudgement, type Judgement } from "../judge.js";

describe("parseJudgement", () => {
  it("parses strict JSON", () => {
    const r = parseJudgement('{"score":0.9,"rationale":"clear","confidence":"high"}');
    expect(r.score).toBe(0.9);
    expect(r.rationale).toBe("clear");
    expect(r.confidence).toBe("high");
  });

  it("strips a markdown fence", () => {
    const r = parseJudgement('```json\n{"score":0.4,"rationale":"meh","confidence":"low"}\n```');
    expect(r.score).toBe(0.4);
    expect(r.confidence).toBe("low");
  });

  it("rejects out-of-range scores", () => {
    expect(parseJudgement('{"score":2,"rationale":"x"}').score).toBeNull();
    expect(parseJudgement('{"score":-1,"rationale":"x"}').score).toBeNull();
  });

  it("keeps raw text as rationale when not JSON", () => {
    const r = parseJudgement("the model ignored instructions");
    expect(r.score).toBeNull();
    expect(r.rationale).toContain("ignored");
  });
});

function j(model: string, score: number | null): Judgement {
  return { model, modelId: model, score, rationale: "", confidence: null, latencyMs: 1 };
}

describe("aggregateJudgements", () => {
  it("passes when >= requiredCount models clear the threshold", () => {
    const agg = aggregateJudgements([j("a", 0.9), j("b", 0.85), j("c", 0.4)], 0.8, 2);
    expect(agg.passingCount).toBe(2);
    expect(agg.passed).toBe(true);
    expect(agg.meanScore).toBeCloseTo((0.9 + 0.85 + 0.4) / 3, 10);
  });

  it("fails when a model errored (null) drops the quorum below required", () => {
    const agg = aggregateJudgements([j("a", 0.9), j("b", 0.4), j("c", null)], 0.8, 2);
    expect(agg.passingCount).toBe(1);
    expect(agg.passed).toBe(false);
  });

  it("null scores never count toward passing", () => {
    const agg = aggregateJudgements([j("a", null), j("b", null), j("c", null)], 0.8, 1);
    expect(agg.passingCount).toBe(0);
    expect(agg.passed).toBe(false);
    expect(agg.meanScore).toBeNull();
  });
});
