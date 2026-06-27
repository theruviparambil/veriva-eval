/**
 * Smoke tests for BenchPacer — node:assert, run via tsx (no vitest). Part of
 * `npm run test:smoke`. Asserts the pacer behaviors with sleep disabled so the
 * suite is instant.
 *
 * Run manually after touching bench-pacer.ts:
 *   npx tsx src/__tests__/bench-pacer.test.mts
 */
import { strict as assert } from 'node:assert';
import { BenchPacer } from '../bench-pacer.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => {
      console.log(`  ✓ ${name}`);
      passed++;
    },
    (err) => {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    },
  );
}

console.log('BenchPacer:');

await test('skips throttle on first PR', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  const slept = await p.beforePr('owner/repo', 0);
  assert.equal(slept, 0, 'first PR should not sleep');
});

await test('applies base throttle on subsequent PRs in same repo', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  const slept = await p.beforePr('owner/repo', 1);
  assert.equal(slept, 5000, 'second PR same repo: just baseThrottleMs');
});

await test('inter-repo cool-down adds to base throttle on repo change', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo-a', 0);
  const slept = await p.beforePr('owner/repo-b', 1);
  assert.equal(slept, 65000, 'repo change: cooldown + throttle');
});

await test('inter-repo cool-down does NOT fire on same repo', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  await p.beforePr('owner/repo', 1);
  const slept = await p.beforePr('owner/repo', 2);
  assert.equal(slept, 5000, 'same repo: no cooldown');
});

await test('rate-limit failure triggers punish mode (4× throttle)', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  p.recordResult({
    inputTokens: 0,
    outputTokens: 0,
    errored: true,
    errorMessage: '429 Too many tokens',
  });
  assert.ok(p.isPunishing(), 'punishing flag should be set');
  const slept = await p.beforePr('owner/repo', 1);
  assert.equal(slept, 20000, 'next PR same repo gets 4× base throttle');
});

await test('non-rate-limit error does NOT trigger punish mode', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 5000,
    interRepoCooldownMs: 60000,
    tpmBudget: 80000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  p.recordResult({
    inputTokens: 0,
    outputTokens: 0,
    errored: true,
    errorMessage: 'gh fetch failed: ENOENT',
  });
  assert.ok(!p.isPunishing(), 'unrelated error should not punish');
  const slept = await p.beforePr('owner/repo', 1);
  assert.equal(slept, 5000, 'no punishment, just base throttle');
});

await test('TPM tracker triggers wait when recent tokens exceed 70% of budget', async () => {
  // Budget 10K, 70% = 7K. One sample of 8K → must wait until window ages off.
  const p = new BenchPacer({
    baseThrottleMs: 0,
    interRepoCooldownMs: 0,
    tpmBudget: 10_000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  p.recordResult({
    inputTokens: 5000,
    outputTokens: 3000,
    errored: false,
  });
  const slept = await p.beforePr('owner/repo', 1);
  assert.ok(slept > 0, `should sleep to wait for TPM window (got ${slept}ms)`);
  assert.ok(slept <= 60_000, `wait must be ≤ 60s window (got ${slept}ms)`);
});

await test('TPM tracker does NOT wait when under 70% threshold', async () => {
  const p = new BenchPacer({
    baseThrottleMs: 0,
    interRepoCooldownMs: 0,
    tpmBudget: 100_000,
    enableSleep: false,
  });
  await p.beforePr('owner/repo', 0);
  p.recordResult({ inputTokens: 5000, outputTokens: 3000, errored: false });
  const slept = await p.beforePr('owner/repo', 1);
  assert.equal(slept, 0, '8K tokens vs 100K budget: well under threshold');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
