#!/usr/bin/env node
/**
 * Builds data/corpus-v1.json from real merged PRs across a
 * curated list of TS/JS repos. Filters to inclusion criteria from
 * corpus-criteria.md (additions in [5, 1500], merged within 12 months).
 *
 * Usage:
 *   node scripts/fetch-corpus.mjs                # 100 PRs (default)
 *   node scripts/fetch-corpus.mjs --target=1000  # 1000 PRs
 *   node scripts/fetch-corpus.mjs --target=500 --out=data/corpus-500.json
 *
 * Requires `gh` authenticated against github.com. Writes to
 * data/corpus-v1.json (overwrites) by default.
 *
 * Strategy: list recent closed PRs per repo (cap scales with target),
 * keep only merged ones, fetch each PR's stats (additions/deletions/files),
 * filter by size + recency, then take a per-repo target count. The
 * resulting corpus is reproducible — re-running yields a similar set
 * (with newer PRs displacing older ones as repos accumulate merges).
 *
 * Scaling note: per-repo target = ceil(target × repoWeight) where popular
 * repos get weight 0.6/N and smaller get 0.4/N. The list-PR cap scales
 * to 5× the per-repo target to ensure enough eligible PRs survive the
 * additions/recency filters.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const POPULAR_REPOS = [
  "vercel/next.js",
  "facebook/react",
  "microsoft/TypeScript",
  "vitejs/vite",
  "vercel/vercel",
  "withastro/astro",
  "prisma/prisma",
  "vuejs/core",
  "sveltejs/svelte",
  "evanw/esbuild",
];

const SMALLER_REPOS = [
  "trpc/trpc",
  "pmndrs/zustand",
  "TanStack/query",
  "shadcn-ui/ui",
  "vercel/ai",
  "honojs/hono",
  "payloadcms/payload",
  "drizzle-team/drizzle-orm",
  "octokit/octokit.js",
  "TanStack/router",
];

// Default total target if --target is not provided. Per-repo splits are
// derived from this so a single number controls the corpus size.
const DEFAULT_TARGET_TOTAL = 100;
const POPULAR_SHARE = 0.6; // 60% of corpus from popular repos
const SMALLER_SHARE = 0.4; // 40% from smaller repos
// gh pr list cap multiplier — we list this many candidates per repo to
// ensure enough survive the additions/recency filters.
const LIST_OVERSAMPLE = 5;
const LIST_CAP_MAX = 1000; // gh pr list hard cap

const MIN_ADDITIONS = 5;
const MAX_ADDITIONS = 1500;
const MAX_AGE_MONTHS = 12;

function parseArgs(argv) {
  const out = { target: DEFAULT_TARGET_TOTAL, outPath: null };
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      const n = parseInt(arg.split("=")[1] ?? "", 10);
      if (!Number.isFinite(n) || n < 10) {
        throw new Error(`--target must be a positive integer ≥10, got ${arg}`);
      }
      out.target = n;
    } else if (arg.startsWith("--out=")) {
      out.outPath = arg.split("=")[1] ?? null;
    } else if (arg === "--help" || arg === "-h") {
      console.error(
        "usage: node scripts/fetch-corpus.mjs [--target=N] [--out=path/to/corpus.json]",
      );
      process.exit(0);
    }
  }
  return out;
}

const TODAY = new Date();
const ELIGIBLE_FROM = new Date(TODAY);
ELIGIBLE_FROM.setMonth(ELIGIBLE_FROM.getMonth() - MAX_AGE_MONTHS);

async function gh(args) {
  try {
    const { stdout } = await exec("gh", args, { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = err.stderr ?? "";
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.slice(0, 200)}`);
  }
}

function classifyByTitle(title, body) {
  const t = (title ?? "").toLowerCase();
  const b = (body ?? "").toLowerCase().slice(0, 1000);
  if (/(security|cve|vuln|xss|sqli|csrf|injection)/.test(t + " " + b))
    return "security-fix";
  if (/^(fix|bug|hotfix)/.test(t) || /\bfix(?:es)?\b/.test(t)) return "fix";
  if (/^(feat|add|introduce|implement)/.test(t)) return "feature";
  if (/^(refactor|cleanup|clean up|simplify|extract)/.test(t)) return "refactor";
  if (/^(perf|optim)/.test(t)) return "perf";
  if (/^(docs?|readme)/.test(t)) return "docs";
  if (/^(test|ci|chore|build|deps)/.test(t)) return "chore";
  return "other";
}

function sizeClass(additions) {
  if (additions <= 50) return "small";
  if (additions <= 300) return "medium";
  return "large";
}

async function listRecentMergedPRs(repo, limit = 50) {
  // gh pr list with --json ... — fetches recent closed PRs and we filter
  // to merged ones. The --search flag scopes to merged via `is:merged`.
  const cappedLimit = Math.min(limit, LIST_CAP_MAX);
  const args = [
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--limit",
    String(cappedLimit),
    "--json",
    "number,title,body,mergedAt,url",
  ];
  return gh(args);
}

async function fetchPrStats(repo, number) {
  // gh pr view — returns additions/deletions/files from the GraphQL API.
  const args = [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "additions,deletions,changedFiles,baseRefName,headRefOid",
  ];
  return gh(args);
}

function isEligible(pr, stats) {
  if (!pr.mergedAt) return false;
  const mergedAt = new Date(pr.mergedAt);
  if (mergedAt < ELIGIBLE_FROM) return false;
  if (stats.additions < MIN_ADDITIONS) return false;
  if (stats.additions > MAX_ADDITIONS) return false;
  return true;
}

async function pickFromRepo(repo, target) {
  // Oversample: list ~5x what we want, since the additions/recency filters
  // typically reject ~half. Capped at gh's hard 1000-per-list limit.
  const listLimit = Math.min(
    Math.max(50, target * LIST_OVERSAMPLE),
    LIST_CAP_MAX,
  );
  console.error(
    `[corpus] ${repo}: listing ${listLimit} recent merged PRs (target=${target})…`,
  );
  const recent = await listRecentMergedPRs(repo, listLimit);
  const eligible = [];

  // Oversample 3x for the picker. Old 2x cap meant a category-imbalanced
  // pool starved the round-robin and we only landed ~half the target.
  for (const pr of recent) {
    if (eligible.length >= target * 3) break;
    try {
      const stats = await fetchPrStats(repo, pr.number);
      if (!isEligible(pr, stats)) continue;
      eligible.push({
        id: `${repo}#${pr.number}`,
        repo,
        prNumber: pr.number,
        url: pr.url,
        title: pr.title,
        mergedAt: pr.mergedAt,
        additions: stats.additions,
        deletions: stats.deletions,
        changedFiles: stats.changedFiles,
        baseRef: stats.baseRefName,
        headSha: stats.headRefOid,
        category: classifyByTitle(pr.title, pr.body),
        sizeClass: sizeClass(stats.additions),
        language: "typescript",
      });
    } catch (err) {
      console.error(`[corpus] ${repo}#${pr.number} stats fetch failed: ${err.message}`);
    }
  }

  // Stratified sample to balance category mix. Fall back to "first N" if
  // we don't have enough variety.
  const byCategory = new Map();
  for (const item of eligible) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  const picked = [];
  const categoryOrder = ["fix", "feature", "refactor", "security-fix", "perf", "chore", "docs", "other"];
  let cursor = 0;
  // Phase 1 — round-robin pick across categories so the corpus stays
  // category-diverse instead of being dominated by `feature`/`fix`.
  // Bounded by 2× target rounds so a sparse pool can't loop forever.
  const phase1Max = target * categoryOrder.length * 2;
  while (picked.length < target && cursor < phase1Max) {
    const cat = categoryOrder[cursor % categoryOrder.length];
    cursor++;
    const list = byCategory.get(cat);
    if (list && list.length > 0) {
      picked.push(list.shift());
    }
  }
  // Phase 2 — drain any remaining items from any category until we hit
  // target or run dry. Previously this only pulled one per category and
  // broke, capping yield at ~half of target on imbalanced repos.
  if (picked.length < target) {
    let drained = true;
    while (picked.length < target && drained) {
      drained = false;
      for (const list of byCategory.values()) {
        if (list.length > 0 && picked.length < target) {
          picked.push(list.shift());
          drained = true;
        }
      }
    }
  }

  console.error(
    `[corpus] ${repo}: ${eligible.length} eligible, picked ${picked.length}`,
  );
  return picked;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const popularPerRepo = Math.ceil(
    (args.target * POPULAR_SHARE) / POPULAR_REPOS.length,
  );
  const smallerPerRepo = Math.ceil(
    (args.target * SMALLER_SHARE) / SMALLER_REPOS.length,
  );

  console.error(
    `[corpus] target=${args.target} → popular=${popularPerRepo}/repo × ${POPULAR_REPOS.length}, ` +
      `smaller=${smallerPerRepo}/repo × ${SMALLER_REPOS.length} (max ${
        popularPerRepo * POPULAR_REPOS.length + smallerPerRepo * SMALLER_REPOS.length
      })`,
  );

  const allItems = [];

  for (const repo of POPULAR_REPOS) {
    const items = await pickFromRepo(repo, popularPerRepo);
    allItems.push(...items);
  }
  for (const repo of SMALLER_REPOS) {
    const items = await pickFromRepo(repo, smallerPerRepo);
    allItems.push(...items);
  }

  const corpus = {
    version: args.target === DEFAULT_TARGET_TOTAL ? "v1.1" : `v1.1-t${args.target}`,
    createdAt: TODAY.toISOString(),
    description:
      `${allItems.length}-PR corpus across ${POPULAR_REPOS.length} popular and ${SMALLER_REPOS.length} smaller TS/JS repos. ` +
      `Built ${TODAY.toISOString().slice(0, 10)} from recent merged PRs filtered ` +
      `by additions in [${MIN_ADDITIONS}, ${MAX_ADDITIONS}] and merged ` +
      `within ${MAX_AGE_MONTHS} months. See corpus-criteria.md.`,
    items: allItems,
  };

  const outPath = args.outPath
    ? resolve(args.outPath)
    : resolve(__dirname, "../data/corpus-v1.json");
  await writeFile(outPath, JSON.stringify(corpus, null, 2), "utf-8");

  // Summary
  const byRepo = new Map();
  const byCat = new Map();
  const bySize = new Map();
  for (const item of allItems) {
    byRepo.set(item.repo, (byRepo.get(item.repo) ?? 0) + 1);
    byCat.set(item.category, (byCat.get(item.category) ?? 0) + 1);
    bySize.set(item.sizeClass, (bySize.get(item.sizeClass) ?? 0) + 1);
  }
  console.error(`\n[corpus] wrote ${allItems.length} items to ${outPath}`);
  console.error(`[corpus] by repo:`, Object.fromEntries(byRepo));
  console.error(`[corpus] by category:`, Object.fromEntries(byCat));
  console.error(`[corpus] by sizeClass:`, Object.fromEntries(bySize));
}

await main();
