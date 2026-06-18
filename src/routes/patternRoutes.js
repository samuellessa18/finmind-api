'use strict';

// [PADRÕES] GET /api/v1/patterns — consulta read-only dos padrões detectados
// (source='PATTERN') nos últimos `days` dias (default 90, intervalo 1–365),
// mais recentes primeiro. SEM cache (reflete o estado atual do banco).
const express = require('express');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const { listPatterns } = require('../services/patternService');

const router = express.Router();

// Validação do parâmetro opcional ?days (default 90 conforme escopo da FASE 3.2).
const daysSchema = z.coerce.number().int().min(1).max(365).default(90);

router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const parsed = daysSchema.safeParse(req.query.days);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parâmetro "days" inválido (inteiro entre 1 e 365).' });
    }
    const patterns = await listPatterns(req.user.id, new Date(), parsed.data);
    res.json(patterns);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
