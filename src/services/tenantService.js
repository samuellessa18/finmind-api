const prisma = require('../../prisma/client');

async function loadUserById(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      environmentId: true,
      email: true,
      isPremium: true,
      onboardingCompleted: true,
      streakDays: true,
      xp: true,
      level: true,
      plan: true,
      role: true, // [ADMIN/RBAC] necessário para requireAdmin/requireSuperAdmin
      aiUnlockedUntil: true  // [FASE 3.4] necessário para canUseAI() em rotas de IA
    }
  });
}

function tenantWhere(user) {
  return { userId: user.id };
}

module.exports = {
  loadUserById,
  tenantWhere
};
