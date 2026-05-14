'use strict';

const { execSync } = require('child_process');

const MIGRATION = '20250101000000_baseline';
const SCHEMA = './prisma/schema.prisma';

try {
  console.log('[prisma-baseline] Checking migration history...');

  const status = execSync(
    `npx prisma migrate status --schema=${SCHEMA}`,
    { encoding: 'utf8' }
  );

  if (status.includes(MIGRATION)) {
    console.log('[prisma-baseline] Baseline already applied.');
    process.exit(0);
  }

  console.log(`[prisma-baseline] Marking "${MIGRATION}" as applied...`);

  execSync(
    `npx prisma migrate resolve --applied ${MIGRATION} --schema=${SCHEMA}`,
    { stdio: 'inherit' }
  );

  console.log('[prisma-baseline] Done.');
} catch (err) {
  console.error('[prisma-baseline] ERROR:', err.message);
  process.exit(1);
}
