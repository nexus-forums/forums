const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/db');

// JWT secret: fail fast in production, ephemeral random secret in development
// (a known default like 'your-secret-key' would let anyone forge valid tokens)
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: JWT_SECRET environment variable is required in production');
        process.exit(1);
    }
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    console.warn('WARN: JWT_SECRET not set — using random ephemeral secret (sessions invalidate on restart)');
}

async function authenticate(req, res, next) {
    try {
        const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            req.user = null;
            return next();
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        let [rows] = await pool.execute(
            'SELECT id, username, display_name, email, role, avatar, reputation, is_banned, banned_until FROM users WHERE id = ?',
            [decoded.userId]
        );

        // Auto-expire temporary bans: if the temp ban has passed, clear it
        if (rows.length > 0 && rows[0].is_banned && rows[0].banned_until && new Date(rows[0].banned_until) <= new Date()) {
            await pool.execute('UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL WHERE id = ?', [rows[0].id]);
            rows = await pool.execute('SELECT id, username, display_name, email, role, avatar, reputation FROM users WHERE id = ?', [decoded.userId]).then(r => r[0]);
        }

        if (rows.length === 0 || rows[0].is_banned) {
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
