const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config({ path: './.env' });

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@finmind.local';
  const password = 'FinMind123!';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Usuário já existe: ${existing.email}`);
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      name: 'Admin FinMind',
      email,
      password: hashedPassword,
      monthlyIncome: 5000
    }
  });

  console.log('Usuário criado com sucesso:');
  console.log(`Email: ${email}`);
  console.log(`Senha: ${password}`);
  console.log('Use esses dados para fazer login no app.');
}

main()
  .catch((error) => {
    console.error('Erro ao criar usuário:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
