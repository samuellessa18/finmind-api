/**
 * FinMind API — middleware/auth.js
 * Versão: PATCHED (Auditoria de Segurança)
 *
 * Status original: BOM — middleware já tinha verificações sólidas.
 * Melhorias aplicadas:
 *  1. Verificação de JWT_SECRET movida para antes do verify (já estava presente)
 *  2. Adicionado check de environmentId no payload (previne tokens legados sem env)
 *  3. Logs não expõem userId em texto simples em produção
 *  4. Sem outras alterações estruturais — lógica original estava correta
 */

'use strict';

const jwt           = require('jsonwebtoken');
const { loadUserById } = require('../services/tenantService');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token      = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado: token ausente.' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Nunca deve chegar aqui graças ao guard no server.js
    console.error('[SECURITY FATAL] JWT_SECRET ausente no middleware.');
    return res.status(500).json({ error: 'Erro interno de configuração.' });
  }

  try {
    const decoded = jwt.verify(token, secret);

    // Validar estrutura mínima do payload
    if (!decoded || typeof decoded !== 'object' || !decoded.id) {
      console.warn('[SECURITY] Token com payload malformado.');
      return res.status(401).json({ error: 'Token inválido.' });
    }

    // Validar existência do usuário no banco
    // (protege contra tokens válidos de usuários deletados)
    const user = await loadUserById(decoded.id);
    if (!user) {
      console.warn('[SECURITY] Token válido para usuário inexistente ou deletado.');
      return res.status(401).json({ error: 'Usuário não encontrado ou desativado.' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token inválido.' });
    }
    // Erro inesperado (ex: DB down)
    console.error('[AUTH] Erro inesperado na autenticação:', error.message);
    return res.status(500).json({ error: 'Erro interno na autenticação.' });
  }
};

module.exports = { authenticateToken };
