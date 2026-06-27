#!/usr/bin/env node
/**
 * Multi-language corpus builder.
 *
 * Sources merged PRs across curated repo allow-lists for Python, Go, and
 * Java. Mirrors `fetch-corpus.mjs` for TS/JS but with per-language repo
 * lists, language tagging, and the same inclusion criteria from
 * `docs/corpus-criteria.md`.
 *
 * Usage:
 *   node scripts/fetch-multilang-corpus.mjs --language=PY --target=250
 *   node scripts/fetch-multilang-corpus.mjs --language=GO --target=250
 *   node scripts/fetch-multilang-corpus.mjs --language=JAVA --target=250
 *
 * Output:
 *   data/corpus-py-250.json
 *   data/corpus-go-250.json
 *   data/corpus-java-250.json
 *
 * Inclusion criteria (per corpus-criteria.md):
 *   - merged PR (state=merged with mergedAt)
 *   - additions in [5, 1500]
 *   - merged within 12 months
 *   - recognizable repo (the curated allow-list below)
 *
 * Stratified by category (fix / feature / refactor / security-fix /
 * perf / docs / chore) with round-robin across categories then
 * per-repo drain — matches the approach in fetch-corpus.mjs so the
 * resulting corpora are directly comparable.
 *
 * GitHub API budget: ~5x oversample of merged PR list × N repos +
 * 1 stats fetch per candidate. With 6 repos × 50 picks × 5x oversample
 * = ~1500 calls per language. The authenticated `gh` CLI gets 5000/hr,
 * so a single language fits comfortably; running all 3 languages
 * sequentially uses ~4500 — under the limit.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo allow-lists per language. Curated for: (a) recognizable / popular
// (≥10k stars or recognizable domain), (b) high merge volume, (c)
// representative of the language's idioms. See corpus-criteria.md for
// the full inclusion rationale.
const REPO_LISTS = {
  PY: [
    'django/django',
    'fastapi/fastapi',
    'pallets/flask',
    'pandas-dev/pandas',
    'pydantic/pydantic',
    'psf/requests',
    'tiangolo/sqlmodel',
    'encode/httpx',
  ],
  GO: [
    'kubernetes/kubernetes',
    'hashicorp/terraform',
    'hashicorp/consul',
    'gorilla/mux',
    'gin-gonic/gin',
    'cockroachdb/cockroach',
    'grafana/grafana',
    'prometheus/prometheus',
  ],
  JAVA: [
    'spring-projects/spring-boot',
    'spring-projects/spring-framework',
    'apache/kafka',
    'apache/cassandra',
    'apache/dubbo',
    'Netflix/zuul',
    'elastic/elasticsearch',
    'google/guava',
  ],
};

const LANG_NAME = {
  PY: 'python',
  GO: 'go',
  JAVA: 'java',
};

const LIST_OVERSAMPLE = 5;
const LIST_CAP_MAX = 1000;
const MIN_ADDITIONS = 5;
const MAX_ADDITIONS = 1500;
const MAX_AGE_MONTHS = 12;

function parseArgs(argv) {
  const out = { language: null, target: 250, outPath: null };
  for (const arg of argv) {
    if (arg.startsWith('--language=')) {
      out.language = arg.split('=')[1] ?? null;
    } else if (arg.startsWith('--target=')) {
      const n = parseInt(arg.split('=')[1] ?? '', 10);
      if (!Number.isFinite(n) || n < 10) {
        throw new Error(`--target must be ≥10, got ${arg}`);
      }
      out.target = n;
    } else if (arg.startsWith('--out=')) {
      out.outPath = arg.split('=')[1] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      console.error(
        'usage: fetch-multilang-corpus.mjs --language=PY|GO|JAVA [--target=250] [--out=path]',
      );
      process.exit(0);
    }
  }
  if (!out.language || !REPO_LISTS[out.language]) {
    throw new Error('--language=PY|GO|JAVA required');
  }
  return out;
}

const TODAY = new Date();
const ELIGIBLE_FROM = new Date(TODAY);
ELIGIBLE_FROM.setMonth(ELIGIBLE_FROM.getMonth() - MAX_AGE_MONTHS);

async function gh(args) {
  try {
    const { stdout } = await exec('gh', args, { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    const stderr = err.stderr ?? '';
    throw new Error(`gh ${args.join(' ')} failed: ${stderr.slice(0, 200)}`);
  }
}

function classifyByTitle(title, body) {
  const t = (title ?? '').toLowerCase();
  const b = (body ?? '').toLowerCase().slice(0, 1000);
  if (/(security|cve|vuln|xss|sqli|csrf|injection)/.test(t + ' ' + b))
    return 'security-fix';
  if (/^(fix|bug|hotfix)/.test(t) || /\bfix(?:es)?\b/.test(t)) return 'fix';
  if (/^(feat|add|introduce|implement|support)/.test(t)) return 'feature';
  if (/^(refactor|cleanup|clean up|simplify|extract|rename)/.test(t))
    return 'refactor';
  if (/^(perf|optim)/.test(t)) return 'perf';
  if (/^(docs?|readme|javadoc)/.test(t)) return 'docs';
  if (/^(test|ci|chore|build|deps|bump)/.test(t)) return 'chore';
  return 'other';
}

function sizeClass(additions) {
  if (additions <= 50) return 'small';
  if (additions <= 300) return 'medium';
  return 'large';
}

async function listRecentMergedPRs(repo, limit = 50) {
  const cappedLimit = Math.min(limit, LIST_CAP_MAX);
  return gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    String(cappedLimit),
    '--json',
    'number,title,body,mergedAt,url',
  ]);
}

async function fetchPrStats(repo, number) {
  return gh([
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'additions,deletions,changedFiles,baseRefName,headRefOid',
  ]);
}

function isEligible(pr, stats) {
  if (!pr.mergedAt) return false;
  const mergedAt = new Date(pr.mergedAt);
  if (mergedAt < ELIGIBLE_FROM) return false;
  if (stats.additions < MIN_ADDITIONS) return false;
  if (stats.additions > MAX_ADDITIONS) return false;
  return true;
}

async function pickFromRepo(repo, target, language) {
  const listLimit = Math.min(
    Math.max(50, target * LIST_OVERSAMPLE),
    LIST_CAP_MAX,
  );
  console.error(
    `[corpus:${language}] ${repo}: listing ${listLimit} merged PRs (target=${target})…`,
  );
  let recent;
  try {
    recent = await listRecentMergedPRs(repo, listLimit);
  } catch (err) {
    console.error(`[corpus:${language}] ${repo}: list failed: ${err.message}`);
    return [];
  }
  const eligible = [];
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
        language: LANG_NAME[language],
      });
    } catch (err) {
      console.error(
        `[corpus:${language}] ${repo}#${pr.number} stats failed: ${err.message}`,
      );
    }
  }

  // Stratified pick across categories then drain remainder.
  const byCategory = new Map();
  for (const item of eligible) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const picked = [];
  const categoryOrder = [
    'fix',
    'feature',
    'refactor',
    'security-fix',
    'perf',
    'chore',
    'docs',
    'other',
  ];
  let cursor = 0;
  const phase1Max = target * categoryOrder.length * 2;
  while (picked.length < target && cursor < phase1Max) {
    const cat = categoryOrder[cursor % categoryOrder.length];
    cursor++;
    const list = byCategory.get(cat);
    if (list && list.length > 0) {
      picked.push(list.shift());
    }
  }
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
    `[corpus:${language}] ${repo}: ${eligible.length} eligible, picked ${picked.length}`,
  );
  return picked;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repos = REPO_LISTS[args.language];
  const perRepoTarget = Math.ceil(args.target / repos.length);

  console.error(
    `[corpus:${args.language}] target=${args.target} → ${perRepoTarget}/repo × ${repos.length} repos`,
  );

  const allItems = [];
  for (const repo of repos) {
    const items = await pickFromRepo(repo, perRepoTarget, args.language);
    allItems.push(...items);
    if (allItems.length >= args.target) break;
  }

  // Trim to exact target if oversampled.
  const finalItems = allItems.slice(0, args.target);

  const corpus = {
    version: `v2.${args.language.toLowerCase()}-t${args.target}`,
    createdAt: TODAY.toISOString(),
    description:
      `${finalItems.length}-PR ${args.language} sub-corpus across ${repos.length} curated repos. ` +
      `Built ${TODAY.toISOString().slice(0, 10)} from recent merged PRs filtered ` +
      `by additions in [${MIN_ADDITIONS}, ${MAX_ADDITIONS}] and merged ` +
      `within ${MAX_AGE_MONTHS} months. See docs/corpus-criteria.md.`,
    items: finalItems,
  };

  const defaultName = `corpus-${args.language.toLowerCase()}-${args.target}.json`;
  const outPath = args.outPath
    ? resolve(args.outPath)
    : resolve(__dirname, '../data', defaultName);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(corpus, null, 2), 'utf-8');

  // Summary
  const byRepo = new Map();
  const byCat = new Map();
  const bySize = new Map();
  for (const item of finalItems) {
    byRepo.set(item.repo, (byRepo.get(item.repo) ?? 0) + 1);
    byCat.set(item.category, (byCat.get(item.category) ?? 0) + 1);
    bySize.set(item.sizeClass, (bySize.get(item.sizeClass) ?? 0) + 1);
  }
  console.error(
    `\n[corpus:${args.language}] wrote ${finalItems.length} items to ${outPath}`,
  );
  console.error(`[corpus:${args.language}] by repo:`, Object.fromEntries(byRepo));
  console.error(
    `[corpus:${args.language}] by category:`,
    Object.fromEntries(byCat),
  );
  console.error(
    `[corpus:${args.language}] by sizeClass:`,
    Object.fromEntries(bySize),
  );
}

await main();
