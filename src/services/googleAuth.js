/**
 * FinMind API — services/googleAuth.js
 * Versão: PATCHED (Auditoria de Segurança)
 *
 * Correções aplicadas:
 *  1. Merge de contas híbrido: se email já existe com provider='local',
 *     vincula o googleId ao usuário existente (provider → 'hybrid')
 *     ANTES: criava segundo registro → dados duplicados, transações perdidas
 *  2. Verificação de audience do token (aud deve casar com CLIENT_ID)
 *  3. GOOGLE_CLIENT_ID_WEB lido consistentemente
 *  4. Logs limpos: não logar dados pessoais (email, nome)
 *  5. Erro descritivo se variáveis Google não configuradas
 */

'use strict';

const { OAuth2Client } = require('google-auth-library');
const prisma           = require('../../prisma/client');

// ─────────────────────────────────────────────────────────────
// CLIENTE OAUTH2 — inicializado com CLIENT_ID do Web
// ─────────────────────────────────────────────────────────────
function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID_WEB;
  if (!clientId) {
    throw new Error(
      '[googleAuth] GOOGLE_CLIENT_ID_WEB não configurado. Impossível verificar tokens Google.'
    );
  }
  return new OAuth2Client(clientId);
}

// ─────────────────────────────────────────────────────────────
// verifyGoogleToken
// Verifica a assinatura e validade do id_token retornado pelo Google
// ─────────────────────────────────────────────────────────────
async function verifyGoogleToken(idToken) {
  const client   = getOAuthClient();
  const clientId = process.env.GOOGLE_CLIENT_ID_WEB;

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: clientId, // CORRIGIDO: validar audience explicitamente
    });
  } catch (err) {
    console.error('[googleAuth] Falha ao verificar id_token:', err.message);
    throw new Error('Token Google inválido ou expirado.');
  }

  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error('Payload do token Google está vazio.');
  }

  if (!payload.email_verified) {
    throw new Error('E-mail Google não verificado.');
  }

  return {
    googleId:  payload.sub,
    email:     payload.email.toLowerCase().trim(),
    name:      payload.name || 'Usuário',
    avatarUrl: payload.picture || null,
  };
}

// ─────────────────────────────────────────────────────────────
// findOrCreateGoogleUser
// Lógica de merge de contas:
//   - Se já existe user com mesmo googleId → login Google normal
//   - Se já existe user com mesmo email (provider=local) → MERGE (hybrid)
//   - Caso contrário → criar novo user Google
// ─────────────────────────────────────────────────────────────
async function findOrCreateGoogleUser(googleData) {
  const { googleId, email, name, avatarUrl } = googleData;

  // 1. Buscar por googleId (login recorrente)
  const existingByGoogleId = await prisma.user.findUnique({
    where: { googleId },
  });
  if (existingByGoogleId) {
    // Atualizar avatar caso tenha mudado
    if (existingByGoogleId.avatarUrl !== avatarUrl) {
      return prisma.user.update({
        where: { id: existingByGoogleId.id },
        data:  { avatarUrl },
      });
    }
    return existingByGoogleId;
  }

  // 2. Buscar por email (pode ser conta local existente)
  const existingByEmail = await prisma.user.findUnique({
    where: { email },
  });

  if (existingByEmail) {
    if (existingByEmail.provider === 'local' || existingByEmail.provider === 'hybrid') {
      // CORRIGIDO: MERGE — vincular googleId à conta local existente
      // Preserva todas as transações, metas e dados do usuário
      console.log(`[googleAuth] Merge de conta: email ${email.slice(0, 3)}*** → provider hybrid`);
      return prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          googleId,
          avatarUrl: avatarUrl || existingByEmail.avatarUrl,
          provider:  'hybrid',
        },
      });
    }

    // Já é conta Google com outro googleId (raro — trocar conta Google)
    // Atualizar googleId para o novo
    console.warn(`[googleAuth] Usuário com mesmo email trocou de conta Google.`);
    return prisma.user.update({
      where: { id: existingByEmail.id },
      data:  { googleId, avatarUrl: avatarUrl || existingByEmail.avatarUrl },
    });
  }

  // 3. Criar novo usuário Google
  const environment = await prisma.environment.create({
    data: { name: `Ambiente de ${name}` },
  });

  return prisma.user.create({
    data: {
      name,
      email,
      password:      null, // Sem senha para contas Google puras
      provider:      'google',
      googleId,
      avatarUrl,
      environmentId: environment.id,
    },
  });
}

module.exports = { verifyGoogleToken, findOrCreateGoogleUser };
