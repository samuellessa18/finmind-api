#!/usr/bin/env node

/**
 * Pre-Deploy Checklist para FinMind Backend
 * Execute ANTES de fazer git push
 */

const fs = require('fs');
const path = require('path');

const CHECKS = [];
let passed = 0;
let failed = 0;

function check(name, condition, error = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}`);
    if (error) console.log(`   → ${error}`);
    failed++;
  }
}

console.log('\n🚀 FinMind Backend - Pre-Deploy Checklist\n');

// 1. File structure
check(
  'server.js existe em src/',
  fs.existsSync(path.join(__dirname, 'src', 'server.js')),
  'Arquivo não encontrado: src/server.js'
);

check(
  'server.js NÃO existe na raiz',
  !fs.existsSync(path.join(__dirname, 'server.js')),
  'server.js ainda está na raiz (deveria estar em src/)'
);

// 2. Configuration files
check(
  'package.json configurado',
  require('./package.json').main === 'src/server.js' &&
  require('./package.json').scripts.start === 'node src/server.js',
  'package.json não aponta para src/server.js'
);

check(
  'render.yaml configurado',
  fs.readFileSync(path.join(__dirname, 'render.yaml'), 'utf8').includes('node src/server.js'),
  'render.yaml não tem startCommand correto'
);

// 3. Source code quality
const serverContent = fs.readFileSync(path.join(__dirname, 'src', 'server.js'), 'utf8');

check(
  'Health check endpoint existe',
  serverContent.includes("app.get('/api/health'"),
  'Endpoint /api/health não encontrado'
);

check(
  'Error handlers implementados',
  serverContent.includes("process.on('uncaughtException'") &&
  serverContent.includes("process.on('unhandledRejection'"),
  'Faltam error handlers de production'
);

check(
  'Logs iniciais presentes',
  serverContent.includes('Iniciando FinMind API'),
  'Faltam logs iniciais de debug'
);

check(
  'Sem require duplicado (./src/)',
  !serverContent.includes("require('./src/") &&
  !serverContent.includes('require("./src/'),
  'Ainda há imports com ./src/ (path duplicado)'
);

check(
  'Prisma client importado corretamente',
  serverContent.includes("require('../prisma/client')"),
  'Prisma client não está no path correto'
);

// 4. Database & Environment
check(
  '.env.example existe',
  fs.existsSync(path.join(__dirname, '.env.example')),
  'Arquivo .env.example não encontrado'
);

check(
  '.env.production.example existe',
  fs.existsSync(path.join(__dirname, '.env.production.example')),
  'Arquivo .env.production.example não encontrado'
);

// 5. Documentation
check(
  'DEPLOY.md existe',
  fs.existsSync(path.join(__dirname, 'DEPLOY.md')),
  'Instruções de deploy não encontradas'
);

check(
  'validate-structure.js existe',
  fs.existsSync(path.join(__dirname, 'validate-structure.js')),
  'Script de validação não encontrado'
);

// Summary
console.log('\n' + '='.repeat(60));
console.log(`RESULTADO: ${passed} ✅ | ${failed} ❌`);
console.log('='.repeat(60));

if (failed === 0) {
  console.log('\n🎉 Backend está pronto para deploy!\n');
  console.log('Próximos passos:');
  console.log('  1. git add .');
  console.log('  2. git commit -m "feat: production-ready backend"');
  console.log('  3. git push');
  console.log('  4. Monitorar https://dashboard.render.com\n');
  process.exit(0);
} else {
  console.log(`\n⚠️ ${failed} problema(s) encontrado(s). Corrija antes do push.\n`);
  process.exit(1);
}
