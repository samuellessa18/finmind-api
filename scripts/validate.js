#!/usr/bin/env node
'use strict';

// [FASE 7] Script de validação local — mesmas etapas executadas no CI.
// Roda offline (sem acessar DB de produção). Útil em pre-commit ou troubleshooting.
//
// Passos:
//   1. node --check em todos os arquivos JS sob src/ e scripts/
//   2. prisma validate (parseia o schema)
//   3. require do server.js com env vars dummy (valida que imports resolvem)
//
// NÃO executa migrations, NÃO conecta no DB real, NÃO chama Sentry.
// Falhas paramnam o processo com exit 1 (CI usa isso para bloquear deploy).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let failed = 0;

function step(name, fn) {
  process.stdout.write(`[validate] ${name}... `);
  try {
    fn();
    console.log('OK');
  } catch (err) {
    console.log('FAIL');
    console.error('  ' + (err.message || err));
    failed++;
  }
}

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkJsFiles(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// ─── 1. Sintaxe de TODOS os JS sob src/ e scripts/ ──────────────
step('node --check em src/ e scripts/', () => {
  const files = [
    ...walkJsFiles(path.join(__dirname, '..', 'src')),
    ...walkJsFiles(path.join(__dirname, '..', 'scripts')),
  ];
  for (const f of files) {
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`sintaxe inválida: ${path.relative(process.cwd(), f)}\n${r.stderr || ''}`);
    }
  }
  console.log(`(${files.length} arquivos)`);
  process.stdout.write('  ');
});

// ─── 2. Prisma schema validation ────────────────────────────────
step('npx prisma validate', () => {
  const r = spawnSync('npx',
    ['prisma', 'validate', '--schema=./prisma/schema.prisma'],
    { encoding: 'utf8', shell: true }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 || !out.includes('valid')) {
    throw new Error(out.split('\n').slice(-5).join('\n'));
  }
});

// ─── 3. Smoke: server.js carrega imports ────────────────────────
step('server.js imports resolvem', () => {
  // Define env vars dummy temporariamente
  const envBackup = {};
  const dummyEnv = {
    DATABASE_URL:           'postgresql://u:p@localhost:5432/db',
    JWT_SECRET:             'validation-stub-secret-32-chars-minimum',
    NODE_ENV:               'test',
    FRONTEND_URL:           'http://localhost',
    GOOGLE_CLIENT_ID_WEB:   'stub.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET:   'stub-secret-not-placeholder',
    GOOGLE_CALLBACK_URL:    'http://localhost/cb',
  };
  for (const k of Object.keys(dummyEnv)) {
    envBackup[k] = process.env[k];
    process.env[k] = dummyEnv[k];
  }
  // Forka subprocess para isolar (server.js inicia listener)
  const r = spawnSync('node', ['-e', `
    process.exit = () => {};
    const Module = require('module');
    const orig = Module._load;
    Module._load = function(req, parent) {
      if (req === '../../prisma/client' || req.endsWith('/prisma/client'))
        return new Proxy({}, { get: () => () => Promise.resolve(null) });
      return orig.apply(this, arguments);
    };
    try { require('./src/server.js'); }
    catch (e) { console.error('IMPORT_FAIL:' + e.message); process.kill(process.pid, 'SIGKILL'); }
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 500);
  `], { encoding: 'utf8', cwd: path.join(__dirname, '..'), env: process.env, timeout: 30000 });

  for (const k of Object.keys(dummyEnv)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }

  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('IMPORT_FAIL:')) {
    throw new Error(out.split('IMPORT_FAIL:')[1].split('\n')[0]);
  }
});

if (failed > 0) {
  console.log(`\n[validate] ${failed} step(s) falhou(aram).`);
  process.exit(1);
}
console.log('\n[validate] Todas as validações passaram.');
