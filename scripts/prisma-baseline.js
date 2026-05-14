#!/usr/bin/env node
/**
 * prisma-baseline.js
 *
 * Runs ONCE on first deploy after adopting prisma migrate.
 * Marks the baseline migration as already applied so that
 * `prisma migrate deploy` won't try to run its SQL on a DB
 * that already has the schema.
 *
 * Safe to include permanently in the build command:
 *   node scripts/prisma-baseline.js && npx prisma migrate deploy
 *
 * On subsequent deploys, if the baseline is already recorded,
 * this script exits silently in ~100ms.
 */

'use strict';

const { execSync } = require('child_process');

const BASELINE = '20250101000000_baseline';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function isBaselineApplied() {
  try {
    const out = run('npx prisma migrate status');
    // If the baseline is listed and marked as applied, output contains its name without a pending marker
    return out.includes(BASELINE);
  } catch {
    // migrate status exits with non-zero when there are pending migrations — that's OK
    try {
      const out = run('npx prisma migrate status 2>&1 || true');
      return out.includes(BASELINE);
    } catch {
      return false;
    }
  }
}

function resolveBaseline() {
  try {
    console.log(`[prisma-baseline] Marking "${BASELINE}" as applied...`);
    run(`npx prisma migrate resolve --applied ${BASELINE}`);
    console.log('[prisma-baseline] Done. Prisma migration history initialized.');
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (msg.includes('already exists') || msg.includes('already been applied')) {
      console.log('[prisma-baseline] Baseline already recorded — skipping.');
    } else {
      console.error('[prisma-baseline] ERROR:', msg);
      process.exit(1);
    }
  }
}

function main() {
  console.log('[prisma-baseline] Checking migration history...');

  if (isBaselineApplied()) {
    console.log('[prisma-baseline] Baseline already applied — nothing to do.');
    return;
  }

  resolveBaseline();
}

main();
