const express = require('express');
const { getDetailedChartData, getGeneralSummary } = require('../services/financeService');

const router = express.Router();

const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing token" });

    jwt.verify(token, process.env.JWT_SECRET || 'test_secret_for_development', (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        req.user = user;
        next();
    });
};

router.get('/summary', authenticateToken, async (req, res) => {
    try {
        const summary = await getGeneralSummary(req.user.id);
        res.status(200).json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/chart', authenticateToken, async (req, res) => {
    try {
        const chart = await getDetailedChartData(req.user.id);
        res.status(200).json(chart);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
