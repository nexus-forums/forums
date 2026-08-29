const HyperExpress = require('hyper-express');
const { query, transaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { slugify, timeAgo, generateAvatar } = require('../utils/helpers');
const { checkContent } = require('../utils/filter');
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
            WHERE t.is_pinned = FALSE AND c.is_hidden = FALSE AND t.moderation_status = 'visible'
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
                WHERE c.slug = ? AND t.is_pinned = TRUE AND t.moderation_status = 'visible' ORDER BY t.last_post_at DESC`, [category]) : [],
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
        if (threads[0].moderation_status === 'pending' && !(req.user && (['moderator', 'admin'].includes(req.user.role) || req.user.id === threads[0].user_id))) {
            return res.status(404).json({ success: false, error: 'Thread not found' });
        }

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
                AND (r.moderation_status = 'visible' OR r.user_id = ? OR ?)
            ORDER BY r.is_solution DESC, r.created_at ASC
            LIMIT ? OFFSET ?`, [req.user?.id || 0, threadId, req.user?.id || 0, req.user && ['moderator','admin'].includes(req.user.role) ? 1 : 0, limit, offset]);

        const [replyCount] = await query('SELECT COUNT(*) as total FROM replies WHERE thread_id = ? AND parent_id IS NULL AND (moderation_status = \'visible\' OR user_id = ? OR ?)', [threadId, req.user?.id || 0, req.user && ['moderator','admin'].includes(req.user.role) ? 1 : 0]);

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

        const isMod = ['moderator', 'admin'].includes(req.user.role);
        let pending = false;
        if (!isMod) {
            const filterResult = await checkContent(`${title}\n${content}`);
            if (filterResult.blocked.length > 0) {
                return res.status(400).json({ success: false, error: `Your post contains banned word(s): ${filterResult.blocked.join(', ')}` });
            }
            pending = filterResult.flagged.length > 0;
        }

        const slug = slugify(title);
        const result = await transaction(async (conn) => {
            const [insertResult] = await conn.execute(
                'INSERT INTO threads (category_id, user_id, title, slug, content, moderation_status) VALUES (?, ?, ?, ?, ?, ?)',
                [category_id, req.user.id, title, slug, content, pending ? 'pending' : 'visible']
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

        res.status(201).json({ success: true, thread: { id: result.insertId, title, slug }, pending, message: pending ? 'Your post contains keywords that require review — it has been submitted to the moderation queue.' : undefined });
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

        const isMod = ['moderator', 'admin'].includes(req.user.role);
        let pending = false;
        if (!isMod) {
            const filterResult = await checkContent(content);
            if (filterResult.blocked.length > 0) {
                return res.status(400).json({ success: false, error: `Your reply contains banned word(s): ${filterResult.blocked.join(', ')}` });
            }
            pending = filterResult.flagged.length > 0;
        }

        const result = await transaction(async (conn) => {
            const [insertResult] = await conn.execute(
                'INSERT INTO replies (thread_id, user_id, content, parent_id, moderation_status) VALUES (?, ?, ?, ?, ?)',
                [threadId, req.user.id, content, parent_id || null, pending ? 'pending' : 'visible']
            );
            await conn.execute('UPDATE threads SET reply_count = reply_count + 1, last_post_at = NOW(), last_post_user_id = ? WHERE id = ?', [req.user.id, threadId]);
            await conn.execute('UPDATE categories SET post_count = post_count + 1 WHERE id = (SELECT category_id FROM threads WHERE id = ?)', [threadId]);
            await conn.execute('UPDATE users SET post_count = post_count + 1 WHERE id = ?', [req.user.id]);
            return insertResult;
        });

        // Notify thread author (unless the reply is held for moderation — it's sent on approval instead)
        if (!pending && threadCheck.user_id !== req.user.id) {
            await query(
                'INSERT INTO notifications (user_id, actor_id, type, title, message, link) VALUES (?, ?, ?, ?, ?, ?)',
                [threadCheck.user_id, req.user.id, 'reply', 'New reply', `${req.user.username} replied to your thread`, `/t/${threadId}`]
            );
        }

        const [newReply] = await query(`
            SELECT r.*, u.username, u.display_name, u.avatar, u.role, u.reputation
            FROM replies r JOIN users u ON r.user_id = u.id WHERE r.id = ?`, [result.insertId]);

        res.status(201).json({ success: true, reply: newReply, pending, message: pending ? 'Your reply contains keywords that require review — it has been submitted to the moderation queue.' : undefined });
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

// Delete thread (mod/admin)
router.delete('/api/threads/:id', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [t] = await query('SELECT id, category_id FROM threads WHERE id = ?', [id]);
        if (!t) return res.status(404).json({ success: false, error: 'Thread not found' });
        await transaction(async conn => {
            const [replyRows] = await conn.execute('SELECT id, COUNT(*) AS c FROM replies WHERE thread_id = ?', [id]);
            const replyCount = replyRows.length ? replyRows[0].c : 0;
            await conn.execute('DELETE r FROM reactions r JOIN replies rp ON r.target_type = "reply" AND r.target_id = rp.id WHERE rp.thread_id = ?', [id]);
            await conn.execute('DELETE FROM reactions WHERE target_type = "thread" AND target_id = ?', [id]);
            await conn.execute('DELETE FROM replies WHERE thread_id = ?', [id]);
            await conn.execute('DELETE FROM thread_tags WHERE thread_id = ?', [id]);
            await conn.execute('DELETE FROM threads WHERE id = ?', [id]);
            await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - 1, 0), post_count = GREATEST(post_count - ?, 0) WHERE id = ?', [replyCount + 1, t.category_id]);
        });
        res.json({ success: true, message: 'Thread deleted' });
    } catch (error) {
        console.error('Delete thread error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete thread' });
    }
});

// Move thread to another category (mod/admin)
router.patch('/api/threads/:id/move', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { category_id } = await req.json();
        const [cat] = await query('SELECT id FROM categories WHERE id = ?', [parseInt(category_id)]);
        if (!cat) return res.status(400).json({ success: false, error: 'Invalid category' });
        const [t] = await query('SELECT id, category_id FROM threads WHERE id = ?', [id]);
        if (!t) return res.status(404).json({ success: false, error: 'Thread not found' });
        if (t.category_id === cat.id) return res.json({ success: true, message: 'Thread already in that category' });
        await transaction(async conn => {
            await conn.execute('UPDATE threads SET category_id = ? WHERE id = ?', [cat.id, id]);
            await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - 1, 0) WHERE id = ?', [t.category_id]);
            await conn.execute('UPDATE categories SET thread_count = thread_count + 1 WHERE id = ?', [cat.id]);
        });
        res.json({ success: true, message: 'Thread moved' });
    } catch (error) {
        console.error('Move thread error:', error);
        res.status(500).json({ success: false, error: 'Failed to move thread' });
    }
});

// Merge source thread into target thread (mod/admin)
router.post('/api/threads/:id/merge', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        const { source_id } = await req.json();
        const sourceId = parseInt(source_id);
        if (isNaN(sourceId) || sourceId === targetId) return res.status(400).json({ success: false, error: 'Invalid source thread' });
        const [target] = await query('SELECT id, category_id, reply_count, views FROM threads WHERE id = ?', [targetId]);
        const [source] = await query('SELECT id, category_id, reply_count, views FROM threads WHERE id = ?', [sourceId]);
        if (!target || !source) return res.status(404).json({ success: false, error: 'Thread not found' });
        await transaction(async conn => {
            await conn.execute('UPDATE replies SET thread_id = ? WHERE thread_id = ?', [targetId, sourceId]);
            await conn.execute('DELETE r FROM reactions r JOIN replies rp ON r.target_type = "reply" AND r.target_id = rp.id WHERE rp.thread_id = ?', [sourceId]);
            await conn.execute('DELETE FROM reactions WHERE target_type = "thread" AND target_id = ?', [sourceId]);
            await conn.execute('DELETE FROM threads WHERE id = ?', [sourceId]);
            const [merged] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [targetId]);
            await conn.execute('UPDATE threads SET reply_count = ?, views = views + ?, last_post_at = GREATEST(last_post_at, NOW()) WHERE id = ?', [merged[0].c, source.views, targetId]);
            if (source.category_id !== target.category_id) {
                await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - 1, 0) WHERE id = ?', [source.category_id]);
            }
        });
        res.json({ success: true, message: 'Threads merged' });
    } catch (error) {
        console.error('Merge thread error:', error);
        res.status(500).json({ success: false, error: 'Failed to merge threads' });
    }
});

// Delete reply (author or mod/admin)
router.delete('/api/replies/:id', requireAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [r] = await query('SELECT r.id, r.user_id, r.thread_id, t.category_id, t.user_id AS thread_author FROM replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?', [id]);
        if (!r) return res.status(404).json({ success: false, error: 'Reply not found' });
        const isMod = ['moderator', 'admin'].includes(req.user.role);
        if (r.user_id !== req.user.id && !isMod) return res.status(403).json({ success: false, error: 'Not allowed' });
        await transaction(async conn => {
            await conn.execute('DELETE FROM reactions WHERE target_type = "reply" AND target_id = ?', [id]);
            await conn.execute('DELETE FROM replies WHERE id = ?', [id]);
            const [c] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [r.thread_id]);
            await conn.execute('UPDATE threads SET reply_count = ? WHERE id = ?', [c[0].c, r.thread_id]);
            await conn.execute('UPDATE categories SET post_count = GREATEST(post_count - 1, 0) WHERE id = ?', [r.category_id]);
        });
        res.json({ success: true, message: 'Reply deleted' });
    } catch (error) {
        console.error('Delete reply error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete reply' });
    }
});

// Report a thread or reply (any authenticated user)
router.post('/api/reports', requireAuth, async (req, res) => {
    try {
        const { target_type, target_id, reason } = await req.json();
        if (!['thread', 'reply'].includes(target_type)) return res.status(400).json({ success: false, error: 'Invalid target type' });
        const tid = parseInt(target_id);
        if (isNaN(tid)) return res.status(400).json({ success: false, error: 'Invalid target' });
        const table = target_type === 'thread' ? 'threads' : 'replies';
        const [exists] = await query(`SELECT id FROM ${table} WHERE id = ?`, [tid]);
        if (!exists) return res.status(404).json({ success: false, error: 'Post not found' });
        const [dupe] = await query('SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = "pending"', [req.user.id, target_type, tid]);
        if (dupe) return res.status(400).json({ success: false, error: 'You have already reported this post' });
        await query('INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)', [req.user.id, target_type, tid, (reason || '').toString().slice(0, 500) || null]);
        res.json({ success: true, message: 'Post reported. A moderator will review it.' });
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ success: false, error: 'Report failed' });
    }
});

// Resolve a report — delete content or dismiss (mod/admin)
router.post('/api/mod/reports/:id/resolve', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { action } = await req.json();
        const [report] = await query('SELECT id, target_type, target_id, status FROM reports WHERE id = ?', [id]);
        if (!report) return res.status(404).json({ success: false, error: 'Report not found' });
        if (report.status !== 'pending') return res.status(400).json({ success: false, error: 'Report already handled' });

        if (action === 'delete') {
            if (report.target_type === 'thread') {
                await transaction(async conn => {
                    const [t] = await conn.execute('SELECT category_id FROM threads WHERE id = ?', [report.target_id]);
                    if (t.length) {
                        const [rc] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [report.target_id]);
                        await conn.execute('DELETE r FROM reactions r JOIN replies rp ON r.target_type = "reply" AND r.target_id = rp.id WHERE rp.thread_id = ?', [report.target_id]);
                        await conn.execute('DELETE FROM reactions WHERE target_type = "thread" AND target_id = ?', [report.target_id]);
                        await conn.execute('DELETE FROM replies WHERE thread_id = ?', [report.target_id]);
                        await conn.execute('DELETE FROM thread_tags WHERE thread_id = ?', [report.target_id]);
                        await conn.execute('DELETE FROM threads WHERE id = ?', [report.target_id]);
                        await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - 1, 0), post_count = GREATEST(post_count - ?, 0) WHERE id = ?', [rc[0].c + 1, t[0].category_id]);
                    }
                });
            } else {
                const [r] = await query('SELECT r.id, r.thread_id, t.category_id FROM replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?', [report.target_id]);
                if (r) {
                    await transaction(async conn => {
                        await conn.execute('DELETE FROM reactions WHERE target_type = "reply" AND target_id = ?', [report.target_id]);
                        await conn.execute('DELETE FROM replies WHERE id = ?', [report.target_id]);
                        const [c] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [r.thread_id]);
                        await conn.execute('UPDATE threads SET reply_count = ? WHERE id = ?', [c[0].c, r.thread_id]);
                        await conn.execute('UPDATE categories SET post_count = GREATEST(post_count - 1, 0) WHERE id = ?', [r.category_id]);
                    });
                }
            }
        } else if (action !== 'dismiss') {
            return res.status(400).json({ success: false, error: 'Unknown action' });
        }

        await query('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?', [action === 'delete' ? 'resolved' : 'dismissed', req.user.id, id]);
        res.json({ success: true, message: action === 'delete' ? 'Content deleted and report resolved' : 'Report dismissed' });
    } catch (error) {
        console.error('Resolve report error:', error);
        res.status(500).json({ success: false, error: 'Resolve failed' });
    }
});

// Approve/delete posts held in the moderation queue — mod/admin
router.post('/api/mod/pending/resolve', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const { type, id, action } = await req.json();
        const pid = parseInt(id);
        if (!['thread', 'reply'].includes(type) || !['approve', 'delete'].includes(action) || !pid) {
            return res.status(400).json({ success: false, error: 'Invalid request' });
        }
        if (action === 'approve') {
            const table = type === 'thread' ? 'threads' : 'replies';
            const [row] = await query(`SELECT id FROM ${table} WHERE id = ?`, [pid]);
            if (!row) return res.status(404).json({ success: false, error: 'Post not found' });
            await query(`UPDATE ${table} SET moderation_status = 'visible' WHERE id = ?`, [pid]);
            if (type === 'reply') {
                // Notification was deferred while the reply was pending — send it now
                const [r] = await query('SELECT user_id, thread_id FROM replies WHERE id = ?', [pid]);
                if (r) {
                    const [t] = await query('SELECT user_id, title FROM threads WHERE id = ?', [r.thread_id]);
                    if (t && t.user_id !== r.user_id) {
                        const [actor] = await query('SELECT username FROM users WHERE id = ?', [r.user_id]);
                        await query(
                            'INSERT INTO notifications (user_id, actor_id, type, title, message, link) VALUES (?, ?, ?, ?, ?, ?)',
                            [t.user_id, r.user_id, 'reply', 'New reply', `${actor.username} replied to your thread`, `/t/${r.thread_id}`]
                        );
                    }
                }
            }
            return res.json({ success: true, message: 'Post approved and now visible' });
        }
        // delete
        if (type === 'thread') {
            await transaction(async conn => {
                const [t] = await conn.execute('SELECT category_id FROM threads WHERE id = ?', [pid]);
                if (t.length) {
                    const [rc] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [pid]);
                    await conn.execute('DELETE r FROM reactions r JOIN replies rp ON r.target_type = "reply" AND r.target_id = rp.id WHERE rp.thread_id = ?', [pid]);
                    await conn.execute('DELETE FROM reactions WHERE target_type = "thread" AND target_id = ?', [pid]);
                    await conn.execute('DELETE FROM replies WHERE thread_id = ?', [pid]);
                    await conn.execute('DELETE FROM thread_tags WHERE thread_id = ?', [pid]);
                    await conn.execute('DELETE FROM threads WHERE id = ?', [pid]);
                    await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - 1, 0), post_count = GREATEST(post_count - ?, 0) WHERE id = ?', [rc[0].c + 1, t[0].category_id]);
                }
            });
        } else {
            const [r] = await query('SELECT r.thread_id, t.category_id FROM replies r JOIN threads t ON t.id = r.thread_id WHERE r.id = ?', [pid]);
            if (r) {
                await transaction(async conn => {
                    await conn.execute('DELETE FROM reactions WHERE target_type = "reply" AND target_id = ?', [pid]);
                    await conn.execute('DELETE FROM replies WHERE id = ?', [pid]);
                    const [c] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [r.thread_id]);
                    await conn.execute('UPDATE threads SET reply_count = ? WHERE id = ?', [c[0].c, r.thread_id]);
                    await conn.execute('UPDATE categories SET post_count = GREATEST(post_count - 1, 0) WHERE id = ?', [r.category_id]);
                });
            }
        }
        res.json({ success: true, message: 'Post deleted' });
    } catch (error) {
        console.error('Pending resolve error:', error);
        res.status(500).json({ success: false, error: 'Action failed' });
    }
});

// Bulk moderation (threads or replies) — mod/admin
router.post('/api/mod/bulk', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const { type, ids, action, category_id } = await req.json();
        if (!['threads', 'replies'].includes(type) || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid type or ids' });
        }
        const parsed = ids.map(x => parseInt(x)).filter(x => !isNaN(x));
        if (parsed.length === 0) return res.status(400).json({ success: false, error: 'No valid ids' });
        const placeholders = parsed.map(() => '?').join(',');

        if (type === 'threads') {
            switch (action) {
                case 'pin':
                    await query(`UPDATE threads SET is_pinned = TRUE WHERE id IN (${placeholders})`, parsed);
                    break;
                case 'unpin':
                    await query(`UPDATE threads SET is_pinned = FALSE WHERE id IN (${placeholders})`, parsed);
                    break;
                case 'lock':
                    await query(`UPDATE threads SET is_locked = TRUE WHERE id IN (${placeholders})`, parsed);
                    break;
                case 'unlock':
                    await query(`UPDATE threads SET is_locked = FALSE WHERE id IN (${placeholders})`, parsed);
                    break;
                case 'move': {
                    const [cat] = await query('SELECT id FROM categories WHERE id = ?', [parseInt(category_id)]);
                    if (!cat) return res.status(400).json({ success: false, error: 'Invalid category' });
                    await transaction(async conn => {
                        const [oldCounts] = await conn.execute(`SELECT category_id, COUNT(*) AS c FROM threads WHERE id IN (${placeholders}) GROUP BY category_id`, parsed);
                        for (const row of oldCounts) {
                            await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - ?, 0) WHERE id = ?', [row.c, row.category_id]);
                        }
                        await conn.execute(`UPDATE threads SET category_id = ? WHERE id IN (${placeholders})`, [cat.id, ...parsed]);
                        await conn.execute('UPDATE categories SET thread_count = thread_count + ? WHERE id = ?', [parsed.length, cat.id]);
                    });
                    break;
                }
                case 'delete':
                    await transaction(async conn => {
                        const [stats] = await conn.execute(`SELECT category_id, COUNT(*) AS c, SUM(reply_count) AS replies FROM threads WHERE id IN (${placeholders})`, parsed);
                        const total = parsed.length + (stats[0].replies || 0);
                        await conn.execute('DELETE r FROM reactions r JOIN replies rp ON r.target_type = "reply" AND r.target_id = rp.id WHERE rp.thread_id IN (' + placeholders + ')', parsed);
                        await conn.execute(`DELETE FROM reactions WHERE target_type = "thread" AND target_id IN (${placeholders})`, parsed);
                        await conn.execute(`DELETE FROM replies WHERE thread_id IN (${placeholders})`, parsed);
                        await conn.execute(`DELETE FROM thread_tags WHERE thread_id IN (${placeholders})`, parsed);
                        await conn.execute(`DELETE FROM threads WHERE id IN (${placeholders})`, parsed);
                        if (stats[0].category_id) {
                            await conn.execute('UPDATE categories SET thread_count = GREATEST(thread_count - ?, 0), post_count = GREATEST(post_count - ?, 0) WHERE id = ?', [parsed.length, total, stats[0].category_id]);
                        }
                    });
                    break;
                default:
                    return res.status(400).json({ success: false, error: 'Unknown action' });
            }
        } else {
            // replies
            if (action !== 'delete') return res.status(400).json({ success: false, error: 'For replies only the "delete" action is supported' });
            await transaction(async conn => {
                const [rows] = await conn.execute(`SELECT id, thread_id FROM replies WHERE id IN (${placeholders})`, parsed);
                if (rows.length === 0) return res.json({ success: true, message: 'Nothing to delete', affected: 0 });
                const rIds = rows.map(r => r.id);
                const rp = rIds.map(() => '?').join(',');
                await conn.execute(`DELETE FROM reactions WHERE target_type = "reply" AND target_id IN (${rp})`, rIds);
                await conn.execute(`DELETE FROM replies WHERE id IN (${rp})`, rIds);
                const threadIds = [...new Set(rows.map(r => r.thread_id))];
                for (const tid of threadIds) {
                    const [c] = await conn.execute('SELECT COUNT(*) AS c FROM replies WHERE thread_id = ?', [tid]);
                    await conn.execute('UPDATE threads SET reply_count = ? WHERE id = ?', [c[0].c, tid]);
                }
                await conn.execute('UPDATE categories SET post_count = GREATEST(post_count - ?, 0) WHERE id = (SELECT category_id FROM threads WHERE id = ?)', [rIds.length, threadIds[0]]);
            });
        }
        res.json({ success: true, message: `Bulk ${action} applied to ${parsed.length} ${type}` });
    } catch (error) {
        console.error('Bulk mod error:', error);
        res.status(500).json({ success: false, error: 'Bulk action failed' });
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
            if (!['moderator', 'admin'].includes(req.user.role)) {
                const filterResult = await checkContent(`${title !== undefined ? title + '\n' : ''}${content}`);
                if (filterResult.blocked.length > 0) {
                    return res.status(400).json({ success: false, error: `Your post contains banned word(s): ${filterResult.blocked.join(', ')}` });
                }
                if (filterResult.flagged.length > 0) {
                    updates.push('moderation_status = ?');
                    values.push('pending');
                }
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
        let pendingFlag = false;
        if (!['moderator', 'admin'].includes(req.user.role)) {
            const filterResult = await checkContent(content);
            if (filterResult.blocked.length > 0) {
                return res.status(400).json({ success: false, error: `Your reply contains banned word(s): ${filterResult.blocked.join(', ')}` });
            }
            pendingFlag = filterResult.flagged.length > 0;
        }
        if (pendingFlag) {
            await query('UPDATE replies SET content = ?, edited_at = NOW(), moderation_status = \'pending\' WHERE id = ?', [content.trim(), req.params.id]);
        } else {
            await query('UPDATE replies SET content = ?, edited_at = NOW() WHERE id = ?', [content.trim(), req.params.id]);
        }
        res.json({ success: true, message: pendingFlag ? 'Reply updated and submitted for moderation review.' : 'Reply updated' });
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
