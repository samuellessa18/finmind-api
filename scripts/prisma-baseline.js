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

// Always run resolve --applied. It is idempotent across all states:
//   not applied → marks as applied
//   failed      → fixes failed state and marks as applied  ← current situation
//   already applied → exits with "already" message (we ignore it)
console.log(`[prisma-baseline] Resolving "${MIGRATION}" as applied...`);

const result = prisma('migrate', 'resolve', '--applied', MIGRATION);
const out    = (result.stdout ?? '') + (result.stderr ?? '');

if (result.status !== 0 && !out.toLowerCase().includes('already')) {
  console.error('[prisma-baseline] ERROR:', out);
  process.exit(1);
}

console.log('[prisma-baseline] Done.');
