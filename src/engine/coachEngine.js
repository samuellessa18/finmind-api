// ────────────────────────────────────────────────────────────────────────────
// [FASE 5] DEPRECATED — Não importar nem usar generateDailyCoach.
//
// Esta função tem incompatibilidades estruturais com a saída atual de
// calculateSummary que causariam crashes ou mensagens silenciosamente erradas:
//   - savingsRate em escala % (0–100) vs fração (0–1) esperada
//   - riskLevel real é 'HIGH'/'MEDIUM'/'LOW' (uppercase EN); espera 'ALTO' (PT)
//   - predictedExpenses é undefined (o campo real chama-se projectedExpenses)
//   - trend / trendDirection são placeholders sempre null
//
// Substituído por services/insightGenerator.generateInsight, que é a fonte
// única de mensagens determinísticas, em uso tanto no daily cron quanto na
// rota manual POST /insights/generate.
//
// Mantido como código morto (não removido) até a próxima fase decidir entre:
//   (a) integração OpenAI mantendo este arquivo como fallback,
//   (b) remoção definitiva.
// Zero callers no codebase atual (grep confirma).
// ────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated since FASE 5 — use services/insightGenerator.generateInsight
 * Generates a behavioral financial insight based on user summary and behavioral metrics.
 */
function generateDailyCoach({ summary, user, behavior }) {
    const {
        savingsRate,
        riskLevel,
        predictedExpenses,
        percentageMonthUsed,
        trendDirection,
        trend
    } = summary;

    const {
        streakDays,
        level
    } = user;

    const {
        preventedExpenses = 0,
        confirmedRisks = 0,
        smartEngagementRate = 0
    } = behavior;

    let problem = "";
    let action = "";
    let impact = "";
    let emoji = "💡";

    // 🔴 HIGH RISK (Critical)
    if (riskLevel === 'ALTO' || percentageMonthUsed > 90) {
        emoji = "🛑";
        problem = `Atenção: seus gastos projetados (R$ ${predictedExpenses.toFixed(0)}) excedem sua renda mensal.`;
        action = `Intervenção imediata: congele gastos não essenciais hoje.`;
        impact = `Isso evita que você bata no limite antes do mês acabar.`;
    }
    // 🟡 ATTENTION (Savings & Trend)
    else if (savingsRate < 0.1 || trendDirection === 'up') {
        emoji = "⚠️";
        problem = trendDirection === 'up' 
            ? `Seu ritmo de gastos subiu ${Math.round(trend * 100)}% nos últimos dias.` 
            : `Sua taxa de economia está abaixo do ideal (${Math.round(savingsRate * 100)}%).`;
        action = `Priorize o essencial para recuperar sua margem de segurança.`;
        impact = `Garantir 10% de economia hoje acelera seu nível ${level + 1}!`;
    }
    // 🟢 CONTROL (Positive Reinforcement)
    else {
        emoji = "🔥";
        problem = streakDays >= 5 
            ? `Você está em um streak de ${streakDays} dias de consistência financeira.`
            : `Seu controle financeiro está sólido e a trajetória é descendente.`;
        action = `Mantenha o padrão disciplinado de hoje.`;
        impact = `Você chegará às suas metas antes do previsto com esse ritmo.`;
    }

    // Behavioral Add-on
    let behavioralHook = "";
    if (preventedExpenses > 0) {
        behavioralHook = ` 🧠 Você já evitou ${preventedExpenses} gastos impulsivos — sinta o poder do autocontrole!`;
    } else if (confirmedRisks > 2) {
        behavioralHook = ` 🚨 Você ignorou alertas recentemente. Que tal uma pausa para refletir hoje?`;
    }

    return {
        message: `${emoji} ${problem} ${action} ${impact}${behavioralHook}`,
        type: riskLevel === 'ALTO' ? 'warning' : 'suggestion'
    };
}

module.exports = { generateDailyCoach };
