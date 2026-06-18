const express = require('express');
const { getDetailedChartData, getGeneralSummary, getFinancialScore } = require('../services/financeService');
const { authenticateToken } = require('../middleware/auth');

const lightCache = require('../middleware/cache');

const router = express.Router();

router.get('/summary', authenticateToken, lightCache(60), async (req, res, next) => {
    try {
        const summary = await getGeneralSummary(req.user.id);
        res.json(summary);
    } catch (error) {
        next(error);
    }
});

router.get('/chart', authenticateToken, async (req, res, next) => {
    try {
        const chart = await getDetailedChartData(req.user.id);
        res.json(chart);
    } catch (error) {
        next(error);
    }
});

// [SCORE] Score financeiro determinístico + evolução. SEM cache: o score deve
// refletir imediatamente cada lançamento (o front re-busca a cada mudança); o
// cálculo é leve (90d + metas + 1 snapshot). Evita servir score defasado.
router.get('/score', authenticateToken, async (req, res, next) => {
    try {
        const score = await getFinancialScore(req.user.id);
        res.json(score);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
