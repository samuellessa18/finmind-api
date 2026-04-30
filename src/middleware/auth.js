const jwt = require('jsonwebtoken');
const { loadUserById } = require('../services/tenantService');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado: Token ausente' });
  }

  try {
    const secret = process.env.JWT_SECRET;
    
    // CRÍTICO: Garantir que o secret existe
    if (!secret) {
      console.error('[SECURITY FATAL] JWT_SECRET não configurado no ambiente.');
      return res.status(500).json({ error: 'Erro interno de configuração de segurança' });
    }

    const decoded = jwt.verify(token, secret);
    
    if (!decoded || typeof decoded !== 'object' || !decoded.id) {
      console.warn(`[SECURITY] Tentativa de acesso com token malformado`);
      return res.status(401).json({ error: 'Token inválido' });
    }

    // Validação extra: O usuário precisa existir no banco de dados
    const user = await loadUserById(decoded.id);
    if (!user) {
      console.warn(`[SECURITY] Token válido para usuário inexistente: ${decoded.id}`);
      return res.status(401).json({ error: 'Usuário não encontrado ou desativado' });
    }

    // Anexa o usuário completo ao request para multi-tenancy
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    console.warn(`[SECURITY] Falha na autenticação: ${error.message}`);
    return res.status(401).json({ error: 'Autenticação falhou' });
  }
};

module.exports = { authenticateToken };
