'use strict';

// [F0.2A] Verificação de compatibilidade de MIGRATIONS (ledger _prisma_migrations) para o readiness
// (Constituição AF-1.0). SELECT 1 prova apenas conexão; readiness exige que TODA migration esperada
// pelo código esteja APLICADA e concluída (finished_at != null, rolled_back_at == null) no banco.
// Detecta drift de LEDGER: banco restaurado/replica sem a migration mais recente, migration pendente
// ou revertida. NÃO inspeciona o schema físico (não detecta coluna removida à mão) — fora de escopo.

const fs = require('fs');
const path = require('path');

// Nomes das migrations que o CÓDIGO espera: subpastas de prisma/migrations/ (uma por migration).
// Retorna null se NÃO conseguiu ler o catálogo (dir ausente/ilegível) — o caller trata como
// fail-closed (não confundir "não sei o esperado" com "nada esperado / tudo ok").
function readExpectedMigrations(migrationsDir) {
  try {
    return fs.readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (_) {
    return null;
  }
}

// Migrations aplicadas no banco. Pode LANÇAR (tabela ausente / DB indisponível) — o caller trata.
async function readAppliedMigrations(prisma) {
  return prisma.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
}

// Puro/testável: ok sse TODA migration esperada tem ALGUMA linha aplicada e não-revertida.
// Semântica ANY-row (ordem-independente): cobre rollback+reapply (2 linhas mesmo nome) sem depender
// da ordem de retorno do Postgres — basta existir uma linha finished_at!=null e rolled_back_at==null.
function migrationStatus(appliedRows, expectedNames) {
  const okNames = new Set(
    (appliedRows || [])
      .filter((r) => r.finished_at != null && r.rolled_back_at == null)
      .map((r) => r.migration_name),
  );
  const missing = (expectedNames || []).filter((name) => !okNames.has(name));
  return { ok: missing.length === 0, missing };
}

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');

module.exports = { readExpectedMigrations, readAppliedMigrations, migrationStatus, DEFAULT_MIGRATIONS_DIR };
