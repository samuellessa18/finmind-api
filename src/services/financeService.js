const prisma = require('../prisma/client');
const { calculateProjections, calculateFinancialSummary, detectRisk } = require('../engine/financialEngine');

// prisma instance imported above

async function getDetailedChartData(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { transactions: true }
    });

    if (!user) throw new Error("Usuário não encontrado");

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const monthlyTransactions = user.transactions.filter(t => {
        const d = new Date(t.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
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

    const dailyData = Object.keys(dailyDataMap)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .map(key => dailyDataMap[key]);

    // 2. Engine Calculations for Projections
    const engineProjections = calculateProjections(monthlyTransactions, user.monthlyIncome);
    
    // 3. Mount Predicted Data Array (Visual future projection)
    const predictedData = [];
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
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
        include: { transactions: true }
    });

    if (!user) throw new Error("Usuário não encontrado");

    const summary = calculateFinancialSummary(user.transactions, user.monthlyIncome);
    return summary;
}

module.exports = {
    getDetailedChartData,
    getGeneralSummary
};
