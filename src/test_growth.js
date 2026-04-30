require('dotenv').config({ path: '../.env' });
const { runGrowthEngine } = require('./services/growthEngineService');

async function testEngine() {
    try {
        console.log('--- Iniciando Teste do Growth Engine ---');
        const results = await runGrowthEngine();
        console.log('--- Resultados do Teste ---');
        console.log(JSON.stringify(results, null, 2));
        process.exit(0);
    } catch (error) {
        console.error('Erro no teste:', error);
        process.exit(1);
    }
}

testEngine();
