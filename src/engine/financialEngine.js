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

    const incomeToUse = monthlyIncome || totalIncome;
    const balance = incomeToUse - totalExpenses;
    const savingsRate = incomeToUse > 0 ? (balance / incomeToUse) * 100 : 0;

    return {
        totalExpenses,
        totalIncome,
        incomeToUse,
        balance,
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
        trend: 0, // Simplified for now
        trendDirection: 'stable',
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

module.exports = {
    calculateFinancialSummary,
    calculateProjections,
    detectRisk,
    calculateSummary,
    detectCategorySuggestions
};
