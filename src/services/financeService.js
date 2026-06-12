const prisma = require('../../prisma/client');
const { calculateProjections, calculateFinancialSummary, detectRisk } = require('../engine/financialEngine');

// prisma instance imported above

async function getDetailedChartData(userId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, monthlyIncome: true }
    });

    if (!user) throw new Error("Usuário não encontrado");

    const monthlyTransactions = await prisma.transaction.findMany({
        where: {
            userId: userId,
            date: { gte: startOfMonth, lte: endOfMonth }
        }
    });

    // 1. Organize Daily Data
    const dailyDataMap = {};
    monthlyTransactions.forEach(t => {
        const dayStr = String(new Date(t.date).getDate()).padStart(2, '0');
        if (!dailyDataMap[dayStr]) {
            dailyDataMap[dayStr] = { date: dayStr, income: 0, expenses: 0 };
        }
        if (t.type === 'income') dailyDataMap[dayStr].income += t.amount;
        else dailyDataMap[dayStr].expenses += t.amount;
    });

    const dailyData = Object.values(dailyDataMap).sort((a, b) => parseInt(a.date) - parseInt(b.date));

    // 2. Engine Calculations for Projections
    const engineProjections = calculateProjections(monthlyTransactions, user.monthlyIncome);
    
    // 3. Mount Predicted Data Array (Visual future projection)
    const predictedData = [];
    const daysInMonth = endOfMonth.getDate();
    const currentDay = now.getDate();

    for (let i = currentDay + 1; i <= daysInMonth; i++) {
        predictedData.push({
            date: String(i).padStart(2, '0'),
            projectedExpenses: engineProjections.avgDailyExpense
        });
    }

    // 4. Calculate Risk
    const riskAnalysis = detectRisk(engineProjections.projectedExpenses, user.monthlyIncome);

    return {
        dailyData,
        predictedData,
        balanceProjection: engineProjections.remainingBalance,
        riskAnalysis,
        userMonthlyIncome: user.monthlyIncome
    };
}

async function getGeneralSummary(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, monthlyIncome: true }
    });

    if (!user) throw new Error("Usuário não encontrado");

    // [PERF] Limitar a 90 dias para evitar carregar toda a história em memória.
    // Para o resumo financeiro atual, transações antigas têm impacto mínimo.
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // [PARCELAS] Teto em "agora": o resumo reflete apenas o REALIZADO —
    // parcelas futuras (datas à frente) não inflam o resumo do mês da compra.
    const transactions = await prisma.transaction.findMany({
        where: { userId, date: { gte: ninetyDaysAgo, lte: new Date() } },
        orderBy: { date: 'desc' },
    });

    const summary = calculateFinancialSummary(transactions, user.monthlyIncome);
    
    return {
        totalBalance: summary.totalBalance,
        totalIncome: summary.totalIncome,
        totalExpenses: summary.totalExpenses,
        savingsRate: summary.savingsRate,
        trend: summary.trend,
        trendDirection: summary.trendDirection
    };
}

module.exports = {
    getDetailedChartData,
    getGeneralSummary
};
