const axios = require('axios');

const API_URL = 'http://localhost:3001/api/v1';
const ADMIN_TOKEN = 'admin_secret_123';

async function runTest() {
    console.log('🚀 Iniciando Validação da Fase 8...');

    try {
        // 1. Criar usuário de teste
        const email = `test_val_${Date.now()}@finmind.com`;
        const userRes = await axios.post(`${API_URL}/auth/register`, {
            name: 'Usuário Teste',
            email,
            password: 'password123'
        });
        const token = userRes.data.token;
        console.log('✅ Usuário criado e ativado.');

        // 2. Criar primeira transação (Ativação)
        await axios.post(`${API_URL}/transactions`, {
            type: 'income',
            category: 'Salário',
            amount: 5000,
            date: new Date().toISOString(),
            description: 'Primeira Ativação'
        }, { headers: { Authorization: `Bearer ${token}` } });
        console.log('✅ Primeira transação registrada.');

        // 3. Gerar insights até atingir limite (Engajamento + Limite)
        console.log('⏳ Gerando insights...');
        for (let i = 0; i < 4; i++) {
            try {
                await axios.post(`${API_URL}/insights/generate`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                console.log(`   Insight ${i+1} gerado.`);
            } catch (err) {
                if (err.response?.status === 429) {
                    console.log('✅ Limite atingido com sucesso (429).');
                } else {
                    console.error('❌ Erro inesperado:', err.message);
                }
            }
        }

        // 4. Simular clique em Upgrade (Intenção)
        await axios.post(`${API_URL}/analytics/track`, {
            type: 'upgrade_clicked',
            data: { source: 'test_script' }
        }, { headers: { Authorization: `Bearer ${token}` } });
        console.log('✅ Clique em Upgrade registrado.');

        // 5. Validar métricas no Admin
        console.log('📊 Consultando métricas de Admin...');
        const adminRes = await axios.get(`${API_URL}/admin/metrics`, {
            headers: { 'x-admin-token': ADMIN_TOKEN, Authorization: `Bearer ${token}` }
        });

        console.log('RESULTADO DAS MÉTRICAS:');
        console.dir(adminRes.data.data, { depth: null });

        const data = adminRes.data.data;
        if (data.counts.firstTransactions > 0 && data.counts.limitReached > 0 && data.counts.upgradeClicks > 0) {
            console.log('\n🏆 VALIDAÇÃO CONCLUÍDA: Todos os indicadores de sucesso estão sendo rastreados corretamente!');
        } else {
            console.error('\n❌ FALHA NA VALIDAÇÃO: Alguns indicadores estão zerados.');
        }

    } catch (error) {
        console.error('❌ Erro no teste:', error.response?.data || error.message);
    }
}

runTest();
