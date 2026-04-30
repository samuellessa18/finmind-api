const { OAuth2Client } = require('google-auth-library');
const prisma = require('../../prisma/client');

// IDs de Clientes para múltiplas plataformas
const CLIENT_IDS = [
    process.env.GOOGLE_CLIENT_ID_WEB,
    process.env.GOOGLE_CLIENT_ID_ANDROID,
    process.env.GOOGLE_CLIENT_ID_IOS
].filter(Boolean);

const client = new OAuth2Client();

/**
 * Valida um idToken do Google e retorna os dados do usuário.
 * Suporta múltiplas audiências (Web, Android, iOS).
 */
async function verifyGoogleToken(idToken) {
    if (CLIENT_IDS.length === 0) {
        throw new Error('Configuração de Google Client IDs ausente no servidor');
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken,
            // O Google valida se a audiência do token está nesta lista
            audience: CLIENT_IDS,
        });
        const payload = ticket.getPayload();

        if (!payload.email_verified) {
            throw new Error('Email não verificado pelo Google');
        }

        // Log de segurança para auditoria
        console.log(`[GOOGLE_AUTH] Token validado para audiência: ${payload.aud}`);

        return {
            googleId: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
        };
    } catch (error) {
        console.error('[GOOGLE_AUTH] Erro ao validar token:', error.message);
        throw new Error(`Token do Google inválido ou expirado: ${error.message}`);
    }
}

/**
 * Busca ou cria um usuário a partir dos dados do Google.
 * Implementa a estratégia de vinculação de conta (hybrid).
 */
async function findOrCreateGoogleUser(googleData) {
    const { googleId, email, name, picture } = googleData;

    // 1. Tentar buscar por googleId
    let user = await prisma.user.findUnique({ where: { googleId } });
    if (user) return user;

    // 2. Tentar buscar por email (para vinculação automática)
    user = await prisma.user.findUnique({ where: { email } });

    if (user) {
        // Vinculação: usuário local agora vira hybrid
        user = await prisma.user.update({
            where: { id: user.id },
            data: {
                googleId,
                provider: 'hybrid',
                avatarUrl: picture || user.avatarUrl
            }
        });
        console.log(`[AUTH] Usuário ${email} vinculado ao Google (Hybrid)`);
    } else {
        // Criar novo usuário do zero
        const environment = await prisma.environment.create({
            data: { name: `Ambiente de ${name}` }
        });

        user = await prisma.user.create({
            data: {
                name,
                email,
                googleId,
                provider: 'google',
                avatarUrl: picture,
                environmentId: environment.id
            }
        });
        console.log(`[AUTH] Novo usuário criado via Google: ${email}`);
    }

    return user;
}

module.exports = {
    verifyGoogleToken,
    findOrCreateGoogleUser
};
