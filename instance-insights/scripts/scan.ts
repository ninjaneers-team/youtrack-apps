/**
 * End-to-end scan against a real instance: wires the REST adapter into the
 * engine and prints the score and the findings. Diagnostic, not a test.
 *
 *   node --env-file=.env scripts/scan.ts
 */

import { CHECKS } from '../src/checks/catalog.ts';
import { createRestClient } from '../src/client.ts';
import { runScan } from '../src/engine.ts';
import { CATEGORY_LABEL, DEFAULT_CONFIG } from '../src/types.ts';
import type { ScanContext } from '../src/types.ts';

function round(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

async function main(): Promise<void> {
  const ctx: ScanContext = {
    client: createRestClient(),
    config: DEFAULT_CONFIG,
    now: new Date(), // injection boundary: the engine and checks only read ctx.now
  };

  const result = await runScan(CHECKS, ctx);

  console.log('=== Instance Insights ===\n');
  console.log(
    `Overall score: ${result.overallScore === null ? 'n/a' : round(result.overallScore)}\n`,
  );

  console.log('Categories:');
  for (const cat of result.categories) {
    const score = cat.score === null ? 'no check ran' : round(cat.score);
    console.log(`  ${CATEGORY_LABEL[cat.category].padEnd(24)} ${score}`);
  }

  console.log('\nFindings:');
  if (result.findings.length === 0) {
    console.log('  none');
  }
  for (const f of result.findings) {
    console.log(`\n  [${f.severity}] ${f.checkId}  (ratio ${round(f.ratio)})`);
    console.log(`  ${f.headline}`);
    for (const e of f.evidence) console.log(` - ${e.label}: ${e.value}`);
  }

  const skipped = result.outcomes.filter((o) => o.status === 'skipped');
  const failed = result.outcomes.filter((o) => o.status === 'failed');
  if (skipped.length > 0) {
    console.log(`\nSkipped: ${skipped.map((o) => o.checkId).join(', ')}`);
  }
  for (const o of failed) {
    console.log(`\nFailed: ${o.checkId} - ${o.error?.message}`);
  }

  console.log(
      `across ${result.findings.length} findings`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
