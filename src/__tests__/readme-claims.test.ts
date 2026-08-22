/**
 * Every number in the README, checked against what the tool actually prints.
 *
 * The same guard in judgecheck caught a rewrite that reworded five claims into
 * shapes their patterns no longer matched, and the one in ramp-analyst-evals
 * caught a figure left stale by a fixture change. This one caught the worst of
 * the three: the QUICKSTART block, the first output any reader sees, still
 * showed `model-a ... 63% (5/8)` and `Fleiss -0.018 / alpha 0.024` from before
 * NEEDS_INVESTIGATION stopped counting as agreement. Running the documented
 * command printed different numbers than the README promised.
 *
 * Asserted against the OUTPUT of the replay rather than against re-derived
 * values, because the claim being made is "run this and you will see this".
 * Re-deriving here could agree with the README while both disagreed with
 * the tool.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");

const run = (script: string): string =>
  execFileSync("npm", ["run", "--silent", script], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });

let synthetic = "";
let real = "";
beforeAll(() => {
  synthetic = run("replay");
  real = run("replay:real");
}, 180_000);

/** The fenced block that CONTAINS a given string, not merely the next one. */
function blockContaining(needle: string): string[] {
  const blocks = [...README.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const hit = blocks.find((b) => b.includes(needle));
  expect(hit, `no fenced block in the README contains: ${needle}`).toBeDefined();
  return hit!.trim().split("\n").map((l) => l.trimEnd());
}

function claim(pattern: RegExp): RegExpMatchArray {
  const m = README.match(pattern);
  expect(m, `README no longer contains a claim matching: ${pattern}`).not.toBeNull();
  return m!;
}

describe("the quickstart block is what `npm run replay` prints", () => {
  it("every line of it appears verbatim in the output", () => {
    const shown = blockContaining("model-a").filter((l) => l.trim() !== "");
    expect(shown.length).toBeGreaterThan(4);
    // Whitespace-normalised: column alignment is presentation, the numbers are
    // the claim. Everything else must appear verbatim.
    const flat = synthetic.replace(/[ \t]+/g, " ");
    for (const line of shown) {
      expect(flat, `quickstart line not printed by the tool: ${line}`).toContain(line.replace(/[ \t]+/g, " "));
    }
  });
});

describe("the real-run block is what `npm run replay:real` prints", () => {
  it("every line of the excerpt appears verbatim, ellipsis aside", () => {
    const shown = blockContaining("adjudicated TP:").filter((l) => l.trim() !== "" && l.trim() !== "...");
    expect(shown.length).toBeGreaterThan(4);
    const flat = real.replace(/[ \t]+/g, " ");
    for (const line of shown) {
      expect(flat, `real-run line not printed by the tool: ${line}`).toContain(line.replace(/[ \t]+/g, " "));
    }
  });
});

describe("prose claims about the real panel", () => {
  it("the NI-as-a-label figures match, and they are judgecheck's headline too", () => {
    // A drift here breaks the cross-language contract with the Python port as
    // well as this README.
    const [, fleiss, alpha] = claim(/published Fleiss ([\d.]+) \/\s*\n?\s*alpha ([\d.]+)/);
    expect(real).toContain(`Fleiss ${fleiss}, alpha ${alpha}`);
  });

  it("the abstention share matches", () => {
    const [, agreeing, total, pct] = claim(
      /\*\*(\d+) of the (\d+) agreeing rater-pairs behind those numbers\s*\n?\s*\((\d+\.\d+)%\)/,
    );
    expect(real).toContain(`${pct}% of the agreeing rater-pairs behind it (${agreeing} of ${total})`);
  });

  it("the always-TP precision caveat matches", () => {
    const [, pct] = claim(/called TP on everything decided would (?:still )?score (\d+)%/);
    expect(real).toContain(`would still score ${pct}%`);
  });
});
