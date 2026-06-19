'use strict';

// [FASE 4.4] Mapeia a narração (financialNarrator) para um registro Insight usando
// a ESTRUTURA JÁ ADOTADA pelo sistema ({ type, message }). Função PURA.
//   message = título + resumo + recomendações (multi-linha, como os insights atuais)
//   type    = warning | suggestion | achievement (vocabulário existente), derivado do
//             estado do contexto: risco alto / orçamento estourado → 'warning';
//             contexto vazio → 'suggestion'; caso contrário → 'achievement'.

const { isEmptyContext } = require('./financialNarrator');

function narrationToInsight(narration, context) {
  const recs = Array.isArray(narration && narration.recommendations) ? narration.recommendations : [];
  const message = [
    narration && narration.title,
    narration && narration.summary,
    ...recs.map((r) => `• ${r}`),
  ].filter(Boolean).join('\n');

  let type = 'achievement';
  if (isEmptyContext(context)) {
    type = 'suggestion';
  } else {
    const budgets = Array.isArray(context && context.budgets) ? context.budgets : [];
    const over = budgets.some((b) => b.status === 'EXCEDIDO' || b.status === 'CRÍTICO');
    const high = String((context && context.summary && context.summary.riskLevel) || '').toLowerCase() === 'high';
    if (over || high) type = 'warning';
  }

  return { type, message };
}

module.exports = { narrationToInsight };
