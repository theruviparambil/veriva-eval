#!/usr/bin/env node
/**
 * Fetch ground-truth signals for every PR in a corpus and write a sidecar
 * JSON keyed by prId. Triage scripts can then correlate findings against
 * these signals to estimate TP/FP without manual labeling.
 *
 * Usage:
 *   node scripts/fetch-ground-truth.mjs [corpus.json]
 *
 * Defaults to data/corpus-v1.json. Output written next to
 * the input as <basename>.ground-truth.json.
 *
 * This script is intentionally JS (not TS), same as fetch-corpus.mjs,
 * so it can run without a build step.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const LINK_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const REVERT_RE = /^revert\b/i;
const HOTFIX_RE = /^(hotfix|emerg|critical)/i;
const REGRESSION_RE = /\b(regress|broken|breakage|reintroduc)/i;

async function gh(args) {
  try {
    const { stdout } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    throw new Error(`gh ${args[0]} failed: ${err.stderr?.slice(0, 200) ?? err.message}`);
  }
}

async function fetchPrBodyAndMergedAt(repo, number) {
  const stdout = await gh([
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "body,mergedAt",
  ]);
  return JSON.parse(stdout);
}

async function fetchIssue(repo, number) {
  try {
    const stdout = await gh([
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,body,labels,state",
    ]);
    const j = JSON.parse(stdout);
    return {
      number: j.number,
      title: j.title,
      body: j.body ?? "",
      labels: (j.labels ?? []).map((l) => l.name),
      state: j.state === "OPEN" ? "OPEN" : "CLOSED",
    };
  } catch {
    return null;
  }
}

function parseLinkedIssueNumbers(body) {
  const out = new Set();
  for (const m of (body ?? "").matchAll(LINK_RE)) {
    const n = parseInt(m[1] ?? "0", 10);
    if (n > 0) out.add(n);
  }
  return [...out];
}

async function fetchPostMergeFollowups(repo, mergedAt) {
  const start = new Date(mergedAt);
  const end = new Date(start);
  end.setDate(end.getDate() + 30);
  const startISO = start.toISOString().slice(0, 10);
  const endISO = end.toISOString().slice(0, 10);
  const query = `repo:${repo} is:merged merged:${startISO}..${endISO}`;

  let prs = [];
  try {
    const stdout = await gh([
      "search",
      "prs",
      query,
      "--limit",
      "30",
      "--json",
      "number,title,mergedAt",
    ]);
    prs = JSON.parse(stdout);
  } catch {
    return [];
  }

  const flagged = prs
    .map((pr) => {
      let kind = null;
      if (REVERT_RE.test(pr.title)) kind = "revert";
      else if (HOTFIX_RE.test(pr.title)) kind = "hotfix";
      else if (REGRESSION_RE.test(pr.title)) kind = "regression-fix";
      return kind ? { ...pr, kind } : null;
    })
    .filter(Boolean)
    .slice(0, 10);

  const enriched = [];
  for (const pr of flagged) {
    let files = [];
    try {
      const stdout = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repo,
        "--json",
        "files",
        "--jq",
        "[.files[].path]",
      ]);
      files = JSON.parse(stdout);
    } catch {
      // best-effort
    }
    enriched.push({
      number: pr.number,
      title: pr.title,
      mergedAt: pr.mergedAt,
      changedFiles: files,
      kind: pr.kind,
    });
  }
  return enriched;
}

async function collectFor(item) {
  const errors = [];
  let body = "";
  let mergedAt = "";
  try {
    const j = await fetchPrBodyAndMergedAt(item.repo, item.prNumber);
    body = j.body ?? "";
    mergedAt = j.mergedAt ?? "";
  } catch (err) {
    errors.push(`pr-view: ${err.message}`);
  }

  const issueNums = parseLinkedIssueNumbers(body);
  const linkedIssues = (
    await Promise.all(issueNums.map((n) => fetchIssue(item.repo, n)))
  ).filter(Boolean);

  let postMergeFollowups = [];
  if (mergedAt) {
    try {
      postMergeFollowups = await fetchPostMergeFollowups(item.repo, mergedAt);
    } catch (err) {
      errors.push(`followups: ${err.message}`);
    }
  }

  return {
    prId: item.id,
    linkedIssues,
    postMergeFollowups,
    hasAnySignal: linkedIssues.length > 0 || postMergeFollowups.length > 0,
    fetchErrors: errors,
  };
}

async function main() {
  const arg = process.argv[2];
  const corpusPath = arg
    ? resolve(arg)
    : resolve(__dirname, "../data/corpus-v1.json");
  const corpus = JSON.parse(await readFile(corpusPath, "utf-8"));
  console.error(`[gt] corpus: ${corpusPath} (${corpus.items.length} items)`);

  const results = {};
  let i = 0;
  for (const item of corpus.items) {
    i++;
    process.stderr.write(`[gt] (${i}/${corpus.items.length}) ${item.id}…`);
    try {
      const r = await collectFor(item);
      results[item.id] = r;
      process.stderr.write(
        ` issues=${r.linkedIssues.length} followups=${r.postMergeFollowups.length}\n`,
      );
    } catch (err) {
      process.stderr.write(` ERR ${err.message}\n`);
      results[item.id] = {
        prId: item.id,
        linkedIssues: [],
        postMergeFollowups: [],
        hasAnySignal: false,
        fetchErrors: [err.message],
      };
    }
  }

  const baseName = basename(corpusPath, ".json");
  const outPath = resolve(dirname(corpusPath), `${baseName}.ground-truth.json`);
  const summary = {
    corpusPath: basename(corpusPath),
    generatedAt: new Date().toISOString(),
    totalPrs: corpus.items.length,
    prsWithSignal: Object.values(results).filter((r) => r.hasAnySignal).length,
    results,
  };
  await writeFile(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.error(
    `\n[gt] wrote ${outPath}: ${summary.prsWithSignal}/${summary.totalPrs} PRs have at least one ground-truth signal`,
  );
}

await main();
