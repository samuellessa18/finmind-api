const { getProductInsights } = require('./src/services/productInsightsService');
const prisma = require('./prisma/client');

async function testInsights() {
    console.log('🚀 Testando Geração de Insights de Produto...');
    
    try {
        const insights = await getProductInsights();
        
        console.log('\n📊 Resumo:');
        console.log(`Problemas Críticos: ${insights.summary.criticalIssues}`);
        console.log(`Total de Insights: ${insights.summary.totalInsights}`);
        
        console.log('\n💡 Insights Gerados:');
        insights.insights.forEach(i => {
            console.log(`[${i.severity.toUpperCase()}] ${i.type}: ${i.message}`);
            console.log(`👉 Recomendação: ${i.recommendation}`);
            console.log('---');
        });
        
    } catch (error) {
        console.error('❌ Erro no teste:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testInsights();
