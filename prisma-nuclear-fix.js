const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Iniciando limpeza nuclear das migrations...');
  try {
    // Tenta deletar todos os registros da tabela de controle do Prisma
    await prisma.$executeRawUnsafe('DELETE FROM "_prisma_migrations";');
    console.log('✅ Tabela _prisma_migrations limpa com sucesso. O banco agora aceitará o "db push".');
  } catch (error) {
    if (error.message.includes('does not exist')) {
        console.log('ℹ️ Tabela _prisma_migrations não existe. Seguindo adiante...');
    } else {
        console.error('❌ Erro ao limpar migrations:', error.message);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main();
