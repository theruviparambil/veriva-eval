/**
 * Diff fetching via the `gh` CLI. Uses gh because it transparently handles
 * authentication from the user's existing login, no extra token management
 * for the harness.
 *
 * `gh pr diff` returns the full unified diff (same shape the GitHub App
 * webhook delivers in production).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GhFetchError extends Error {
  constructor(
    message: string,
    public readonly repo: string,
    public readonly prNumber: number,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "GhFetchError";
  }
}

/**
 * Fetch the unified diff for a PR via `gh pr diff <number> --repo <repo>`.
 * Caches in-memory for the lifetime of the process so the same PR isn't
 * re-fetched if a corpus has duplicate ids.
 */
const diffCache = new Map<string, string>();

export async function fetchPrDiff(
  repo: string,
  prNumber: number,
): Promise<string> {
  const key = `${repo}#${prNumber}`;
  const cached = diffCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "diff", String(prNumber), "--repo", repo],
      { maxBuffer: 50 * 1024 * 1024 }, // 50MB: large diffs sometimes happen
    );
    diffCache.set(key, stdout);
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GhFetchError(
      `gh pr diff failed for ${repo}#${prNumber}: ${e.message}`,
      repo,
      prNumber,
      e.stderr,
    );
  }
}

/**
 * Fetch the head SHA of a PR. We need the SHA to read file contents at the
 * exact version under review. Fetching off `main` would give us the wrong
 * content for older PRs that have since diverged from upstream.
 */
const headShaCache = new Map<string, string>();
async function fetchHeadSha(repo: string, prNumber: number): Promise<string> {
  const key = `${repo}#${prNumber}`;
  const cached = headShaCache.get(key);
  if (cached !== undefined) return cached;
  const { stdout } = await execFileAsync("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "headRefOid",
    "--jq",
    ".headRefOid",
  ]);
  const sha = stdout.trim();
  headShaCache.set(key, sha);
  return sha;
}

/**
 * Fetch full file contents at the PR head ref via the GitHub Contents API.
 * Returns a Map keyed by file path; missing/binary files are silently
 * skipped (the harness logs the count, not individual misses).
 *
 * Caps each file to 20K chars to keep prompt size bounded.
 */
const FILE_CONTENT_CAP = 20_000;

export async function fetchPrFileContents(
  repo: string,
  prNumber: number,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  let sha: string;
  try {
    sha = await fetchHeadSha(repo, prNumber);
  } catch {
    // Without a head SHA we can't safely fetch content. Return empty rather
    // than fall back to `main` (could be wildly wrong on long-lived PRs).
    return out;
  }

  await Promise.all(
    paths.map(async (path) => {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          [
            "api",
            `repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${sha}`,
            "--jq",
            ".content",
          ],
          { maxBuffer: 25 * 1024 * 1024 },
        );
        const b64 = stdout.trim();
        if (!b64) return;
        const decoded = Buffer.from(b64, "base64").toString("utf-8");
        out.set(path, decoded.slice(0, FILE_CONTENT_CAP));
      } catch {
        // Skip: file may have been deleted in the PR, be a binary, or have
        // an encoding gh can't unwrap. Not actionable per-file in the
        // harness.
      }
    }),
  );

  return out;
}
