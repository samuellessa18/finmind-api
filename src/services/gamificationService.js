const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Calculates current level based on total XP
 */
function calculateLevel(xp) {
    return Math.floor(xp / 100) + 1;
}

/**
 * Adds XP to a user and updates their level if necessary.
 * Also creates a notification for the XP gain.
 */
async function addXP(userId, amount, message = '') {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;

    const newXP = user.xp + amount;
    const newLevel = calculateLevel(newXP);

    const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: {
            xp: newXP,
            level: newLevel
        }
    });

    if (message) {
        await prisma.notification.create({
            data: {
                userId,
                message: `🔥 +${amount} XP: ${message}`,
                type: 'gamification',
                priority: 'low'
            }
        });
    }

    return {
        userId,
        xpGained: amount,
        totalXP: newXP,
        level: newLevel,
        levelUp: newLevel > user.level
    };
}

module.exports = {
    addXP,
    calculateLevel
};
