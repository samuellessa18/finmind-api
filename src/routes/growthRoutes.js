const express = require('express');
const router = express.Router();
const prisma = require('../../prisma/client');
const { authenticateToken } = require('../middleware/auth');

/**
 * GET /api/v1/growth/active
 * Returns active interventions for the authenticated user.
 * In Shadow Mode (Phase 12), this will only return non-shadow actions, 
 * which effectively means it will be empty until real actions are enabled.
 */
router.get('/active', authenticateToken, async (req, res, next) => {
    try {
        const interventions = await prisma.growthAction.findMany({
            where: {
                userId: req.user.id,
                isShadow: false, // Don't show shadow actions to real users
                status: 'pending'
            },
            orderBy: { createdAt: 'desc' }
        });

        // We only return the latest high-priority action
        res.json(interventions);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/v1/growth/action/:id/dismiss
 * Allows user to dismiss a banner/intervention.
 */
router.post('/action/:id/dismiss', authenticateToken, async (req, res, next) => {
    try {
        await prisma.growthAction.update({
            where: { id: req.params.id, userId: req.user.id },
            data: { status: 'dismissed' }
        });
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/v1/growth/action/:id/track
 * Tracks 'displayed' or 'clicked' events for a growth intervention.
 */
router.post('/action/:id/track', authenticateToken, async (req, res, next) => {
    try {
        const { event } = req.body; // 'displayed' | 'clicked'
        const action = await prisma.growthAction.findUnique({
            where: { id: req.params.id, userId: req.user.id }
        });

        if (!action) return res.status(404).json({ error: 'Action not found' });

        const telemetryType = event === 'clicked' ? 'growth_clicked' : 'growth_displayed';
        
        await prisma.event.create({
            data: {
                userId: req.user.id,
                type: telemetryType,
                metadata: JSON.stringify({
                    actionId: action.id,
                    ruleKey: action.ruleKey,
                    type: action.type
                })
            }
        });

        if (event === 'clicked') {
            await prisma.growthAction.update({
                where: { id: action.id },
                data: { status: 'clicked' }
            });
        }

        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
