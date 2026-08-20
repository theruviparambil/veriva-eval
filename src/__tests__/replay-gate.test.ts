/**
 * `replay --fail-under` and the exit-code contract.
 *
 * Exercised end to end rather than by unit test, because the thing being
 * checked IS the process exit code. A unit test of the comparison would pass
 * while the CLI still exited 0, which is exactly the bug that matters.
 *
 * The real panel sits at Fleiss 0.135 / Krippendorff 0.141, so 0.14 falls
 * between them. That case is the reason the gate checks both coefficients.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const REPLAY = resolve(ROOT, "src/replay.ts");
const PANEL = resolve(ROOT, "data/panel-real");

function replay(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(TSX, [REPLAY, `--dir=${PANEL}`, ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("replay --fail-under", () => {
  it("exits 0 and prints no gate when the flag is absent", () => {
    const { code, stdout } = replay();
    expect(code).toBe(0);
    expect(stdout).not.toContain("=== Gate ===");
  });

  it("exits 1 and names both coefficients when the panel falls short", () => {
    const { code, stdout } = replay("--fail-under=0.6");
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  Fleiss' kappa 0.135 < 0.600");
    expect(stdout).toContain("FAIL  Krippendorff's alpha 0.141 < 0.600");
  });

  it("exits 0 when both coefficients clear the threshold", () => {
    const { code, stdout } = replay("--fail-under=0.1");
    expect(code).toBe(0);
    expect(stdout).toContain("PASS");
  });

  it("fails when only one coefficient falls short", () => {
    // Fleiss 0.135 misses 0.14; Krippendorff 0.141 clears it.
    const { code, stdout } = replay("--fail-under=0.14");
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  Fleiss' kappa");
    expect(stdout).not.toContain("FAIL  Krippendorff");
  });

  it("still prints the full report when the gate fails", () => {
    const { stdout } = replay("--fail-under=0.9");
    expect(stdout).toContain("=== Panel agreement (all raters) ===");
    expect(stdout).toContain("=== Rater redundancy");
    // the gate comes last, so the diagnosis is above it
    expect(stdout.indexOf("=== Gate ===")).toBeGreaterThan(stdout.indexOf("=== Panel agreement"));
  });

  it("rejects a non-numeric threshold with exit 2", () => {
    const { code, stderr } = replay("--fail-under=high");
    expect(code).toBe(2);
    expect(stderr).toContain("not a number");
  });

  it("rejects a threshold outside the kappa range with exit 2", () => {
    expect(replay("--fail-under=5").code).toBe(2);
    expect(replay("--fail-under=-2").code).toBe(2);
  });

  it("accepts the boundary values of the kappa range", () => {
    expect(replay("--fail-under=-1").code).toBe(0);
    expect(replay("--fail-under=1").code).toBe(1);
  });

  it("treats an unreadable panel as a usage error, not a failed gate", () => {
    // 2 rather than 1: you cannot gate what you cannot read.
    const r = spawnSync(TSX, [REPLAY, "--dir=/nonexistent-panel", "--fail-under=0.9"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});

describe("the gate cannot be turned off by accident", () => {
  // Each of these used to be a silent bypass on a tool whose headline feature
  // is a CI gate.
  const run = (args: string[], dir: string) =>
    spawnSync("npx", ["tsx", "src/replay.ts", `--dir=${dir}`, ...args], {
      encoding: "utf8",
      cwd: process.cwd(),
    });

  it("rejects an unknown flag instead of ignoring it", () => {
    // `--failunder=0.9` exited 0, printed no gate at all, and CI went green.
    const got = run(["--failunder=0.9"], "data/panel-real");
    expect(got.status).toBe(2);
    expect(got.stderr).toContain("unknown option");
  });

  it("rejects --dir given with a space rather than gating the wrong panel", () => {
    const got = spawnSync("npx", ["tsx", "src/replay.ts", "--dir", "data/panel-real"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(got.status).toBe(2);
  });

  it("refuses to gate a panel too small to measure", () => {
    // 7 raters agreeing on 2 findings printed PASS at 0.900. Any panel could
    // be made to pass by shrinking it.
    const dir = mkdtempSync(join(tmpdir(), "veriva-tiny-"));
    for (const r of ["a", "b", "c"]) {
      writeFileSync(
        join(dir, `${r}.jsonl`),
        '{"findingId":"f1","label":"TP"}\n{"findingId":"f2","label":"TP"}\n',
      );
    }
    writeFileSync(
      join(dir, "truth.json"),
      '{"verdicts":[{"findingId":"f1","label":"TP"},{"findingId":"f2","label":"TP"}]}',
    );
    const got = run(["--fail-under=0.9"], dir);
    expect(got.status).toBe(1);
    expect(got.stdout).toContain("comparable findings");
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["empty object", "{}"],
    ["not json", "not json"],
    ["scalar verdicts", '{"verdicts": 3}'],
    ["no usable verdicts", '{"verdicts": []}'],
  ])("exits 2, not 1, on malformed truth.json: %s", (_name, body) => {
    // Exit 1 means "the panel fell short". A broken export is not that, and CI
    // could not tell the two apart.
    const dir = mkdtempSync(join(tmpdir(), "veriva-bad-"));
    for (const r of ["a", "b"]) {
      writeFileSync(join(dir, `${r}.jsonl`), '{"findingId":"f1","label":"TP"}\n');
    }
    writeFileSync(join(dir, "truth.json"), body);
    expect(run([], dir).status).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
