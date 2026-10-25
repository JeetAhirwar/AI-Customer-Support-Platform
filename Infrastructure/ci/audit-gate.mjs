#!/usr/bin/env node
/**
 * Dependency-scan gate — Gate A "dependency scans" (TESTING_STRATEGY.md §3, §8).
 *
 * Runs `pnpm audit --prod --json` and fails the build when the production dependency tree
 * contains an advisory at or above `--fail-on`. Production advisories only: dev tooling
 * (vitest/tinypool today) must not block a release, but it is still printed.
 *
 * Why not `pnpm audit --audit-level=critical`? pnpm's `--audit-level` filters which
 * advisories are *printed*; it does not change the exit code, so it cannot express a gate.
 * The threshold lives here instead, where it is explicit and reviewable.
 *
 * Threshold policy (founder decision 2026-10-25): start at `critical` for production and
 * report everything else, then tighten as the known high/moderate findings are upgraded
 * away. `--fail-on none` makes the step report-only.
 *
 * Usage:
 *   node Infrastructure/ci/audit-gate.mjs [--fail-on critical|high|moderate|low|info|none]
 *                                          [--include-dev]
 */
import { spawnSync } from 'node:child_process';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const failOn = flag('--fail-on', 'critical');
const includeDev = process.argv.includes('--include-dev');
if (failOn !== 'none' && !(failOn in RANK)) {
  console.error(`audit-gate: unknown --fail-on ${JSON.stringify(failOn)}`);
  process.exit(2);
}

const args = includeDev ? ['audit', '--json'] : ['audit', '--prod', '--json'];
const run = spawnSync('pnpm', args, {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === 'win32',
  // pnpm exits 1 whenever it finds anything — the report is still on stdout.
});

const start = run.stdout ? run.stdout.indexOf('{') : -1;
if (start === -1) {
  console.error('audit-gate: pnpm audit produced no JSON report (registry/network error?)');
  if (run.stderr) console.error(run.stderr.trim());
  process.exit(1);
}

let report;
try {
  report = JSON.parse(run.stdout.slice(start));
} catch (err) {
  console.error(`audit-gate: could not parse pnpm audit output: ${err.message}`);
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
const advisories = Object.values(report.advisories ?? {});
const scope = includeDev ? 'all dependencies' : 'production dependencies';

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
console.log(`audit-gate: pnpm audit (${scope}) — ${total} advisories`, counts);

const blocking =
  failOn === 'none' ? [] : advisories.filter((a) => RANK[a.severity] >= RANK[failOn]);

for (const a of [...advisories].sort((x, y) => RANK[y.severity] - RANK[x.severity])) {
  const mark = blocking.includes(a) ? 'BLOCK' : '     ';
  console.log(
    `  ${mark} ${String(a.severity).padEnd(8)} ${String(a.module_name).padEnd(26)} ` +
      `${a.patched_versions ?? ''} ${a.github_advisory_id ?? ''} ${a.title ?? ''}`,
  );
}

if (failOn === 'none') {
  console.log('audit-gate: report-only (--fail-on none)');
  process.exit(0);
}

if (blocking.length > 0) {
  console.error(
    `audit-gate: FAIL — ${blocking.length} production advisory(ies) at severity >= ${failOn}`,
  );
  process.exit(1);
}
console.log(`audit-gate: OK — nothing at or above ${failOn} in production dependencies`);
