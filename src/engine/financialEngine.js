/**
 * @module financialEngine
 * PURE FUNCTIONS ONLY
 * Core mathematical and predictive engine completely decoupled from routes and DB.
 */

function calculateFinancialSummary(transactions, monthlyIncome) {
    let totalExpenses = 0;
    let totalIncome = 0;

    transactions.forEach(t => {
        if (t.type === 'expense') {
            totalExpenses += t.amount;
        } else {
            totalIncome += t.amount;
        }
    });

    const totalBalance = totalIncome - totalExpenses;
    const incomeToUse = monthlyIncome || totalIncome;
    const savingsRate = incomeToUse > 0 ? (totalBalance / incomeToUse) * 100 : 0;

    return {
        totalExpenses,
        totalIncome,
        totalBalance,
        incomeToUse,
        savingsRate
    };
}

function calculateProjections(transactions, monthlyIncome) {
    const totalExpenses = transactions
        .filter(t => t.type === 'expense')
        .reduce((acc, t) => acc + t.amount, 0);

    const totalIncome = transactions
        .filter(t => t.type === 'income')
        .reduce((acc, t) => acc + t.amount, 0);

    const incomeToUse = monthlyIncome || totalIncome;
    const daysPassed = new Date().getDate() || 1; // avoid division by zero
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

    const avgDailyExpense = totalExpenses / daysPassed;
    const projectedExpenses = avgDailyExpense * daysInMonth;

    return {
        projectedExpenses,
        remainingBalance: incomeToUse - projectedExpenses,
        avgDailyExpense
    };
}

function detectRisk(projectedExpenses, monthlyIncome) {
    if (!monthlyIncome || monthlyIncome <= 0) return { level: 'low', message: 'Renda base não configurada' };

    const percentageToLimit = (projectedExpenses / monthlyIncome) * 100;

    if (percentageToLimit >= 90) {
        return { level: 'high', message: 'Risco Crítico: Gasto projetado bate ' + percentageToLimit.toFixed(1) + '% da renda base.' };
    } else if (percentageToLimit >= 70) {
        return { level: 'medium', message: 'Alerta de Controle: Gasto em aceleração na faixa dos ' + percentageToLimit.toFixed(1) + '%.' };
    }
    
    return { level: 'low', message: 'Saúde financeira estável.' };
}

function calculateSummary(user, transactions, goals) {
    const monthlyIncome = user.monthlyIncome || 0;
    const summary = calculateFinancialSummary(transactions, monthlyIncome);
    const projections = calculateProjections(transactions, monthlyIncome);
    const risk = detectRisk(projections.projectedExpenses, monthlyIncome);

    const goalProjections = goals.map(goal => {
        const remaining = goal.targetAmount - goal.currentAmount;
        const daysToDeadline = Math.max(1, (new Date(goal.deadline) - new Date()) / (1000 * 60 * 60 * 24));
        const neededPerDay = remaining / daysToDeadline;
        const isBehind = neededPerDay > projections.avgDailyExpense * 0.5; // Example heuristic

        return {
            id: goal.id,
            title: goal.title,
            status: isBehind ? 'behind' : 'on_track',
            progress: (goal.currentAmount / goal.targetAmount) * 100
        };
    });

    return {
        ...summary,
        ...projections,
        riskLevel: risk.level.toUpperCase(),
        riskMessage: risk.message,
        percentageMonthUsed: (summary.totalExpenses / monthlyIncome) * 100,
        balance: summary.totalBalance,
        trend: null, 
        trendDirection: null,
        goalProjections,
        userProfile: {
            spendingPattern: summary.savingsRate > 20 ? 'SAVER' : 'SPENDER',
            riskTolerance: risk.level.toUpperCase(),
            lastUpdated: new Date()
        }
    };
}

function detectCategorySuggestions(transactions) {
    // Simplified logic for pattern detection
    return {
        suggestions: []
    };
}

// ─────────────────────────────────────────────────────────────
// SCORE FINANCEIRO (0–100) — 100% determinístico, SEM OpenAI.
// Pesos: economia 40%, controle 25%, metas 20%, consistência 15%.
// "Metas sem dados" → renormaliza os pesos restantes para somar 100%.
// ─────────────────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const SCORE_WEIGHTS = { economia: 0.40, controle: 0.25, metas: 0.20, consistencia: 0.15 };
// Alvo de consistência: ~30 dias DISTINTOS com lançamento em 90 dias = nota 100.
const CONSISTENCY_TARGET_DAYS = 30;

/**
 * Faixa do score (5 níveis aprovados).
 */
function scoreBand(score) {
    if (score <= 39) return 'Crítico';
    if (score <= 59) return 'Atenção';
    if (score <= 79) return 'Bom';
    if (score <= 89) return 'Excelente';
    return 'Elite';
}

/**
 * FUNÇÃO PURA. Calcula o score a partir de valores já derivados.
 * @param {object} p
 * @param {object} p.summary      { savingsRate, incomeToUse }
 * @param {object} p.projections  { projectedExpenses }
 * @param {Array}  p.goals        [{ targetAmount, currentAmount }]
 * @param {Array}  p.transactions lançamentos (janela 90d) p/ consistência
 * @param {Date}   p.now          referência (injetável p/ testes)
 * @returns {{ score, band, breakdown }}
 */
function calculateScore({ summary, projections, goals = [], transactions = [], now = new Date() }) {
    const income = (summary && summary.incomeToUse) || 0;

    // 1) Economia (poupar 50% da renda = 100)
    const economia = clamp((summary && summary.savingsRate ? summary.savingsRate : 0) * 2, 0, 100);

    // 2) Controle de gastos (projeção ≤50% da renda = 100; ≥100% = 0)
    const pctProjected = income > 0 ? (projections.projectedExpenses / income) * 100 : 100;
    const controle = clamp((100 - pctProjected) * 2, 0, 100);

    // 3) Metas (média do progresso); sem metas com alvo → null (renormaliza)
    const goalsWithTarget = (goals || []).filter((g) => g.targetAmount > 0);
    const metas = goalsWithTarget.length > 0
        ? clamp(
            goalsWithTarget.reduce((acc, g) => acc + (g.currentAmount / g.targetAmount) * 100, 0) / goalsWithTarget.length,
            0, 100,
          )
        : null;

    // 4) Consistência: dias DISTINTOS com lançamento nos últimos 90 dias / alvo
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const distinctDays = new Set(
        (transactions || [])
            .filter((t) => new Date(t.date) >= since && new Date(t.date) <= now)
            .map((t) => new Date(t.date).toISOString().slice(0, 10)),
    ).size;
    const consistencia = clamp((distinctDays / CONSISTENCY_TARGET_DAYS) * 100, 0, 100);

    // Renormalização de pesos quando 'metas' é nulo (não punir quem não tem metas)
    const parts = [
        { key: 'economia', value: economia, weight: SCORE_WEIGHTS.economia },
        { key: 'controle', value: controle, weight: SCORE_WEIGHTS.controle },
        { key: 'consistencia', value: consistencia, weight: SCORE_WEIGHTS.consistencia },
    ];
    if (metas !== null) parts.push({ key: 'metas', value: metas, weight: SCORE_WEIGHTS.metas });

    const totalWeight = parts.reduce((acc, p) => acc + p.weight, 0);
    const weighted = parts.reduce((acc, p) => acc + p.value * (p.weight / totalWeight), 0);
    const score = clamp(Math.round(weighted), 0, 100);

    return {
        score,
        band: scoreBand(score),
        breakdown: {
            economia: Math.round(economia),
            controle: Math.round(controle),
            metas: metas === null ? null : Math.round(metas),
            consistencia: Math.round(consistencia),
            weightsApplied: Object.fromEntries(parts.map((p) => [p.key, Number((p.weight / totalWeight).toFixed(4))])),
            window: '90d',
        },
    };
}

/**
 * Mensagem contextual DETERMINÍSTICA (não usa OpenAI).
 */
function scoreMessage(band, delta) {
    const byBand = {
        'Crítico':   'Sua saúde financeira precisa de atenção urgente.',
        'Atenção':   'Há espaço para melhorar seus hábitos financeiros.',
        'Bom':       'Você está no caminho certo.',
        'Excelente': 'Ótimo controle financeiro!',
        'Elite':     'Desempenho de elite — parabéns!',
    };
    let evo;
    if (delta === null || delta === undefined) evo = 'Primeiro registro do seu score — acompanhe a evolução nos próximos meses.';
    else if (delta > 0) evo = `Subiu ${delta} ponto(s) desde o mês passado. Continue assim!`;
    else if (delta < 0) evo = `Caiu ${Math.abs(delta)} ponto(s) desde o mês passado. Vamos recuperar.`;
    else evo = 'Estável em relação ao mês passado.';
    return `${byBand[band] || ''} ${evo}`.trim();
}

/**
 * Orquestrador (NÃO puro — usa data atual via calculateProjections):
 * monta os insumos da janela de 90 dias e chama calculateScore.
 */
function scoreFromUserData(user, transactions, goals, now = new Date()) {
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const txn90 = (transactions || []).filter((t) => {
        const d = new Date(t.date);
        return d >= since && d <= now;
    });
    const summary = calculateFinancialSummary(txn90, user.monthlyIncome);
    const projections = calculateProjections(txn90, user.monthlyIncome);
    return calculateScore({ summary, projections, goals, transactions: txn90, now });
}

module.exports = {
    calculateFinancialSummary,
    calculateProjections,
    detectRisk,
    calculateSummary,
    detectCategorySuggestions,
    calculateScore,
    scoreBand,
    scoreMessage,
    scoreFromUserData,
};
