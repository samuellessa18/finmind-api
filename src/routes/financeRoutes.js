const express = require('express');
const { getDetailedChartData, getGeneralSummary } = require('../services/financeService');
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

module.exports = router;
