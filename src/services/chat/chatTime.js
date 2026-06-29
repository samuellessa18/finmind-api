'use strict';

// [Consultor · E2] Relógio único e dayKey UTC — Baseline §4 / D3.
//
// Princípio: existe UMA fonte de tempo por operação. Em produção é o now() do Postgres
// (mesmo relógio que ancora a janela D↔S do drift). Para teste, aceita-se um override
// ISO (seam de "relógio controlável" do plano) — NUNCA usado em produção.
//
// D3: o dayKey é derivado no servidor no momento da admissão e PERSISTIDO no ChatTurn;
// refund/reconciliação jamais recalculam o dayKey — leem o persistido.

/**
 * Resolve { now, dayKey } para a admissão.
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string|null} nowIso  override de teste (ISO UTC) ou null → now() do Postgres
 * @returns {Promise<{now: Date, dayKey: string}>}
 */
async function resolveNowContext(tx, nowIso) {
  if (nowIso) {
    const d = new Date(nowIso);
    if (Number.isNaN(d.getTime())) throw new Error('[chatTime] nowIso inválido: ' + nowIso);
    return { now: d, dayKey: dayKeyFromDate(d) };
  }
  const rows = await tx.$queryRaw`
    SELECT now() AS now, to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS daykey`;
  return { now: rows[0].now, dayKey: rows[0].daykey };
}

/** dayKey = data UTC (YYYY-MM-DD) do instante. */
function dayKeyFromDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Converte override ISO em Date, ou null (→ caller usa now() do DB no SQL). */
function overrideDate(nowIso) {
  if (!nowIso) return null;
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) throw new Error('[chatTime] nowIso inválido: ' + nowIso);
  return d;
}

module.exports = { resolveNowContext, dayKeyFromDate, overrideDate };
