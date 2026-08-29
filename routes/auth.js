const HyperExpress = require('hyper-express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { slugify, generateAvatar } = require('../utils/helpers');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const router = new HyperExpress.Router();

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

// Register
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, display_name } = await req.json();

        if (!username || !email || !password) {
            return res.status(400).json({ success: false, error: 'All fields are required' });
        }

        if (username.length < 3 || username.length > 50) {
            return res.status(400).json({ success: false, error: 'Username must be 3-50 characters' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, error: 'Invalid email address' });
        }

        const existing = await query(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existing.length > 0) {
            return res.status(409).json({ success: false, error: 'Username or email already taken' });
        }

        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const avatar = generateAvatar(username);

        const result = await query(
            'INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
            [username, email, password_hash, display_name || username, avatar]
        );

        const token = jwt.sign({ userId: result.insertId, username }, JWT_SECRET, { expiresIn: '7d' });

        res.cookie('token', token, 7 * 24 * 60 * 60 * 1000, {
            httpOnly: true,
            sameSite: 'lax',
            path: '/'
        });

        res.status(201).json({
            success: true,
            token,
            user: { id: result.insertId, username, display_name: display_name || username, avatar, role: 'user' }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { username_or_email, password } = await req.json();

        if (!username_or_email || !password) {
            return res.status(400).json({ success: false, error: 'Username/email and password required' });
        }

        const users = await query(
            'SELECT id, username, display_name, email, password_hash, role, avatar, reputation, is_banned FROM users WHERE username = ? OR email = ?',
            [username_or_email, username_or_email]
        );

        if (users.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const user = users[0];

        if (user.is_banned) {
            return res.status(403).json({ success: false, error: 'Account has been banned' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        await query('UPDATE users SET last_active = NOW() WHERE id = ?', [user.id]);

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        res.cookie('token', token, 7 * 24 * 60 * 60 * 1000, {
            httpOnly: true,
            sameSite: 'lax',
            path: '/'
        });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                email: user.email,
                role: user.role,
                avatar: user.avatar,
                reputation: user.reputation
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.cookie('token', null, 0, { path: '/' });
    res.json({ success: true, message: 'Logged out' });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
    try {
        const users = await query(
            'SELECT id, username, display_name, email, role, avatar, reputation, bio, created_at, post_count FROM users WHERE id = ?',
            [req.user.id]
        );

        if (users.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({ success: true, user: users[0] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch user' });
    }
});

// Update profile
router.patch('/me', requireAuth, async (req, res) => {
    try {
        const { display_name, bio, avatar, email } = await req.json();
        const updates = [];
        const values = [];

        if (display_name !== undefined) {
            if (display_name.length > 100) return res.status(400).json({ success: false, error: 'Display name too long (max 100)' });
            updates.push('display_name = ?');
            values.push(display_name || null);
        }
        if (bio !== undefined) {
            if (bio.length > 2000) return res.status(400).json({ success: false, error: 'Bio too long (max 2000)' });
            updates.push('bio = ?');
            values.push(bio);
        }
        if (avatar !== undefined) {
            if (avatar && avatar.length > 1000) return res.status(400).json({ success: false, error: 'Avatar URL/data too long (max 1000)' });
            if (avatar) {
                const isDataImage = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(avatar);
                const isHttpUrl = /^https?:\/\/.+/i.test(avatar);
                if (!isDataImage && !isHttpUrl) return res.status(400).json({ success: false, error: 'Avatar must be a valid http(s) URL or a base64 image data URI' });
            }
            updates.push('avatar = ?');
            values.push(avatar || generateAvatar(req.user.username));
        }
        if (email !== undefined) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Invalid email address' });
            const [dupe] = await query('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
            if (dupe) return res.status(400).json({ success: false, error: 'Email already in use' });
            updates.push('email = ?');
            values.push(email);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        values.push(req.user.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

        res.json({ success: true, message: 'Profile updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Update failed' });
    }
});

// Change password
router.post('/password', requireAuth, async (req, res) => {
    try {
        const { current_password, new_password } = await req.json();
        if (!current_password || !new_password) return res.status(400).json({ success: false, error: 'Both fields are required' });
        if (new_password.length < 6) return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });

        const [user] = await query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

        const password_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
        await query('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash, req.user.id]);

        res.json({ success: true, message: 'Password updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Password change failed' });
    }
});

// Get public profile
router.get('/user/:username', async (req, res) => {
    try {
        const users = await query(
            'SELECT id, username, display_name, avatar, bio, reputation, post_count, created_at FROM users WHERE username = ?',
            [req.params.username]
        );

        if (users.length === 0) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const recentThreads = await query(
            `SELECT t.id, t.title, t.slug, t.created_at, t.reply_count, t.views, c.name as category_name
             FROM threads t JOIN categories c ON t.category_id = c.id
             WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 5`,
            [users[0].id]
        );

        const recentReplies = await query(
            `SELECT r.id, r.content, r.created_at, t.id as thread_id, t.title as thread_title, t.slug as thread_slug
             FROM replies r JOIN threads t ON r.thread_id = t.id
             WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 5`,
            [users[0].id]
        );

        res.json({
            success: true,
            user: users[0],
            recentThreads,
            recentReplies
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch profile' });
    }
});

// List users
router.get('/users', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        let sql = `SELECT id, username, display_name, avatar, reputation, post_count, created_at FROM users WHERE is_banned = FALSE`;
        let countSql = `SELECT COUNT(*) as total FROM users WHERE is_banned = FALSE`;
        let params = [];

        if (search) {
            sql += ` AND (username LIKE ? OR display_name LIKE ?)`;
            countSql += ` AND (username LIKE ? OR display_name LIKE ?)`;
            params = [`%${search}%`, `%${search}%`];
        }

        sql += ` ORDER BY reputation DESC LIMIT ? OFFSET ?`;

        const [users, countResult] = await Promise.all([
            query(sql, [...params, limit, offset]),
            query(countSql, params)
        ]);

        const total = countResult[0].total;

        res.json({
            success: true,
            users,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
});

module.exports = router;
