'use strict';

const { spawnSync } = require('child_process');

const MIGRATION = '20250101000000_baseline';
const SCHEMA    = './prisma/schema.prisma';

function prisma(...args) {
  return spawnSync(
    'npx',
    ['prisma', ...args, `--schema=${SCHEMA}`],
    { encoding: 'utf8', shell: true }
  );
}

console.log('[prisma-baseline] Checking migration history...');

// migrate status exits 1 when migrations are pending or _prisma_migrations
// doesn't exist yet — spawnSync never throws, we just read stdout.
const status = prisma('migrate', 'status');
const out    = (status.stdout ?? '') + (status.stderr ?? '');

if (out.includes(MIGRATION)) {
  console.log('[prisma-baseline] Baseline already applied — skipping.');
  process.exit(0);
}

console.log(`[prisma-baseline] Marking "${MIGRATION}" as applied...`);

const resolve = prisma('migrate', 'resolve', '--applied', MIGRATION);
const resolveOut = (resolve.stdout ?? '') + (resolve.stderr ?? '');

if (resolve.status !== 0 && !resolveOut.includes('already')) {
  console.error('[prisma-baseline] ERROR:', resolveOut);
  process.exit(1);
}

console.log('[prisma-baseline] Done.');
