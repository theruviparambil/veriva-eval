/**
 * Smoke tests for the pr-agent markdown → ProviderFinding parser. Part of
 * `npm run test:smoke`. Run directly via:
 *   npx tsx src/__tests__/qodo-parser.test.mts
 *
 * Fixture markdown is hand-crafted to match formats observed in pr-agent's
 * actual review output. If pr-agent changes its template upstream, these
 * tests should be updated to reflect the new shape.
 */
import { strict as assert } from 'node:assert';
import { parsePrAgentReview } from '../providers/qodo.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}`);
    failed++;
  }
}

console.log('parsePrAgentReview:');

test('extracts findings from a typical review', () => {
  const md = `## PR Reviewer Guide

### Possible Issues
- src/auth.ts [line 47]: Missing null check on user object before accessing .email
- src/handler.ts [line 12]: Race condition between setState and async fetch

### Security Concerns
- src/api.ts:88 — SQL parameter not escaped — possible injection

### General Suggestions
- Consider extracting the validation block in src/utils.ts:55 into a helper
`;
  const findings = parsePrAgentReview(md, 'owner/repo', 42);
  assert.equal(findings.length, 4, `expected 4 findings, got ${findings.length}`);

  // Possible Issues → MEDIUM/QUALITY (no security/critical word)
  const issues = findings.filter((f) => f.ruleId.includes('quality'));
  assert.ok(issues.length >= 2, 'should have quality findings');

  // Security Concerns → SECURITY/HIGH
  const sec = findings.find((f) => f.category === 'SECURITY');
  assert.ok(sec, 'should have a SECURITY finding');
  assert.equal(sec!.severity, 'HIGH');
  assert.equal(sec!.filePath, 'src/api.ts');
  assert.equal(sec!.startLine, 88);
});

test('extracts file/line from `[line N]` pattern', () => {
  const md = `### Possible Issues
- packages/api/src/foo.ts [line 123]: bug
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.filePath, 'packages/api/src/foo.ts');
  assert.equal(findings[0]!.startLine, 123);
});

test('extracts file/line from `path:N` pattern', () => {
  const md = `### Possible Issues
- src/handler.ts:99 — issue here
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.filePath, 'src/handler.ts');
  assert.equal(findings[0]!.startLine, 99);
});

test('falls back to placeholder when bullet has no file/line', () => {
  const md = `### General Suggestions
- Consider improving variable naming throughout
`;
  const findings = parsePrAgentReview(md, 'owner/repo', 42);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.filePath, 'owner/repo#42');
  assert.equal(findings[0]!.startLine, 0);
});

test('returns empty array on empty markdown', () => {
  assert.deepEqual(parsePrAgentReview('', 'a/b', 1), []);
});

test('returns empty array on markdown with no ### headings', () => {
  const md = 'just some preamble text\nno headings here';
  assert.deepEqual(parsePrAgentReview(md, 'a/b', 1), []);
});

test('infers SECURITY category from heading keyword', () => {
  const md = `### Security Concerns
- file.ts:1 - foo
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings[0]!.category, 'SECURITY');
});

test('infers QUALITY category for general headings', () => {
  const md = `### Code Improvements
- file.ts:1 - foo
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings[0]!.category, 'QUALITY');
});

test('handles asterisk-style bullets', () => {
  const md = `### Possible Issues
* file.ts [line 5]: asterisk bullet
* file.ts [line 6]: another
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings.length, 2);
});

test('truncates long titles to 200 chars', () => {
  const longText = 'x'.repeat(500);
  const md = `### Possible Issues
- ${longText}
`;
  const findings = parsePrAgentReview(md, 'a/b', 1);
  assert.equal(findings[0]!.title.length, 200);
  assert.ok(findings[0]!.description.length > 200);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
