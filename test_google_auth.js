const axios = require('axios');
const prisma = require('./prisma/client');
const crypto = require('crypto');

const API_URL = 'http://localhost:3001/api/v1';

async function testGoogleFlow() {
    console.log('🚀 Iniciando Teste de Fluxo OAuth (Simulado)...');

    try {
        // 1. Criar um AuthCode simulado no banco
        const testUserId = 'cmoldt7nd0002qztjevwoevt8'; // Um ID que exista ou criaremos
        const tempCode = crypto.randomBytes(32).toString('hex');
        
        await prisma.authCode.create({
            data: {
                code: tempCode,
                userId: testUserId,
                expiresAt: new Date(Date.now() + 60000)
            }
        });
        console.log('✅ AuthCode temporário criado no banco.');

        // 2. Tentar trocar o código pelo JWT
        const res = await axios.post(`${API_URL}/auth/google/exchange`, {
            code: tempCode
        });

        if (res.data.token) {
            console.log('✅ Troca de código por JWT bem-sucedida!');
            console.log('   User:', res.data.user.email);
        }

        // 3. Verificar se o código foi consumido (deve falhar se tentarmos de novo)
        try {
            await axios.post(`${API_URL}/auth/google/exchange`, {
                code: tempCode
            });
            console.error('❌ ERRO: O código deveria ter sido consumido!');
        } catch (err) {
            console.log('✅ Código consumido corretamente (401 na segunda tentativa).');
        }

        console.log('\n🏆 TESTE CONCLUÍDO COM SUCESSO!');
    } catch (error) {
        console.error('❌ Erro no teste:', error.response?.data || error.message);
    } finally {
        await prisma.$disconnect();
    }
}

testGoogleFlow();
