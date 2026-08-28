const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

async function authenticate(req, res, next) {
    try {
        const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            req.user = null;
            return next();
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await pool.execute(
            'SELECT id, username, display_name, email, role, avatar, reputation FROM users WHERE id = ? AND is_banned = FALSE',
            [decoded.userId]
        );

        if (rows.length === 0) {
            req.user = null;
            return next();
        }

        req.user = rows[0];

        // Also attach to locals for templates if needed
        if (res.locals) res.locals.user = req.user;
        next();
    } catch (error) {
        req.user = null;
        next();
    }
}

function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    next();
}

function requireRole(roles = []) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }
        next();
    };
}

module.exports = { authenticate, requireAuth, requireRole, JWT_SECRET };
