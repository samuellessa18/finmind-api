const prisma = require('../../prisma/client');

/**
 * Registra eventos de telemetria estruturada para análise de produto
 * @param {string} userId - ID do usuário (opcional para eventos públicos)
 * @param {string} type - Tipo do evento (account_created, user_login, etc)
 * @param {object} metadata - Dados adicionais do evento
 */
async function trackTelemetry(userId, type, metadata = {}) {
    try {
        await prisma.event.create({
            data: {
                userId,
                type,
                metadata: metadata ? JSON.stringify(metadata) : null
            }
        });
    } catch (error) {
        console.error(`[Telemetry Error] Failed to track ${type}:`, error.message);
    }
}

module.exports = {
    trackTelemetry
};
