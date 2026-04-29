const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function resetUserData() {
  console.log('🧹 Iniciando limpeza profunda de dados financeiros...');

  try {
    // A ordem importa para evitar erros de chave estrangeira
    console.log('- Removendo Transações...');
    await prisma.transaction.deleteMany({});
    
    console.log('- Removendo Metas...');
    await prisma.goal.deleteMany({});
    
    console.log('- Removendo Insights...');
    await prisma.insight.deleteMany({});
    
    console.log('- Removendo Snapshots Diários...');
    await prisma.dailySnapshot.deleteMany({});
    
    console.log('- Removendo Notificações...');
    await prisma.notification.deleteMany({});
    
    console.log('- Removendo Perfis de Usuário (Analytics)...');
    await prisma.userProfile.deleteMany({});
    
    console.log('- Removendo Alertas de Padrões...');
    await prisma.patternAlert.deleteMany({});
    
    console.log('- Removendo Eventos de Comportamento...');
    await prisma.behaviorEvent.deleteMany({});

    console.log('✅ SUCESSO: Todos os dados financeiros foram resetados.');
    console.log('👤 INFO: Os usuários e suas credenciais de login foram mantidos intactos.');
  } catch (error) {
    console.error('❌ ERRO durante o reset:', error);
  } finally {
    await prisma.$disconnect();
  }
}

resetUserData();
