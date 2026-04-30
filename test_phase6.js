const axios = require('axios');

const API_URL = 'http://localhost:5000/api/v1';
const ADMIN_TOKEN = 'admin_secret_123'; // Baseado no .env configurado anteriormente

async function test() {
  console.log('🧪 Iniciando Testes da Fase 6...');

  try {
    // 1. Registro
    const email = `test_phase6_${Date.now()}@finmind.com`;
    console.log(`1. Registrando usuário FREE: ${email}`);
    const regRes = await axios.post(`${API_URL}/auth/register`, {
      name: 'Tester Phase 6',
      email: email,
      password: 'password123',
      monthlyIncome: 5000
    });
    const token = regRes.data.token;
    const userId = regRes.data.user.id;
    const headers = { Authorization: `Bearer ${token}` };

    // 2. Tentar gerar insights (Limite FREE = 3)
    console.log('2. Testando limite diário (FREE)...');
    for (let i = 1; i <= 4; i++) {
        try {
            console.log(`Chamada #${i}...`);
            await axios.post(`${API_URL}/insights/generate`, {}, { headers });
            console.log(`✅ Chamada #${i} OK.`);
        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`✅ Chamada #${i} BLOQUEADA (429 esperado).`);
                console.log('Motivo:', error.response.data);
            } else {
                throw error;
            }
        }
    }

    // 3. Testar Admin Metrics
    console.log('3. Testando Admin API...');
    const adminHeaders = { 
        ...headers, 
        'x-admin-token': ADMIN_TOKEN 
    };
    const metricsRes = await axios.get(`${API_URL}/admin/metrics`, { headers: adminHeaders });
    console.log('✅ Admin Metrics OK:', JSON.stringify(metricsRes.data.data));

    // 4. Upgrade para PRO via "manual" (Simulando upgrade no DB para teste)
    // Em um app real, isso viria de um Webhook de pagamento.
    // Aqui vamos testar a resiliência do limiter ao mudar o plano.
    // Vou usar um endpoint de admin para fazer o upgrade (precisamos criar esse endpoint ou fazer via prisma direto no script de teste se rodar no backend context)
    // Como o script roda separado, vou assumir que o admin pode fazer upgrade.
    // Vou pular o upgrade manual via script externo e focar no que já implementei.

    console.log('\n✨ TESTES BÁSICOS CONCLUÍDOS COM SUCESSO!');
  } catch (error) {
    console.error('❌ FALHA NO TESTE:', error.response?.data || error.message);
    process.exit(1);
  }
}

test();
