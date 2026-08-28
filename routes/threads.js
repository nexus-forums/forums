const HyperExpress = require('hyper-express');
const { query, transaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { slugify, timeAgo, generateAvatar } = require('../utils/helpers');
const router = new HyperExpress.Router();

// List threads with filters
router.get('/api/threads', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const category = req.query.category || '';
        const search = req.query.search || '';
        const sort = req.query.sort || 'latest'; // latest, top, oldest, replies

        let sql = `
            SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                   u.username, u.display_name, u.avatar,
                   lu.username as last_username
            FROM threads t
            JOIN categories c ON t.category_id = c.id
            JOIN users u ON t.user_id = u.id
            LEFT JOIN users lu ON t.last_post_user_id = lu.id
            WHERE t.is_pinned = FALSE AND c.is_hidden = FALSE
        `;
        let countSql = `SELECT COUNT(*) as total FROM threads t JOIN categories c ON t.category_id = c.id WHERE t.is_pinned = FALSE AND c.is_hidden = FALSE`;
        let params = [];

        if (category) {
            sql += ` AND c.slug = ?`;
            countSql += ` AND c.slug = ?`;
            params.push(category);
        }

        if (search) {
            sql += ` AND (t.title LIKE ? OR t.content LIKE ?)`;
            countSql += ` AND (t.title LIKE ? OR t.content LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        const order = {
            latest: 't.last_post_at DESC',
            oldest: 't.created_at ASC',
            top: 't.views DESC',
            replies: 't.reply_count DESC'
        };
        sql += ` ORDER BY ${order[sort] || order.latest} LIMIT ? OFFSET ?`;

        const [threads, pinnedThreads, countResult] = await Promise.all([
            query(sql, [...params, limit, offset]),
            category ? query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar, lu.username as last_username
                FROM threads t JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
                LEFT JOIN users lu ON t.last_post_user_id = lu.id
                WHERE c.slug = ? AND t.is_pinned = TRUE ORDER BY t.last_post_at DESC`, [category]) : [],
            query(countSql, params)
        ]);

        const total = countResult[0].total;

        res.json({
            success: true,
            threads: category ? [...pinnedThreads, ...threads] : threads,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('Threads error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch threads' });
    }
});

// Get single thread with replies
router.get('/api/threads/:id', async (req, res) => {
    return threadDetailHandler(req, res);
});
router.get('/api/threads/:id/:slug', async (req, res) => {
    return threadDetailHandler(req, res);
});
const threadDetailHandler = async (req, res) => {
    try {
        const threadId = parseInt(req.params.id);
        if (isNaN(threadId)) return res.status(400).json({ success: false, error: 'Invalid thread ID' });

        // Update views counter (simple)
        await query('UPDATE threads SET views = views + 1 WHERE id = ?', [threadId]);

        const threads = await query(`
            SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                   u.username, u.display_name, u.avatar, u.role, u.reputation, u.post_count, u.created_at as user_created,
                   (SELECT COUNT(*) FROM reactions WHERE target_type = 'thread' AND target_id = t.id) as likes
            FROM threads t
            JOIN categories c ON t.category_id = c.id
            JOIN users u ON t.user_id = u.id
            WHERE t.id = ?`, [threadId]);

        if (threads.length === 0) return res.status(404).json({ success: false, error: 'Thread not found' });

        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;

        const replies = await query(`
            SELECT r.*, u.username, u.display_name, u.avatar, u.role, u.reputation, u.post_count, u.created_at as user_created,
                   (SELECT COUNT(*) FROM reactions WHERE target_type = 'reply' AND target_id = r.id) as likes,
                   (SELECT GROUP_CONCAT(reaction_type) FROM reactions WHERE target_type = 'reply' AND target_id = r.id AND user_id = ?) as user_reaction
            FROM replies r
            JOIN users u ON r.user_id = u.id
            WHERE r.thread_id = ? AND r.parent_id IS NULL
            ORDER BY r.is_solution DESC, r.created_at ASC
            LIMIT ? OFFSET ?`, [req.user?.id || 0, threadId, limit, offset]);

        const [replyCount] = await query('SELECT COUNT(*) as total FROM replies WHERE thread_id = ? AND parent_id IS NULL', [threadId]);

        res.json({
            success: true,
            thread: threads[0],
            replies,
            pagination: { page, limit, total: replyCount.total, pages: Math.ceil(replyCount.total / limit) }
        });
    } catch (error) {
        console.error('Thread detail error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch thread' });
    }
};

// Create thread
router.post('/api/threads', requireAuth, async (req, res) => {
    try {
        const { title, content, category_id, tags } = await req.json();

        if (!title || !content || !category_id) {
            return res.status(400).json({ success: false, error: 'Title, content, and category are required' });
        }

        if (title.length < 3 || title.length > 255) {
            return res.status(400).json({ success: false, error: 'Title must be 3-255 characters' });
        }

        if (content.length < 10) {
            return res.status(400).json({ success: false, error: 'Content must be at least 10 characters' });
        }

        const slug = slugify(title);
        const result = await transaction(async (conn) => {
            const [insertResult] = await conn.execute(
                'INSERT INTO threads (category_id, user_id, title, slug, content) VALUES (?, ?, ?, ?, ?)',
                [category_id, req.user.id, title, slug, content]
            );
            await conn.execute('UPDATE categories SET thread_count = thread_count + 1 WHERE id = ?', [category_id]);
            await conn.execute('UPDATE users SET post_count = post_count + 1 WHERE id = ?', [req.user.id]);
            return insertResult;
        });

        // Handle tags
        if (tags && tags.length > 0) {
            for (const tagId of tags) {
                await query('INSERT IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [result.insertId, tagId]);
                await query('UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?', [tagId]);
            }
        }

        res.status(201).json({ success: true, thread: { id: result.insertId, title, slug } });
    } catch (error) {
        console.error('Create thread error:', error);
        res.status(500).json({ success: false, error: 'Failed to create thread' });
    }
});

// Create reply
router.post('/api/threads/:id/replies', requireAuth, async (req, res) => {
    try {
        const threadId = parseInt(req.params.id);
        const { content, parent_id } = await req.json();

        if (!content || content.length < 1) {
            return res.status(400).json({ success: false, error: 'Reply content is required' });
        }

        const [threadCheck] = await query('SELECT id, is_locked, user_id FROM threads WHERE id = ?', [threadId]);
        if (!threadCheck) return res.status(404).json({ success: false, error: 'Thread not found' });
        if (threadCheck.is_locked) return res.status(403).json({ success: false, error: 'Thread is locked' });

        const result = await transaction(async (conn) => {
            const [insertResult] = await conn.execute(
                'INSERT INTO replies (thread_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)',
                [threadId, req.user.id, content, parent_id || null]
            );
            await conn.execute('UPDATE threads SET reply_count = reply_count + 1, last_post_at = NOW(), last_post_user_id = ? WHERE id = ?', [req.user.id, threadId]);
            await conn.execute('UPDATE categories SET post_count = post_count + 1 WHERE id = (SELECT category_id FROM threads WHERE id = ?)', [threadId]);
            await conn.execute('UPDATE users SET post_count = post_count + 1 WHERE id = ?', [req.user.id]);
            return insertResult;
        });

        // Notify thread author
        if (threadCheck.user_id !== req.user.id) {
            await query(
                'INSERT INTO notifications (user_id, actor_id, type, title, message, link) VALUES (?, ?, ?, ?, ?, ?)',
                [threadCheck.user_id, req.user.id, 'reply', 'New reply', `${req.user.username} replied to your thread`, `/t/${threadId}`]
            );
        }

        const [newReply] = await query(`
            SELECT r.*, u.username, u.display_name, u.avatar, u.role, u.reputation
            FROM replies r JOIN users u ON r.user_id = u.id WHERE r.id = ?`, [result.insertId]);

        res.status(201).json({ success: true, reply: newReply });
    } catch (error) {
        console.error('Reply error:', error);
        res.status(500).json({ success: false, error: 'Failed to post reply' });
    }
});

// Like/unlike thread or reply
router.post('/api/reactions', requireAuth, async (req, res) => {
    try {
        const { target_type, target_id } = await req.json();
        if (!['thread', 'reply'].includes(target_type)) return res.status(400).json({ success: false });

        const existing = await query(
            'SELECT id FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?',
            [req.user.id, target_type, target_id]
        );

        if (existing.length > 0) {
            await query('DELETE FROM reactions WHERE id = ?', [existing[0].id]);
            if (target_type === 'thread') await query('UPDATE threads SET like_count = like_count - 1 WHERE id = ?', [target_id]);
            if (target_type === 'reply') await query('UPDATE replies SET like_count = like_count - 1 WHERE id = ?', [target_id]);
            return res.json({ success: true, liked: false });
        }

        await query('INSERT INTO reactions (user_id, target_type, target_id) VALUES (?, ?, ?)', [req.user.id, target_type, target_id]);
        if (target_type === 'thread') await query('UPDATE threads SET like_count = like_count + 1 WHERE id = ?', [target_id]);
        if (target_type === 'reply') await query('UPDATE replies SET like_count = like_count + 1 WHERE id = ?', [target_id]);

        res.json({ success: true, liked: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Pin/Unpin thread (mod/admin)
router.patch('/api/threads/:id/pin', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        await query('UPDATE threads SET is_pinned = NOT is_pinned WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Lock/Unlock thread (mod/admin)
router.patch('/api/threads/:id/lock', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        await query('UPDATE threads SET is_locked = NOT is_locked WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Mark as solution (thread author or mod/admin)
// Edit thread (title/content) — author or mod
router.patch('/api/threads/:id', requireAuth, async (req, res) => {
    try {
        const [thread] = await query('SELECT user_id FROM threads WHERE id = ?', [req.params.id]);
        if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });
        if (thread.user_id !== req.user.id && !['moderator', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Not allowed' });
        }

        const { title, content } = await req.json();
        const updates = [];
        const values = [];
        if (title !== undefined) {
            if (!title.trim() || title.trim().length < 5 || title.trim().length > 255) {
                return res.status(400).json({ success: false, error: 'Title must be 5-255 characters' });
            }
            updates.push('title = ?');
            values.push(title.trim());
        }
        if (content !== undefined) {
            if (!content.trim() || content.trim().length < 10) {
                return res.status(400).json({ success: false, error: 'Content must be at least 10 characters' });
            }
            updates.push('content = ?');
            values.push(content.trim());
        }
        if (updates.length === 0) return res.status(400).json({ success: false, error: 'Nothing to update' });
        updates.push('edited_at = NOW()');
        values.push(req.params.id);
        await query(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`, values);
        res.json({ success: true, message: 'Thread updated' });
    } catch (error) {
        console.error('Edit thread error:', error);
        res.status(500).json({ success: false, error: 'Update failed' });
    }
});

// Edit reply content — author or mod
router.patch('/api/replies/:id', requireAuth, async (req, res) => {
    try {
        const [reply] = await query('SELECT user_id FROM replies WHERE id = ?', [req.params.id]);
        if (!reply) return res.status(404).json({ success: false, error: 'Reply not found' });
        if (reply.user_id !== req.user.id && !['moderator', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Not allowed' });
        }

        const { content } = await req.json();
        if (!content || !content.trim() || content.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Content must be at least 2 characters' });
        }
        await query('UPDATE replies SET content = ?, edited_at = NOW() WHERE id = ?', [content.trim(), req.params.id]);
        res.json({ success: true, message: 'Reply updated' });
    } catch (error) {
        console.error('Edit reply error:', error);
        res.status(500).json({ success: false, error: 'Update failed' });
    }
});

// Get raw content for the edit modal
router.get('/api/threads/:id/raw', requireAuth, async (req, res) => {
    try {
        const [thread] = await query('SELECT user_id, title, content FROM threads WHERE id = ?', [req.params.id]);
        if (!thread) return res.status(404).json({ success: false });
        if (thread.user_id !== req.user.id && !['moderator', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false });
        }
        res.json({ success: true, title: thread.title, content: thread.content });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

router.get('/api/replies/:id/raw', requireAuth, async (req, res) => {
    try {
        const [reply] = await query('SELECT user_id, content FROM replies WHERE id = ?', [req.params.id]);
        if (!reply) return res.status(404).json({ success: false });
        if (reply.user_id !== req.user.id && !['moderator', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false });
        }
        res.json({ success: true, content: reply.content });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

router.patch('/api/replies/:id/solution', requireAuth, async (req, res) => {
    try {
        const replies = await query('SELECT thread_id FROM replies WHERE id = ?', [req.params.id]);
        if (!replies.length) return res.status(404).json({ success: false });

        const [thread] = await query('SELECT user_id FROM threads WHERE id = ?', [replies[0].thread_id]);
        if (!thread || (thread.user_id !== req.user.id && !['moderator', 'admin'].includes(req.user.role))) {
            return res.status(403).json({ success: false });
        }

        await query('UPDATE replies SET is_solution = NOT is_solution WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Categories
router.get('/api/categories', async (req, res) => {
    try {
        const categories = await query(`
            SELECT c.*,
                (SELECT COUNT(*) FROM threads WHERE category_id = c.id) as actual_threads,
                (SELECT t.title FROM threads t WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_thread,
                (SELECT u.username FROM threads t JOIN users u ON t.user_id = u.id WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_user,
                (SELECT t.last_post_at FROM threads t WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_time
            FROM categories c WHERE c.is_hidden = FALSE ORDER BY c.sort_order
        `);
        res.json({ success: true, categories });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Tags
router.get('/api/tags', async (req, res) => {
    try {
        const tags = await query('SELECT * FROM tags ORDER BY usage_count DESC');
        res.json({ success: true, tags });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Notifications
router.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const notifications = await query(
            'SELECT n.*, u.username, u.avatar FROM notifications n LEFT JOIN users u ON n.actor_id = u.id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 20',
            [req.user.id]
        );
        const unread = await query('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE', [req.user.id]);
        res.json({ success: true, notifications, unread: unread[0].count });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

router.post('/api/notifications/read', requireAuth, async (req, res) => {
    try {
        const { id } = await req.json();
        if (id) {
            await query('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?', [id, req.user.id]);
        } else {
            await query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.user.id]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Search
router.get('/api/search', async (req, res) => {
    try {
        const q = req.query.q || '';
        if (!q || q.length < 2) return res.json({ success: true, results: [] });

        const [threads, users, categories] = await Promise.all([
            query(`SELECT t.id, t.title, t.slug, c.slug as cat_slug FROM threads t JOIN categories c ON t.category_id = c.id WHERE t.title LIKE ? ORDER BY t.last_post_at DESC LIMIT 5`, [`%${q}%`]),
            query(`SELECT id, username, display_name, avatar FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 5`, [`%${q}%`, `%${q}%`]),
            query(`SELECT id, name, slug, color, icon FROM categories WHERE name LIKE ? LIMIT 5`, [`%${q}%`])
        ]);

        res.json({ success: true, results: { threads, users, categories } });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Leaderboard / active users
router.get('/api/leaderboard', async (req, res) => {
    try {
        const users = await query('SELECT id, username, display_name, avatar, reputation, post_count FROM users WHERE is_banned = FALSE ORDER BY reputation DESC LIMIT 10');
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

module.exports = router;
