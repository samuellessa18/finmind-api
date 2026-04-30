const { runGrowthEngine } = require('./src/services/growthEngineService');
const prisma = require('./prisma/client');

async function testGrowth() {
    console.log('🚀 Testando Motor de Growth...');
    
    try {
        const results = await runGrowthEngine();
        
        console.log('\n📊 Resultados do Growth:');
        console.log(`Usuários Processados: ${results.processed}`);
        console.log(`Ações Disparadas: ${results.triggered}`);
        
        const actions = await prisma.growthAction.findMany({
            include: { user: true },
            take: 5,
            orderBy: { createdAt: 'desc' }
        });
        
        console.log('\n✅ Últimas Ações Registradas:');
        actions.forEach(a => {
            console.log(`- [${a.type.toUpperCase()}] para ${a.user.email} (Status: ${a.status})`);
        });
        
    } catch (error) {
        console.error('❌ Erro no teste de Growth:', error);
    } finally {
        await prisma.$disconnect();
    }
}

testGrowth();
