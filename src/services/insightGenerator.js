'use strict';

// [FASE 3.5] Geração determinística de insight financeiro.
//
// NÃO usa OpenAI. NÃO usa coachEngine (a implementação atual de
// generateDailyCoach() tem incompatibilidades com a saída real de
// calculateSummary que causariam crashes ou mensagens erradas:
//   - savingsRate em escala % vs fração esperada
//   - riskLevel 'HIGH' vs 'ALTO' esperado
//   - predictedExpenses undefined (o campo se chama projectedExpenses)
//   - trend/trendDirection sempre null (placeholders)
// Corrigir o coachEngine está fora do escopo desta fase — manter
// esta função como fallback robusto e determinístico.
//
// TODO Fase futura: substituir mensagens por chamada OpenAI mantendo
// este gerador como fallback quando OpenAI estiver indisponível.

/**
 * Gera um insight {type, message} a partir do summary determinístico.
 * Garantias:
 *   - Sempre retorna um objeto com `type` ∈ {warning, suggestion, achievement}
 *   - `message` nunca vazio
 *   - Sem efeitos colaterais, sem chamadas externas
 *   - Resiliente a campos faltantes/null
 */
function generateInsight({ user, summary, hasTransactions }) {
  // Caso 1: usuário novo / sem transações registradas
  if (!hasTransactions) {
    return {
      type: 'suggestion',
      message: 'Comece registrando suas movimentações para receber insights personalizados.',
    };
  }

  // Caso 2: renda mensal não configurada — análise de risco fica imprecisa
  if (!user?.monthlyIncome || user.monthlyIncome <= 0) {
    return {
      type: 'suggestion',
      message: '💡 Configure sua renda mensal nas configurações para receber análises mais precisas dos seus gastos.',
    };
  }

  const riskLevel        = summary?.riskLevel || 'LOW';
  const savingsRate      = Number(summary?.savingsRate ?? 0);
  const pctUsed          = Number(summary?.percentageMonthUsed ?? 0);
  const projected        = Number(summary?.projectedExpenses ?? 0);
  const totalBalance     = Number(summary?.totalBalance ?? 0);
  const streakDays       = Number(user?.streakDays ?? 0);

  // Caso 3: risco alto / gastos próximos do limite
  if (riskLevel === 'HIGH' || pctUsed > 90) {
    return {
      type: 'warning',
      message: `🛑 Atenção: seus gastos projetados (R$ ${projected.toFixed(0)}) estão próximos de ${Math.round(pctUsed)}% da sua renda mensal. Considere reduzir gastos não essenciais nos próximos dias.`,
    };
  }

  // Caso 4: risco médio / consumo acelerado
  if (riskLevel === 'MEDIUM' || pctUsed > 70) {
    return {
      type: 'warning',
      message: `⚠️ Seus gastos já atingiram ${Math.round(pctUsed)}% da renda este mês. Reveja as categorias maiores para manter folga até o fim do mês.`,
    };
  }

  // Caso 5: taxa de economia baixa (mas situação geral controlada)
  if (savingsRate < 10) {
    return {
      type: 'suggestion',
      message: `💡 Sua taxa de economia está em ${savingsRate.toFixed(1)}%. Tentar reservar 10–20% da renda traria mais segurança financeira.`,
    };
  }

  // Caso 6: streak de consistência forte
  if (streakDays >= 7) {
    return {
      type: 'achievement',
      message: `🔥 Você está em um streak de ${streakDays} dias de controle financeiro. Mantenha o ritmo — está construindo um hábito sólido.`,
    };
  }

  // Caso 7 (default): saúde financeira estável
  return {
    type: 'achievement',
    message: `✅ Saúde financeira estável. Saldo atual: R$ ${totalBalance.toFixed(0)}. Continue acompanhando seus gastos para manter a trajetória positiva.`,
  };
}

module.exports = { generateInsight };
