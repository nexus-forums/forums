require('dotenv').config();
const HyperExpress = require('hyper-express');
const path = require('path');
const fs = require('fs');
const marked = require('marked');
const sanitizeHtml = require('sanitize-html');
const cookieParser = require('cookie-parser');

const { pool, query } = require('./config/db');
const { page, alertBox } = require('./utils/render');
const { timeAgo, slugify, escapeHtml, generateAvatar, iconSvg } = require('./utils/helpers');
const { authenticate, requireRole } = require('./middleware/auth');
const { checkContent, clearCache } = require('./utils/filter');
const authRouter = require('./routes/auth');
const threadsRouter = require('./routes/threads');

const app = new HyperExpress.Server();
const PORT = parseInt(process.env.PORT) || 3000;

// Configure marked
marked.setOptions({ gfm: true, breaks: true, headerIds: false });

function renderMarkdown(content) {
    return sanitizeHtml(marked.parse(content), {
        allowedTags: ['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'hr'],
        allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'title'], '*': ['class'] },
        allowedSchemes: ['http', 'https', 'mailto']
    });
}

// Middleware
app.use((req, res, next) => {
    res.on('upgrade', () => {});
    next();
});

// Cookie parser (manual for HyperExpress)
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, ...rest] = cookie.trim().split('=');
            req.cookies[name] = decodeURIComponent(rest.join('='));
        });
    }
    next();
});

// CSRF protection (double-submit cookie pattern)
app.use((req, res, next) => {
    if (!req.cookies.csrf) {
        const token = require('crypto').randomBytes(32).toString('hex');
        req.cookies.csrf = token;
        res.header('Set-Cookie', `csrf=${token}; Path=/; SameSite=Lax`);
    }
    req.csrfToken = req.cookies.csrf;
    next();
});
app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
        const header = req.headers['x-csrf-token'] || req.headers['X-CSRF-Token'];
        if (!header || header !== req.cookies.csrf) {
            return res.status(403).json({ success: false, error: 'Invalid or missing CSRF token' });
        }
    }
    next();
});

// Auth middleware
app.use(authenticate);

// Static files
app.get('/css/*', async (req, res) => {
    const filePath = path.join(__dirname, 'public', 'css', req.path.replace('/css/', ''));
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        res.header('Content-Type', 'text/css');
        res.send(content);
    } catch { res.status(404).send('Not found'); }
});

app.get('/js/*', async (req, res) => {
    const filePath = path.join(__dirname, 'public', 'js', req.path.replace('/js/', ''));
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        res.header('Content-Type', 'application/javascript');
        res.send(content);
    } catch { res.status(404).send('Not found'); }
});

// API routes
app.use('/api/auth', authRouter);
app.use('/', threadsRouter);

// ========== HTML ROUTES ==========

// Homepage
app.get('/', async (req, res) => {
    try {
        const [categories, hotThreads, recentThreads, leaderboard, stats] = await Promise.all([
            query(`SELECT c.*,
                (SELECT COUNT(*) FROM threads WHERE category_id = c.id) as actual_threads,
                (SELECT t.title FROM threads t WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_thread,
                (SELECT t.slug FROM threads t WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_slug,
                (SELECT t.id FROM threads t WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_id,
                (SELECT u.username FROM threads t JOIN users u ON t.user_id = u.id WHERE t.category_id = c.id ORDER BY t.last_post_at DESC LIMIT 1) as latest_user
                FROM categories c WHERE c.is_hidden = FALSE ORDER BY c.sort_order`),
            query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar
                FROM threads t JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
                WHERE t.moderation_status = 'visible'
                ORDER BY t.views DESC LIMIT 4`),
            query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar
                FROM threads t JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
                WHERE t.moderation_status = 'visible'
                ORDER BY t.last_post_at DESC LIMIT 6`),
            query('SELECT id, username, display_name, avatar, reputation FROM users WHERE is_banned = FALSE ORDER BY reputation DESC LIMIT 5'),
            query(`SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM threads) as threads, (SELECT COUNT(*) FROM replies) as replies`)
        ]);

        const categoryCards = categories.map(cat => `
            <a href="/c/${cat.slug}" class="card category-card">
                <div class="card-header">
                    <div class="card-icon" style="background:${cat.color}26;color:${cat.color}">
                        ${iconSvg(cat.icon)}
                    </div>
                    <div>
                        <h3>${escapeHtml(cat.name)}</h3>
                        <span style="font-size:0.8rem;color:var(--text-muted)">${cat.actual_threads} discussions</span>
                    </div>
                </div>
                <p>${escapeHtml(cat.description || '')}</p>
                ${cat.latest_thread ? `
                <span class="recent-thread">
                    <strong>${escapeHtml(cat.latest_thread)}</strong>
                    <small>by ${escapeHtml(cat.latest_user)}</small>
                </span>` : ''}
            </a>
        `).join('');

        const hotCards = hotThreads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="card" style="position:relative;overflow:hidden">
                <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${t.category_color}"></div>
                <div class="card-header">
                    <div class="card-icon" style="background:${t.category_color}20;color:${t.category_color}">
                        <span style="font-size:1.3rem">🔥</span>
                    </div>
                    <div>
                        <h3 style="font-size:1rem">${escapeHtml(t.title)}</h3>
                        <span style="font-size:0.75rem;color:var(--text-muted)">${escapeHtml(t.category_name)}</span>
                    </div>
                </div>
                <p style="font-size:0.85rem;color:var(--text-secondary);line-height:1.5">${escapeHtml(t.content.substring(0, 120))}${t.content.length > 120 ? '...' : ''}</p>
                <div class="card-meta">
                    <span>👁 ${t.views.toLocaleString()}</span>
                    <span>💬 ${t.reply_count}</span>
                    <span>❤️ ${t.like_count}</span>
                    <span>${timeAgo(t.last_post_at)}</span>
                </div>
            </a>
        `).join('');

        const recentList = recentThreads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="thread-card ${t.is_pinned ? 'pinned' : ''}">
                <div class="avatar-wrap">
                    <img src="${t.avatar || generateAvatar(t.username || t.display_name)}" alt="${t.username}" width="48" height="48" loading="lazy">
                    ${t.is_pinned ? '<span class="pinned-badge">📌</span>' : ''}
                </div>
                <div class="thread-content">
                    <h4>${escapeHtml(t.title)}</h4>
                    <p class="excerpt">${escapeHtml(t.content.substring(0, 140))}${t.content.length > 140 ? '...' : ''}</p>
                    <div class="thread-meta">
                        <span style="color:${t.category_color}">● ${escapeHtml(t.category_name)}</span>
                        <span>by ${escapeHtml(t.display_name || t.username)}</span>
                        <span>${timeAgo(t.last_post_at)}</span>
                    </div>
                </div>
                <div class="thread-stats">
                    <div class="stat"><span class="stat-value">${t.reply_count}</span><span class="stat-label">replies</span></div>
                    <div class="stat"><span class="stat-value">${t.views}</span><span class="stat-label">views</span></div>
                    <div class="stat"><span class="stat-value">${t.like_count}</span><span class="stat-label">likes</span></div>
                </div>
            </a>
        `).join('');

        const leaderboardHtml = leaderboard.map((u, i) => `
            <a href="/u/${u.username}" class="user-row">
                <span style="width:24px;text-align:center;font-weight:800;font-size:0.85rem;color:var(--text-muted)">#${i+1}</span>
                <img src="${u.avatar || generateAvatar(u.username || u.display_name)}" alt="${u.username}" width="40" height="40">
                <div class="info">
                    <div class="name">${escapeHtml(u.display_name || u.username)}</div>
                    <div class="meta">@${u.username}</div>
                </div>
                <span class="rep">${u.reputation} rep</span>
            </a>
        `).join('');

        const body = `
        <div class="hero">
            <div class="container">
                <div class="hero-content">
                    <span class="hero-badge">Welcome to Nexus</span>
                    <h1 class="hero-title">Where <span>conversations</span><br>come alive</h1>
                    <p class="hero-subtitle">Join thousands of passionate people discussing technology, creativity, science, and everything in between.</p>
                    ${req.user ? `<a href="/new" class="btn btn-primary btn-lg">Start a Discussion</a>` : `<a href="/register" class="btn btn-primary btn-lg">Get Started</a>`}
                    <div class="hero-stats">
                        <div class="hero-stat"><div class="hero-stat-value">${stats[0].users.toLocaleString()}</div><div class="hero-stat-label">Members</div></div>
                        <div class="hero-stat"><div class="hero-stat-value">${stats[0].threads.toLocaleString()}</div><div class="hero-stat-label">Discussions</div></div>
                        <div class="hero-stat"><div class="hero-stat-value">${stats[0].replies.toLocaleString()}</div><div class="hero-stat-label">Replies</div></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="container" style="padding-top:3rem;padding-bottom:2rem">
            <div class="section-header">
                <h2><span class="icon">📂</span> Explore Categories</h2>
            </div>
            <div class="card-grid">${categoryCards}</div>
        </div>

        <div class="container" style="padding-top:2rem;padding-bottom:2rem">
            <div class="section-header">
                <h2><span class="icon">🔥</span> Trending Now</h2>
            </div>
            <div class="card-grid">${hotCards}</div>
        </div>

        <div class="container" style="padding-top:2rem;padding-bottom:3rem">
            <div class="sidebar">
                <div class="sidebar-left">
                    <div class="section-header">
                        <h2><span class="icon">💬</span> Recent Discussions <span class="sub">The latest from our community</span></h2>
                        <a href="/latest" class="btn btn-ghost btn-sm">View All</a>
                    </div>
                    <div class="thread-list">${recentList}</div>
                </div>
                <div class="sidebar-right">
                    <div class="sidebar-card">
                        <h3>🏆 Top Contributors</h3>
                        <div style="display:flex;flex-direction:column;gap:0.25rem">${leaderboardHtml}</div>
                    </div>
                    <div class="sidebar-card">
                        <h3>✨ Why Join?</h3>
                        <ul style="list-style:none;display:flex;flex-direction:column;gap:0.6rem;font-size:0.85rem;color:var(--text-secondary)">
                            <li>🔒 Private messaging with members</li>
                            <li>⭐ Build reputation and earn badges</li>
                            <li>📧 Real-time notifications</li>
                            <li>🏷️ Tag and organize discussions</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Home', body, req.user));
    } catch (error) {
        console.error('Homepage error:', error);
        res.status(500).send('Server Error');
    }
});

// Category page
app.get('/c/:slug', async (req, res) => {
    try {
        const [category] = await query('SELECT * FROM categories WHERE slug = ? AND is_hidden = FALSE', [req.params.slug]);
        if (!category) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Category not found</h3></div></div>', req.user));

        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const offset = (pageNum - 1) * limit;

        const [threads, countResult] = await Promise.all([
            query(`SELECT t.*, u.username, u.display_name, u.avatar, lu.username as last_username, lu.display_name as last_display_name
                FROM threads t
                JOIN users u ON t.user_id = u.id
                LEFT JOIN users lu ON t.last_post_user_id = lu.id
                WHERE t.category_id = ? AND t.moderation_status = 'visible' ORDER BY t.is_pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`,
                [category.id, limit, offset]),
            query('SELECT COUNT(*) as total FROM threads WHERE category_id = ? AND moderation_status = ?', [category.id, 'visible'])
        ]);

        const total = countResult[0].total;
        const pages = Math.ceil(total / limit);

        const threadList = threads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="thread-card ${t.is_pinned ? 'pinned' : ''}">
                <div class="avatar-wrap">
                    <img src="${t.avatar || generateAvatar(t.username || t.display_name)}" alt="${t.username}" width="48" height="48">
                    ${t.is_pinned ? '<span class="pinned-badge">📌</span>' : ''}
                </div>
                <div class="thread-content">
                    <h4>${escapeHtml(t.title)}</h4>
                    <p class="excerpt">${escapeHtml(t.content.substring(0, 140))}${t.content.length > 140 ? '...' : ''}</p>
                    <div class="thread-meta">
                        <span>by ${escapeHtml(t.display_name || t.username)}</span>
                        <span>${timeAgo(t.last_post_at)}</span>
                        ${t.last_username ? `<span>last by ${escapeHtml(t.last_display_name || t.last_username)}</span>` : ''}
                    </div>
                </div>
                <div class="thread-stats">
                    <div class="stat"><span class="stat-value">${t.reply_count}</span><span class="stat-label">replies</span></div>
                    <div class="stat"><span class="stat-value">${t.views}</span><span class="stat-label">views</span></div>
                    <div class="stat"><span class="stat-value">${t.like_count}</span><span class="stat-label">likes</span></div>
                </div>
            </a>
        `).join('');

        let pagination = '';
        if (pages > 1) {
            pagination = '<div class="pagination">';
            if (pageNum > 1) pagination += `<a href="/c/${category.slug}?page=${pageNum-1}">←</a>`;
            for (let i = 1; i <= pages; i++) {
                if (i === pageNum) pagination += `<span class="current">${i}</span>`;
                else if (i === 1 || i === pages || Math.abs(i - pageNum) <= 2) pagination += `<a href="/c/${category.slug}?page=${i}">${i}</a>`;
                else if (Math.abs(i - pageNum) === 3) pagination += `<span class="ellipsis">...</span>`;
            }
            if (pageNum < pages) pagination += `<a href="/c/${category.slug}?page=${pageNum+1}">→</a>`;
            pagination += '</div>';
        }

        const body = `
        <div class="container" style="padding-top:2rem">
            <div class="quick-bar">
                <div class="breadcrumb">
                    <a href="/">Home</a> <span>/</span> <span style="color:var(--text-primary);font-weight:600">${escapeHtml(category.name)}</span>
                </div>
                ${req.user ? `<a href="/new?category=${category.id}" class="btn btn-primary btn-sm">New Discussion</a>` : ''}
            </div>
            <div style="margin-bottom:2rem">
                <h1 style="font-size:2rem;font-weight:800;margin-bottom:0.5rem;color:${category.color}">${escapeHtml(category.name)}</h1>
                <p style="color:var(--text-secondary)">${escapeHtml(category.description || '')}</p>
            </div>
            <div class="thread-list">${threadList || '<div class="empty-state"><p>No discussions yet. Be the first!</p></div>'}</div>
            ${pagination}
        </div>`;

        res.header('Content-Type', 'text/html');
        res.send(page(category.name, body, req.user));
    } catch (error) {
        console.error('Category error:', error);
        res.status(500).send('Server Error');
    }
});

// Thread page
const threadPageHandler = async (req, res) => {
    try {
        const threadId = parseInt(req.params.id);
        if (isNaN(threadId)) return res.status(404).send('Not Found');

        await query('UPDATE threads SET views = views + 1 WHERE id = ?', [threadId]);

        const [thread] = await query(`
            SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar, u.role, u.reputation, u.post_count, u.created_at as user_created
            FROM threads t
            JOIN categories c ON t.category_id = c.id
            JOIN users u ON t.user_id = u.id
            WHERE t.id = ?`, [threadId]);

        if (req.user) {
            const [lk] = await query('SELECT COUNT(*) as c FROM reactions WHERE user_id = ? AND target_type = \'thread\' AND target_id = ?', [req.user.id, threadId]);
            thread.user_liked = lk.c > 0;
        } else thread.user_liked = false;

        if (!thread) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Thread not found</h3></div></div>', req.user));
        const isMod = req.user && ['moderator', 'admin'].includes(req.user.role);
        const canSeePending = isMod || (req.user && req.user.id === thread.user_id);
        if (thread.moderation_status === 'pending' && !canSeePending) {
            return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Thread not found</h3></div></div>', req.user));
        }
        if (thread.moderation_status === 'pending') {
            thread._pendingNotice = '<div class="card" style="border-left:3px solid var(--warning);padding:1rem;margin-bottom:1.5rem">⏳ This post is <strong>pending moderation review</strong> and is not publicly visible until approved.</div>';
        } else thread._pendingNotice = '';
        const modCategories = req.user && ['moderator', 'admin'].includes(req.user.role) ? await query('SELECT id, name FROM categories WHERE is_hidden = FALSE ORDER BY name') : [];

        const threadTags = await query(`SELECT g.id, g.name, g.slug, g.color FROM tags g JOIN thread_tags tt ON tt.tag_id = g.id WHERE tt.thread_id = ? ORDER BY g.name`, [threadId]);
        const threadTagPills = threadTags.map(g => `<a href="/tag/${g.id}/${g.slug}" class="tag-pill" style="background:${g.color}20;color:${g.color};border-color:${g.color}40">${escapeHtml(g.name)}</a>`).join('');

        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 15;
        const offset = (pageNum - 1) * limit;

        const replies = await query(`
            SELECT r.*, u.username, u.display_name, u.avatar, u.role, u.reputation, u.post_count, u.created_at as user_created,
                (SELECT COUNT(*) FROM reactions WHERE target_type = 'reply' AND target_id = r.id) as likes,
                (SELECT COUNT(*) FROM reactions WHERE target_type = 'reply' AND target_id = r.id AND user_id = ?) as user_liked
            FROM replies r JOIN users u ON r.user_id = u.id
            WHERE r.thread_id = ? AND r.parent_id IS NULL
                AND (r.moderation_status = 'visible' OR r.user_id = ? OR ?)
            ORDER BY r.is_solution DESC, r.created_at ASC LIMIT ? OFFSET ?`,
            [req.user ? req.user.id : 0, threadId, req.user ? req.user.id : 0, isMod ? 1 : 0, limit, offset]);

        const [replyCount] = await query('SELECT COUNT(*) as total FROM replies WHERE thread_id = ? AND parent_id IS NULL AND (moderation_status = \'visible\' OR user_id = ? OR ?)', [threadId, req.user ? req.user.id : 0, isMod ? 1 : 0]);
        const totalReplies = replyCount.total;
        const pages = Math.ceil(totalReplies / limit);

        const renderPost = (p, isThread = false) => {
            const roleBadge = p.role !== 'user' ? `<span class="author-role ${p.role}">${p.role}</span>` : '';
            const isAuthor = req.user && req.user.id === (isThread ? thread.user_id : p.user_id);
            const isMod = req.user && ['moderator', 'admin'].includes(req.user.role);
            const solutionBadge = p.is_solution ? '<span style="background:var(--success);color:white;padding:0.15rem 0.5rem;border-radius:var(--radius-sm);font-size:0.7rem;font-weight:700;margin-left:0.5rem">✓ Solution</span>' : '';
            const pendingBadge = p.moderation_status === 'pending' ? '<span style="background:var(--warning);color:white;padding:0.15rem 0.5rem;border-radius:var(--radius-sm);font-size:0.7rem;font-weight:700;margin-left:0.5rem">⏳ Pending review</span>' : '';
            const modActions = isMod ? `
                <button onclick="fetch('/api/threads/${thread.id}/lock',{method:'PATCH'}).then(()=>location.reload())" title="${thread.is_locked ? 'Unlock' : 'Lock'}">🔒</button>
                <button onclick="fetch('/api/threads/${thread.id}/pin',{method:'PATCH'}).then(()=>location.reload())" title="${thread.is_pinned ? 'Unpin' : 'Pin'}">📌</button>
                <button onclick="modMove(${thread.id})" title="Move to category…">📦</button>
                <button onclick="modMerge(${thread.id})" title="Merge another thread into this one">🔗</button>
            ` : '';
            const deleteAction = isMod ? `<button onclick="modDelete('${isThread ? 'threads' : 'replies'}', ${p.id})" title="Delete">🗑</button>` : (req.user && !isThread && req.user.id === p.user_id ? `<button onclick="modDelete('replies', ${p.id})" title="Delete">🗑</button>` : '');
            const editActions = (isAuthor || isMod) ? `<button onclick="openEditModal('${isThread ? 'thread' : 'reply'}', ${p.id})" title="Edit">✏️</button>` : '';
            return `
            <div class="post ${isThread ? 'thread-post' : ''}">
                <div class="post-author">
                    <img src="${p.avatar || generateAvatar(p.username || p.display_name)}" alt="${p.username}" class="author-avatar" width="64" height="64">
                    <div class="author-identity">
                        <a href="/u/${p.username}" class="author-name">${escapeHtml(p.display_name || p.username)}</a>
                        ${roleBadge}
                    </div>
                    <div class="author-stats">
                        <div><span class="author-rep">${p.reputation}</span></div>
                        <div>${p.post_count} posts</div>
                        <div>joined ${new Date(p.user_created).getFullYear()}</div>
                    </div>
                </div>
                <div class="post-body">
                    <div class="post-header">
                        <div style="display:flex;align-items:center;gap:0.5rem">
                            <time>${timeAgo(p.created_at)}</time>
                            ${p.edited_at ? '<span style="color:var(--text-muted);font-size:0.75rem">(edited)</span>' : ''}
                            ${solutionBadge}
                            ${isThread && thread.moderation_status === 'pending' ? pendingBadge : (!isThread && p.moderation_status === 'pending' ? pendingBadge : '')}
                            ${isThread && thread.is_locked ? '<span style="background:var(--danger);color:white;padding:0.15rem 0.5rem;border-radius:var(--radius-sm);font-size:0.7rem;font-weight:700">🔒 Locked</span>' : ''}
                        </div>
                        <div class="post-actions">
                            <button onclick="handleLike('${isThread ? 'thread' : 'reply'}', ${p.id}, this)">${p.user_liked ? '❤️' : '🤍'} <span>${isThread ? (p.like_count || 0) : (p.likes || 0)}</span></button>
                            ${!isThread && (req.user?.id === thread.user_id || isMod) ? `<button onclick="fetch('/api/replies/${p.id}/solution',{method:'PATCH'}).then(()=>location.reload())" title="Mark as solution">✓</button>` : ''}
                            ${editActions}
                            ${modActions}
                            ${deleteAction}
                            ${req.user && !(isAuthor && !isThread) && !isMod ? `<button onclick="reportPost('${isThread ? 'thread' : 'reply'}', ${p.id})" title="Report">⚑</button>` : ''}
                            ${req.user && !isThread ? `<button onclick="quotePost(${p.id}, this)" data-author="${escapeHtml(p.username)}" title="Quote">❝</button>` : ''}
                        </div>
                    </div>
                    <div class="post-content markdown-body">${renderMarkdown(p.content)}</div>
                </div>
            </div>`;
        };

        const posts = renderPost(thread, true) + replies.map(r => renderPost(r)).join('');

        let pagination = '';
        if (pages > 1) {
            pagination = '<div class="pagination">';
            if (pageNum > 1) pagination += `<a href="/t/${thread.id}/${thread.slug}?page=${pageNum-1}">←</a>`;
            for (let i = 1; i <= pages; i++) {
                if (i === pageNum) pagination += `<span class="current">${i}</span>`;
                else if (i === 1 || i === pages || Math.abs(i - pageNum) <= 2) pagination += `<a href="/t/${thread.id}/${thread.slug}?page=${i}">${i}</a>`;
                else if (Math.abs(i - pageNum) === 3) pagination += `<span class="ellipsis">...</span>`;
            }
            if (pageNum < pages) pagination += `<a href="/t/${thread.id}/${thread.slug}?page=${pageNum+1}">→</a>`;
            pagination += '</div>';
        }

        const replyForm = req.user && !thread.is_locked ? `
            <div class="reply-box">
                <h3>Post a Reply</h3>
                <form id="replyForm" onsubmit="event.preventDefault(); submitReply(${thread.id})">
                    <div class="editor-toolbar">
                        <button type="button" data-action="bold">B</button>
                        <button type="button" data-action="italic">I</button>
                        <button type="button" data-action="link">🔗</button>
                        <button type="button" data-action="image">🖼</button>
                        <button type="button" data-action="code">&lt;/&gt;</button>
                        <button type="button" data-action="quote">"</button>
                    </div>
                    <textarea id="replyContent" class="form-textarea" rows="5" placeholder="Write your reply..." required></textarea>
                    <div style="margin-top:0.75rem;display:flex;justify-content:space-between;align-items:center">
                        <span class="form-hint">Supports Markdown formatting</span>
                        <button type="submit" class="btn btn-primary">Post Reply</button>
                    </div>
                </form>
            </div>
        ` : thread.is_locked ? '<div class="reply-box" style="text-align:center;color:var(--text-muted)">🔒 This thread is locked.</div>' : '';

        const body = `
        <div class="container" style="padding-top:1.5rem">
            <div class="quick-bar">
                <div class="breadcrumb">
                    <a href="/">Home</a> <span>/</span>
                    <a href="/c/${thread.category_slug}">${escapeHtml(thread.category_name)}</a> <span>/</span>
                    <span style="color:var(--text-primary);font-weight:600">Thread</span>
                </div>
                ${req.user ? `<a href="/new?category=${thread.category_id}" class="btn btn-ghost btn-sm">New Discussion</a>` : ''}
            </div>
            <div class="thread-header">
                <h1 style="color:${thread.category_color}">${escapeHtml(thread.title)}</h1>
                <div class="thread-info">
                    <span>by <a href="/u/${thread.username}">${escapeHtml(thread.display_name || thread.username)}</a></span>
                    <span>${timeAgo(thread.created_at)}</span>
                    <span>👁 ${thread.views}</span>
                    <span>💬 ${totalReplies}</span>
                </div>
                ${threadTagPills ? `<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.75rem">${threadTagPills}</div>` : ''}
            </div>
            ${thread._pendingNotice}
            <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:1.5rem">
                ${posts}
            </div>
            ${pagination}
            ${replyForm}
        </div>
        <div id="editModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center;padding:1rem">
            <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:640px;padding:1.5rem">
                <h3 style="margin-bottom:1rem">Edit Post</h3>
                <form id="editModalForm">
                    <input type="hidden" id="editModalType">
                    <input type="hidden" id="editModalId">
                    <div class="form-group" id="editModalTitleRow">
                        <label class="form-label" for="editModalTitle">Title</label>
                        <input class="form-input" id="editModalTitle" type="text" maxlength="255" style="width:100%">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="editModalContent">Content (Markdown)</label>
                        <div class="editor-toolbar">
                            <button type="button" data-action="bold">B</button>
                            <button type="button" data-action="italic">I</button>
                            <button type="button" data-action="link">🔗</button>
                            <button type="button" data-action="image">🖼</button>
                            <button type="button" data-action="code">&lt;/&gt;</button>
                            <button type="button" data-action="quote">"</button>
                        </div>
                        <textarea class="form-textarea" id="editModalContent" rows="8" style="width:100%"></textarea>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:0.5rem">
                        <button type="button" class="btn btn-ghost" onclick="closeEditModal()">Cancel</button>
                        <button type="submit" class="btn btn-primary">Save Changes</button>
                    </div>
                </form>
            </div>
        </div>
        <div id="moveModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center;padding:1rem">
            <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:420px;padding:1.5rem">
                <h3 style="margin-bottom:1rem">Move Thread</h3>
                <input type="hidden" id="moveModalThreadId">
                <div class="form-group">
                    <label class="form-label" for="moveModalCategory">New category</label>
                    <select class="form-input" id="moveModalCategory" data-current="${thread.category_id}" style="width:100%">
                        ${modCategories.map(c => `<option value="${c.id}" ${c.id === thread.category_id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
                    </select>
                    <span class="form-hint">Current category is pre-selected.</span>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
                    <button type="button" class="btn btn-ghost" onclick="document.getElementById('moveModal').style.display='none'">Cancel</button>
                    <button type="button" class="btn btn-primary" onclick="submitMove()">Move Thread</button>
                </div>
            </div>
        </div>
        <script>
        function openEditModal(type, id) {
            fetch('/api/' + (type === 'thread' ? 'threads' : 'replies') + '/' + id + '/raw')
                .then(r => r.json())
                .then(d => {
                    if (!d.success) return showToast('Cannot load post', 'error');
                    document.getElementById('editModalType').value = type;
                    document.getElementById('editModalId').value = id;
                    document.getElementById('editModalTitle').value = d.title || '';
                    document.getElementById('editModalTitleRow').style.display = type === 'thread' ? '' : 'none';
                    document.getElementById('editModalContent').value = d.content;
                    document.getElementById('editModal').style.display = 'flex';
                })
                .catch(() => showToast('Cannot load post', 'error'));
        }
        function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }
        function modDelete(type, id) {
            if (!confirm('Permanently delete this ' + (type === 'threads' ? 'thread (including all replies)' : 'reply') + '?')) return;
            fetch('/api/' + type + '/' + id, { method: 'DELETE' })
                .then(r => r.json())
                .then(d => { if (d.success) { if (type === 'threads') location.href = '/'; else location.reload(); } else showToast(d.error || 'Delete failed', 'error'); })
                .catch(() => showToast('Delete failed', 'error'));
        }
        async function modMove(threadId) {
            document.getElementById('moveModalThreadId').value = threadId;
            const sel = document.getElementById('moveModalCategory');
            sel.value = sel.dataset.current || sel.options[0].value;
            document.getElementById('moveModal').style.display = 'flex';
        }
        async function submitMove() {
            const threadId = document.getElementById('moveModalThreadId').value;
            const categoryId = document.getElementById('moveModalCategory').value;
            document.getElementById('moveModal').style.display = 'none';
            const r = await fetch('/api/threads/' + threadId + '/move', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ category_id: parseInt(categoryId) }) });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Move failed', 'error');
        }
        async function modMerge(threadId) {
            const sourceId = prompt('Merge which thread INTO this one? Enter the source thread ID:');
            if (!sourceId) return;
            const r = await fetch('/api/threads/' + threadId + '/merge', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ source_id: parseInt(sourceId) }) });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Merge failed', 'error');
        }
        function reportPost(type, id) {
            const reason = prompt('Why are you reporting this post? (optional):');
            if (reason === null) return;
            fetch('/api/reports', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ target_type: type, target_id: id, reason }) })
                .then(r => r.json())
                .then(d => d.success ? showToast(d.message, 'success') : showToast(d.error || 'Report failed', 'error'))
                .catch(() => showToast('Report failed', 'error'));
        }
        document.getElementById('editModalForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const type = document.getElementById('editModalType').value;
            const id = document.getElementById('editModalId').value;
            const payload = { content: document.getElementById('editModalContent').value };
            if (type === 'thread') payload.title = document.getElementById('editModalTitle').value;
            try {
                const r = await fetch('/api/' + (type === 'thread' ? 'threads' : 'replies') + '/' + id, {
                    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
                });
                const d = await r.json();
                if (d.success) location.reload();
                else showToast(d.error || 'Edit failed', 'error');
            } catch (err) { showToast('Edit failed', 'error'); }
        });
        async function submitReply(threadId) {
            const content = document.getElementById('replyContent').value;
            if (!content.trim()) return showToast('Reply cannot be empty', 'error');
            try {
                const res = await fetch('/api/threads/' + threadId + '/replies', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                const data = await res.json();
                if (data.success) { showToast(data.pending && data.message ? data.message : 'Reply posted', 'info'); setTimeout(() => location.reload(), data.pending ? 1500 : 300); }
                else { showToast(data.error || 'Failed to post', 'error'); }
            } catch (e) { showToast('Network error', 'error'); }
        }
        </script>`;

        res.header('Content-Type', 'text/html');
        res.send(page(thread.title, body, req.user));
    } catch (error) {
        console.error('Thread error:', error);
        res.status(500).send('Server Error');
    }
};
app.get('/t/:id', threadPageHandler);
app.get('/t/:id/:slug', threadPageHandler);

// Tag page — threads with a given tag
app.get('/tag/:id', async (req, res) => {
    const tagId = parseInt(req.params.id);
    if (isNaN(tagId)) return res.status(404).send('Not Found');
    const [tag] = await query('SELECT slug FROM tags WHERE id = ?', [tagId]);
    if (!tag) return res.status(404).send('Not Found');
    res.redirect(`/tag/${tagId}/${tag.slug}`);
});
app.get('/tag/:id/:slug', async (req, res) => {
    try {
        const tagId = parseInt(req.params.id);
        if (isNaN(tagId)) return res.status(404).send('Not Found');
        const [tag] = await query('SELECT * FROM tags WHERE id = ?', [tagId]);
        if (!tag) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Tag not found</h3></div></div>', req.user));

        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const offset = (pageNum - 1) * limit;

        const [threads, countResult] = await Promise.all([
            query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar
                FROM threads t
                JOIN thread_tags tt ON tt.thread_id = t.id
                JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
                WHERE tt.tag_id = ? AND t.moderation_status = 'visible'
                ORDER BY t.is_pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`, [tagId, limit, offset]),
            query('SELECT COUNT(*) as total FROM thread_tags tt JOIN threads t ON t.id = tt.thread_id WHERE tt.tag_id = ? AND t.moderation_status = ?', [tagId, 'visible'])
        ]);
        const total = countResult[0].total;
        const pages = Math.ceil(total / limit);

        const threadList = threads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="thread-card">
                <div class="avatar-wrap"><img src="${t.avatar || generateAvatar(t.username || t.display_name)}" alt="${t.username}" width="48" height="48"></div>
                <div class="thread-content">
                    <h4>${t.is_pinned ? '📌 ' : ''}${escapeHtml(t.title)}</h4>
                    <p class="excerpt">${escapeHtml(t.content.substring(0, 140))}${t.content.length > 140 ? '...' : ''}</p>
                    <div class="thread-meta">
                        <span style="color:${t.category_color}">● ${escapeHtml(t.category_name)}</span>
                        <span>by ${escapeHtml(t.display_name || t.username)}</span>
                        <span>${timeAgo(t.last_post_at)}</span>
                    </div>
                </div>
                <div class="thread-stats">
                    <div class="stat"><span class="stat-value">${t.reply_count}</span><span class="stat-label">replies</span></div>
                    <div class="stat"><span class="stat-value">${t.views}</span><span class="stat-label">views</span></div>
                    <div class="stat"><span class="stat-value">${t.like_count}</span><span class="stat-label">likes</span></div>
                </div>
            </a>
        `).join('') || '<div class="empty-state"><h3>No threads with this tag yet</h3></div>';

        let pagination = '';
        if (pages > 1) {
            pagination = '<div class="pagination">';
            if (pageNum > 1) pagination += `<a href="/tag/${tag.id}/${tag.slug}?page=${pageNum-1}">←</a>`;
            for (let i = 1; i <= pages; i++) {
                if (i === pageNum) pagination += `<span class="current">${i}</span>`;
                else if (i === 1 || i === pages || Math.abs(i - pageNum) <= 2) pagination += `<a href="/tag/${tag.id}/${tag.slug}?page=${i}">${i}</a>`;
                else if (Math.abs(i - pageNum) === 3) pagination += `<span class="ellipsis">...</span>`;
            }
            if (pageNum < pages) pagination += `<a href="/tag/${tag.id}/${tag.slug}?page=${pageNum+1}">→</a>`;
            pagination += '</div>';
        }

        const body = `
        <div class="container" style="padding-top:2rem">
            <div class="quick-bar">
                <div class="breadcrumb">
                    <a href="/">Home</a> <span>/</span>
                    <span style="color:var(--text-primary);font-weight:600">Tag</span>
                </div>
                ${req.user ? '<a href="/new" class="btn btn-ghost btn-sm">New Discussion</a>' : ''}
            </div>
            <div class="thread-header">
                <h1 style="color:${tag.color}">${escapeHtml(tag.name)}</h1>
                ${tag.description ? `<p style="color:var(--text-secondary);margin-top:0.5rem">${escapeHtml(tag.description)}</p>` : ''}
                <div class="thread-info"><span>${total} thread${total === 1 ? '' : 's'}</span></div>
            </div>
            <div class="thread-list">${threadList}</div>
            ${pagination}
        </div>`;
        res.send(page(`#${tag.name} — Forum`, body, req.user));
    } catch (error) {
        console.error('Tag error:', error);
        res.status(500).send('Server Error');
    }
});

// New thread page
app.get('/new', authenticate, async (req, res) => {
    if (!req.user) return res.redirect('/login?return=/new');

    const categories = await query('SELECT id, name, slug FROM categories WHERE is_hidden = FALSE ORDER BY sort_order');
    const tags = await query('SELECT id, name, color FROM tags ORDER BY name');
    const prefill = req.query.category || '';

    const categoryOptions = categories.map(c => `<option value="${c.id}" ${c.id == prefill ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    const tagOptions = tags.map(t => `<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--text-secondary);cursor:pointer"><input type="checkbox" name="tags" value="${t.id}"><span class="tag-pill" style="background:${t.color}20;color:${t.color};border-color:${t.color}40">${escapeHtml(t.name)}</span></label>`).join('');

    const body = `
    <div class="container-narrow" style="padding-top:2rem">
        <div class="quick-bar">
            <div class="breadcrumb">
                <a href="/">Home</a> <span>/</span> <span style="color:var(--text-primary);font-weight:600">New Discussion</span>
            </div>
        </div>
        <h1 style="font-size:2rem;font-weight:800;margin-bottom:1.5rem">Start a New Discussion</h1>
        <form id="newThreadForm" onsubmit="event.preventDefault(); createThread()">
            <div class="form-group">
                <label class="form-label">Title</label>
                <input type="text" id="threadTitle" class="form-input" placeholder="What's on your mind?" required maxlength="255">
            </div>
            <div class="form-group">
                <label class="form-label">Category</label>
                <select id="threadCategory" class="form-select" required>${categoryOptions}</select>
            </div>
            <div class="form-group">
                <label class="form-label">Content</label>
                <div class="editor-toolbar">
                    <button type="button" data-action="bold">B</button>
                    <button type="button" data-action="italic">I</button>
                    <button type="button" data-action="link">🔗</button>
                    <button type="button" data-action="image">🖼</button>
                    <button type="button" data-action="code">&lt;/&gt;</button>
                    <button type="button" data-action="quote">"</button>
                </div>
                <textarea id="threadContent" class="form-textarea" rows="12" placeholder="Write your post... Markdown supported." required minlength="10"></textarea>
            </div>
            <div class="form-group">
                <label class="form-label">Tags</label>
                <div style="display:flex;gap:0.75rem;flex-wrap:wrap">${tagOptions}</div>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%">Create Discussion</button>
        </form>
    </div>
    <script>
    async function createThread() {
        const title = document.getElementById('threadTitle').value;
        const content = document.getElementById('threadContent').value;
        const category_id = parseInt(document.getElementById('threadCategory').value);
        const tags = Array.from(document.querySelectorAll('input[name=tags]:checked')).map(cb => parseInt(cb.value));
        try {
            const res = await fetch('/api/threads', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content, category_id, tags })
            });
            const data = await res.json();
            if (data.success) {
                if (data.pending && data.message) showToast(data.message, 'info');
                setTimeout(() => { window.location = '/t/' + data.thread.id + '/' + data.thread.slug; }, data.pending ? 1500 : 0);
            }
            else { showToast(data.error || 'Failed to create', 'error'); }
        } catch (e) { showToast('Network error', 'error'); }
    }
    </script>`;

    res.header('Content-Type', 'text/html');
    res.send(page('New Discussion', body, req.user));
});

// User profile
app.get('/u/:username', async (req, res) => {
    try {
        const [user] = await query(
            'SELECT id, username, display_name, avatar, bio, reputation, post_count, created_at FROM users WHERE username = ? AND is_banned = FALSE',
            [req.params.username]
        );
        if (!user) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>User not found</h3></div></div>', req.user));

        const recentThreads = await query(
            `SELECT t.id, t.title, t.slug, t.created_at, t.reply_count, t.views, c.name as category_name, c.slug as category_slug, c.color as category_color
             FROM threads t JOIN categories c ON t.category_id = c.id
             WHERE t.user_id = ? AND t.moderation_status = 'visible' ORDER BY t.created_at DESC LIMIT 5`, [user.id]);

        const recentReplies = await query(
            `SELECT r.id, r.content, r.created_at, t.id as thread_id, t.title as thread_title, t.slug as thread_slug
             FROM replies r JOIN threads t ON r.thread_id = t.id
             WHERE r.user_id = ? AND r.moderation_status = 'visible' ORDER BY r.created_at DESC LIMIT 5`, [user.id]);

        const threadList = recentThreads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="thread-card" style="padding:1rem">
                <div class="thread-content">
                    <h4>${escapeHtml(t.title)}</h4>
                    <div class="thread-meta">
                        <span style="color:${t.category_color}">● ${escapeHtml(t.category_name)}</span>
                        <span>${timeAgo(t.created_at)}</span>
                        <span>💬 ${t.reply_count}</span>
                        <span>👁 ${t.views}</span>
                    </div>
                </div>
            </a>
        `).join('');

        const replyList = recentReplies.map(r => `
            <a href="/t/${r.thread_id}#reply-${r.id}" class="card" style="padding:1rem;font-size:0.875rem">
                <div style="color:var(--text-muted);font-size:0.75rem;margin-bottom:0.35rem">in <strong style="color:var(--text-primary)">${escapeHtml(r.thread_title)}</strong></div>
                <div style="color:var(--text-secondary)">${escapeHtml(r.content.substring(0, 200))}${r.content.length > 200 ? '...' : ''}</div>
                <div style="color:var(--text-muted);font-size:0.75rem;margin-top:0.35rem">${timeAgo(r.created_at)}</div>
            </a>
        `).join('');

        const body = `
        <div class="container-narrow" style="padding-top:2rem">
            <div class="card" style="text-align:center;padding:2.5rem;margin-bottom:2rem">
                <img src="${user.avatar || generateAvatar(user.username || user.display_name)}" alt="${user.username}" style="width:96px;height:96px;border-radius:50%;margin:0 auto 1rem;border:3px solid var(--border)">
                <h1 style="font-size:1.75rem;font-weight:800">${escapeHtml(user.display_name || user.username)}</h1>
                <p style="color:var(--text-muted)">@${user.username}</p>
                ${user.bio ? `<p style="color:var(--text-secondary);margin-top:0.75rem;max-width:500px;margin-left:auto;margin-right:auto">${escapeHtml(user.bio)}</p>` : ''}
                <div style="display:flex;justify-content:center;gap:2rem;margin-top:1.5rem">
                    <div style="text-align:center"><div style="font-size:1.5rem;font-weight:800">${user.reputation}</div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase">Reputation</div></div>
                    <div style="text-align:center"><div style="font-size:1.5rem;font-weight:800">${user.post_count}</div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase">Posts</div></div>
                    <div style="text-align:center"><div style="font-size:1.5rem;font-weight:800">${new Date(user.created_at).getFullYear()}</div><div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase">Joined</div></div>
                </div>
            </div>
            <div class="tabs">
                <button class="tab active" id="tabDiscussions" onclick="showProfileTab('discussions')">Discussions</button>
                <button class="tab" id="tabReplies" onclick="showProfileTab('replies')">Replies</button>
            </div>
            <div id="sectionDiscussions" style="display:flex;flex-direction:column;gap:0.75rem">
                ${threadList || '<div class="empty-state"><p>No discussions yet.</p></div>'}
            </div>
            <div id="sectionReplies" style="display:none;margin-top:2rem">
                <h2 style="margin-top:0;margin-bottom:1rem;font-size:1.25rem;font-weight:700">Recent Replies</h2>
                <div style="display:flex;flex-direction:column;gap:0.75rem">
                    ${replyList || '<div class="empty-state"><p>No replies yet.</p></div>'}
                </div>
            </div>
        </div>
        <script>
        function showProfileTab(which) {
            document.getElementById('sectionDiscussions').style.display = which === 'discussions' ? 'flex' : 'none';
            document.getElementById('sectionReplies').style.display = which === 'replies' ? 'block' : 'none';
            document.getElementById('tabDiscussions').classList.toggle('active', which === 'discussions');
            document.getElementById('tabReplies').classList.toggle('active', which === 'replies');
        }
        </script>`;

        res.header('Content-Type', 'text/html');
        res.send(page(`${user.display_name || user.username}`, body, req.user));
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).send('Server Error');
    }
});

// Users list
app.get('/users', async (req, res) => {
    try {
        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 30;
        const offset = (pageNum - 1) * limit;
        const search = req.query.search || '';

        let sql = 'SELECT id, username, display_name, avatar, reputation, post_count, created_at FROM users WHERE is_banned = FALSE';
        let countSql = 'SELECT COUNT(*) as total FROM users WHERE is_banned = FALSE';
        let params = [];
        if (search) {
            sql += ' AND (username LIKE ? OR display_name LIKE ?)';
            countSql += ' AND (username LIKE ? OR display_name LIKE ?)';
            params = [`%${search}%`, `%${search}%`];
        }
        sql += ` ORDER BY reputation DESC LIMIT ? OFFSET ?`;

        const [users, countResult] = await Promise.all([
            query(sql, [...params, limit, offset]),
            query(countSql, params)
        ]);
        const total = countResult[0].total;
        const pages = Math.ceil(total / limit);

        const userGrid = users.map((u, i) => `
            <a href="/u/${u.username}" class="card" style="display:flex;align-items:center;gap:1rem;padding:1rem">
                <span style="font-size:1.25rem;font-weight:800;color:var(--text-muted);min-width:30px;text-align:center">${offset + i + 1}</span>
                <img src="${u.avatar || generateAvatar(u.username || u.display_name)}" alt="${u.username}" style="width:48px;height:48px;border-radius:50%">
                <div style="flex:1;min-width:0">
                    <div style="font-weight:700;color:var(--text-primary)">${escapeHtml(u.display_name || u.username)}</div>
                    <div style="font-size:0.8rem;color:var(--text-muted)">@${u.username} • joined ${new Date(u.created_at).getFullYear()}</div>
                </div>
                <div style="text-align:right">
                    <div style="font-weight:800;color:var(--accent)">${u.reputation}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted)">reputation</div>
                </div>
            </a>
        `).join('');

        let pagination = '';
        if (pages > 1) {
            pagination = '<div class="pagination">';
            if (pageNum > 1) pagination += `<a href="/users?page=${pageNum-1}${search ? '&search='+encodeURIComponent(search) : ''}">←</a>`;
            for (let i = 1; i <= pages; i++) {
                if (i === pageNum) pagination += `<span class="current">${i}</span>`;
                else if (i === 1 || i === pages || Math.abs(i - pageNum) <= 2) pagination += `<a href="/users?page=${i}${search ? '&search='+encodeURIComponent(search) : ''}">${i}</a>`;
                else if (Math.abs(i - pageNum) === 3) pagination += `<span class="ellipsis">...</span>`;
            }
            if (pageNum < pages) pagination += `<a href="/users?page=${pageNum+1}${search ? '&search='+encodeURIComponent(search) : ''}">→</a>`;
            pagination += '</div>';
        }

        const body = `
        <div class="container" style="padding-top:2rem">
            <div class="section-header">
                <h2>Community Members</h2>
                <form style="display:flex;gap:0.5rem" onsubmit="event.preventDefault(); location.href='/users?search='+encodeURIComponent(this.q.value)">
                    <input type="text" name="q" class="form-input" placeholder="Search users..." value="${escapeHtml(search)}" style="width:200px">
                    <button type="submit" class="btn btn-ghost btn-sm">Search</button>
                </form>
            </div>
            <div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr));margin-bottom:2rem">${userGrid}</div>
            ${pagination}
        </div>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Members', body, req.user));
    } catch (error) {
        res.status(500).send('Server Error');
    }
});

// Latest threads
app.get('/latest', async (req, res) => {
    try {
        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 20;
        const offset = (pageNum - 1) * limit;

        const [threads, countResult] = await Promise.all([
            query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar, lu.username as last_username
                FROM threads t JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
                LEFT JOIN users lu ON t.last_post_user_id = lu.id
                WHERE t.moderation_status = 'visible'
                ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`, [limit, offset]),
            query('SELECT COUNT(*) as total FROM threads WHERE moderation_status = ?', ['visible'])
        ]);
        const total = countResult[0].total;
        const pages = Math.ceil(total / limit);

        const threadList = threads.map(t => `
            <a href="/t/${t.id}/${t.slug}" class="thread-card">
                <div class="avatar-wrap"><img src="${t.avatar || generateAvatar(t.username || t.display_name)}" alt="${t.username}" width="48" height="48"></div>
                <div class="thread-content">
                    <h4>${escapeHtml(t.title)}</h4>
                    <p class="excerpt">${escapeHtml(t.content.substring(0, 140))}${t.content.length > 140 ? '...' : ''}</p>
                    <div class="thread-meta">
                        <span style="color:${t.category_color}">● ${escapeHtml(t.category_name)}</span>
                        <span>by ${escapeHtml(t.display_name || t.username)}</span>
                        <span>${timeAgo(t.last_post_at)}</span>
                    </div>
                </div>
                <div class="thread-stats">
                    <div class="stat"><span class="stat-value">${t.reply_count}</span><span class="stat-label">replies</span></div>
                    <div class="stat"><span class="stat-value">${t.views}</span><span class="stat-label">views</span></div>
                    <div class="stat"><span class="stat-value">${t.like_count}</span><span class="stat-label">likes</span></div>
                </div>
            </a>
        `).join('');

        let pagination = '';
        if (pages > 1) {
            pagination = '<div class="pagination">';
            if (pageNum > 1) pagination += `<a href="/latest?page=${pageNum-1}">←</a>`;
            for (let i = 1; i <= pages; i++) {
                if (i === pageNum) pagination += `<span class="current">${i}</span>`;
                else if (i === 1 || i === pages || Math.abs(i - pageNum) <= 2) pagination += `<a href="/latest?page=${i}">${i}</a>`;
                else if (Math.abs(i - pageNum) === 3) pagination += `<span class="ellipsis">...</span>`;
            }
            if (pageNum < pages) pagination += `<a href="/latest?page=${pageNum+1}">→</a>`;
            pagination += '</div>';
        }

        const body = `
        <div class="container" style="padding-top:2rem">
            <div class="section-header">
                <h2><span class="icon">🕐</span> Latest Discussions</h2>
            </div>
            <div class="thread-list">${threadList}</div>
            ${pagination}
        </div>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Latest', body, req.user));
    } catch (error) {
        res.status(500).send('Server Error');
    }
});

// Auth pages
function authPage(title, subtitle, formHtml, isRegister) {
    isRegister = isRegister || false;
    var visual = '<div class="auth-visual">';
    visual += '<div class="auth-visual-dots"></div>';
    visual += '<div class="auth-visual-content">';
    visual += '<svg viewBox="0 0 32 32" width="64" height="64" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:1.5rem;opacity:0.9">';
    visual += '<polygon points="16 2 30 9 30 23 16 30 2 23 2 9"></polygon>';
    visual += '<line x1="16" y1="2" x2="16" y2="30"></line>';
    visual += '<line x1="2" y1="9" x2="30" y2="9"></line>';
    visual += '<line x1="2" y1="23" x2="30" y2="23"></line>';
    visual += '</svg><h1>Nexus</h1><p>Join a community of passionate people sharing ideas and building connections.</p>';
    visual += '</div></div>';

    var html = visual;
    html += '<a href="/" class="auth-home-btn">\u2190 Home</a>';
    html += '<div class="auth-form-wrap"><div class="auth-form">';
    html += '<h2>' + title + '</h2><p class="subtitle">' + subtitle + '</p>';
    html += '<div id="authAlert"></div>' + formHtml;
    html += '<div class="form-footer">';
    if (isRegister) {
        html += 'Already have an account? <a href="/login">Sign In</a>';
    } else {
        html += 'Do not have an account? <a href="/register">Join now</a>';
    }
    html += '</div></div></div>';

    return page(title, html, null, '<style>.navbar{display:none}.site-footer{display:none}.main-content{min-height:100vh}.auth-home-btn{position:fixed;top:1.25rem;left:1.5rem;z-index:100;display:inline-flex;align-items:center;gap:0.45rem;padding:0.55rem 1rem;border-radius:999px;background:var(--bg-elevated,rgba(255,255,255,0.06));border:1px solid var(--border,rgba(255,255,255,0.12));color:var(--text-primary);font-size:0.875rem;font-weight:600;text-decoration:none;box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,0.25));transition:border-color .15s,color .15s,transform .15s}.auth-home-btn:hover{border-color:var(--accent,#6366f1);color:var(--accent,#6366f1);transform:translateY(-1px)}</style>');
}

app.get('/login', async (req, res) => {
    if (req.user) return res.redirect('/');
    const form = `
        <form onsubmit="event.preventDefault(); login()">
            <div class="form-group">
                <label class="form-label">Username or Email</label>
                <input type="text" id="loginUser" class="form-input" placeholder="Enter username or email" required autofocus>
            </div>
            <div class="form-group">
                <label class="form-label">Password</label>
                <input type="password" id="loginPass" class="form-input" placeholder="Enter password" required>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%;margin-top:0.5rem">Sign In</button>
        </form>
        <script>
        async function login() {
            const btn = document.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Signing in...';
            try {
                const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username_or_email: document.getElementById('loginUser').value, password: document.getElementById('loginPass').value }) });
                const data = await res.json();
                if (data.success) { location.href = new URLSearchParams(location.search).get('return') || '/'; }
                else { document.getElementById('authAlert').innerHTML = '<div class=\"alert\" style=\"border-left-color:var(--danger)\">' + (data.error || 'Login failed') + '</div>'; btn.disabled = false; btn.textContent = 'Sign In'; }
            } catch (e) { document.getElementById('authAlert').innerHTML = '<div class=\"alert\" style=\"border-left-color:var(--danger)\">Network error</div>'; btn.disabled = false; btn.textContent = 'Sign In'; }
        }
        </script>`;
    res.header('Content-Type', 'text/html');
    res.send(authPage('Welcome Back', 'Sign in to your account', form, false));
});

app.get('/register', async (req, res) => {
    if (req.user) return res.redirect('/');
    const form = `
        <form onsubmit="event.preventDefault(); register()">
            <div class="form-group">
                <label class="form-label">Username</label>
                <input type="text" id="regUser" class="form-input" placeholder="Choose a username" required minlength="3" maxlength="50">
            </div>
            <div class="form-group">
                <label class="form-label">Display Name (optional)</label>
                <input type="text" id="regDisplay" class="form-input" placeholder="How you want to be known">
            </div>
            <div class="form-group">
                <label class="form-label">Email</label>
                <input type="email" id="regEmail" class="form-input" placeholder="you@example.com" required>
            </div>
            <div class="form-group">
                <label class="form-label">Password</label>
                <input type="password" id="regPass" class="form-input" placeholder="Min 6 characters" required minlength="6">
            </div>
            <button type="submit" class="btn btn-primary btn-lg" style="width:100%;margin-top:0.5rem">Create Account</button>
        </form>
        <script>
        async function register() {
            const btn = document.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Creating...';
            try {
                const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('regUser').value, display_name: document.getElementById('regDisplay').value, email: document.getElementById('regEmail').value, password: document.getElementById('regPass').value }) });
                const data = await res.json();
                if (data.success) { location.href = '/'; }
                else { document.getElementById('authAlert').innerHTML = '<div class=\"alert\" style=\"border-left-color:var(--danger)\">' + (data.error || 'Registration failed') + '</div>'; btn.disabled = false; btn.textContent = 'Create Account'; }
            } catch (e) { document.getElementById('authAlert').innerHTML = '<div class=\"alert\" style=\"border-left-color:var(--danger)\">Network error</div>'; btn.disabled = false; btn.textContent = 'Create Account'; }
        }
        </script>`;
    res.header('Content-Type', 'text/html');
    res.send(authPage('Create Account', 'Join our growing community', form, true));
});

// Notifications page
// Settings page
app.get('/settings', authenticate, async (req, res) => {
    try {
        if (!req.user) return res.redirect('/login');
        const [me] = await query('SELECT id, username, display_name, email, avatar, bio, role, reputation, post_count, created_at FROM users WHERE id = ?', [req.user.id]);
        if (!me) return res.status(404).send('Not Found');

        const body = `
        <div class="container" style="padding-top:2rem;max-width:800px">
            <div class="section-header">
                <h2>⚙️ Settings</h2>
            </div>

            <div class="card" style="padding:1.5rem;margin-bottom:1.5rem">
                <h3 style="margin-bottom:1rem">Profile</h3>
                <form id="profileForm">
                    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.25rem">
                        <img id="avatarPreview" src="${me.avatar || generateAvatar(me.username)}" onerror="this.onerror=null;this.src='${generateAvatar(me.username)}'" alt="avatar" width="72" height="72" style="border-radius:50%;border:2px solid var(--border)">
                        <div style="flex:1">
                            <label class="form-label" for="avatarInput">Avatar URL (leave empty for default)</label>
                            <input class="form-input" id="avatarInput" type="text" value="${me.avatar && !me.avatar.startsWith('data:') ? escapeHtml(me.avatar) : ''}" placeholder="https://example.com/avatar.png" style="width:100%">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="displayName">Display Name</label>
                        <input class="form-input" id="displayName" type="text" maxlength="100" value="${escapeHtml(me.display_name || me.username)}" style="width:100%">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="bio">Bio</label>
                        <textarea class="form-textarea" id="bio" rows="3" maxlength="2000" placeholder="Tell the community about yourself...">${escapeHtml(me.bio || '')}</textarea>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="email">Email</label>
                        <input class="form-input" id="email" type="email" value="${escapeHtml(me.email)}" style="width:100%">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Username</label>
                        <input class="form-input" type="text" value="${escapeHtml(me.username)}" disabled style="width:100%;opacity:0.6">
                        <span class="form-hint">Usernames cannot be changed</span>
                    </div>
                    <button type="submit" class="btn btn-primary">Save Profile</button>
                </form>
            </div>

            <div class="card" style="padding:1.5rem;margin-bottom:1.5rem">
                <h3 style="margin-bottom:1rem">Change Password</h3>
                <form id="passwordForm">
                    <div class="form-group">
                        <label class="form-label" for="currentPassword">Current Password</label>
                        <input class="form-input" id="currentPassword" type="password" required style="width:100%">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="newPassword">New Password</label>
                        <input class="form-input" id="newPassword" type="password" minlength="6" required style="width:100%">
                        <span class="form-hint">Minimum 6 characters</span>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="confirmPassword">Confirm New Password</label>
                        <input class="form-input" id="confirmPassword" type="password" minlength="6" required style="width:100%">
                    </div>
                    <button type="submit" class="btn btn-primary">Update Password</button>
                </form>
            </div>

            <div class="card" style="padding:1.5rem">
                <h3 style="margin-bottom:1rem">Account</h3>
                <div class="thread-meta" style="flex-direction:column;gap:0.5rem;align-items:flex-start">
                    <span>Role: <strong>${me.role}</strong></span>
                    <span>Reputation: <strong>${me.reputation}</strong></span>
                    <span>Posts: <strong>${me.post_count}</strong></span>
                    <span>Member since: <strong>${new Date(me.created_at).toLocaleDateString()}</strong></span>
                </div>
            </div>
        </div>
        <script>
        (function() {
            const avatarInput = document.getElementById('avatarInput');
            avatarInput.addEventListener('change', () => {
                const v = avatarInput.value.trim();
                if (v) document.getElementById('avatarPreview').src = v;
            });

            document.getElementById('profileForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                try {
                    const payload = {
                        display_name: document.getElementById('displayName').value.trim(),
                        bio: document.getElementById('bio').value,
                        avatar: document.getElementById('avatarInput').value.trim() || null,
                        email: document.getElementById('email').value.trim()
                    };
                    const r = await fetch('/api/auth/me', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
                    const d = await r.json();
                    if (d.success) { showToast('Profile saved', 'success'); setTimeout(() => location.reload(), 800); }
                    else showToast(d.error || 'Save failed', 'error');
                } catch (err) { showToast('Save failed', 'error'); }
            });

            document.getElementById('passwordForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const np = document.getElementById('newPassword').value;
                if (np !== document.getElementById('confirmPassword').value) return showToast('Passwords do not match', 'error');
                try {
                    const r = await fetch('/api/auth/password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                        current_password: document.getElementById('currentPassword').value,
                        new_password: np
                    })});
                    const d = await r.json();
                    if (d.success) { showToast('Password updated', 'success'); e.target.reset(); }
                    else showToast(d.error || 'Update failed', 'error');
                } catch (err) { showToast('Update failed', 'error'); }
            });
        })();
        </script>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Settings', body, req.user));
    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).send('Server Error');
    }
});

// Messages page (conversation list)
app.get('/messages', authenticate, async (req, res) => {
    try {
        if (!req.user) return res.redirect('/login');

        const convos = await query(`
            SELECT cp.conversation_id, c.subject, c.updated_at,
                (SELECT COUNT(*) FROM conversation_participants cp2 WHERE cp2.conversation_id = c.id AND cp2.user_id != ?) as others,
                (SELECT u.username FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id WHERE cp2.conversation_id = c.id AND cp2.user_id != ? LIMIT 1) as other_username,
                (SELECT u.display_name FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id WHERE cp2.conversation_id = c.id AND cp2.user_id != ? LIMIT 1) as other_name,
                (SELECT u.avatar FROM conversation_participants cp2 JOIN users u ON u.id = cp2.user_id WHERE cp2.conversation_id = c.id AND cp2.user_id != ? LIMIT 1) as other_avatar,
                (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message,
                (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.user_id != ? AND m.created_at > COALESCE(cp.last_read_at, '1970-01-01')) as unread
            FROM conversation_participants cp
            JOIN conversations c ON c.id = cp.conversation_id
            WHERE cp.user_id = ?
            ORDER BY c.updated_at DESC`,
            [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);

        const convoList = convos.map(cv => `
            <a href="/messages/${cv.conversation_id}" class="thread-card" style="position:relative">
                <div class="avatar-wrap"><img src="${cv.other_avatar || generateAvatar(cv.other_username)}" alt="${cv.other_username}" width="48" height="48"></div>
                <div class="thread-content">
                    <h4>${escapeHtml(cv.other_name || cv.other_username)}${cv.subject ? ` — ${escapeHtml(cv.subject)}` : ''}</h4>
                    <p class="excerpt">${escapeHtml((cv.last_message || '').substring(0, 120))}${(cv.last_message || '').length > 120 ? '...' : ''}</p>
                    <div class="thread-meta"><span>${cv.last_at ? timeAgo(cv.last_at) : ''}</span></div>
                </div>
                ${cv.unread > 0 ? `<span style="background:var(--accent);color:#fff;border-radius:999px;min-width:1.5rem;height:1.5rem;display:inline-flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;padding:0 0.4rem">${cv.unread}</span>` : ''}
            </a>
        `).join('');

        const users = await query('SELECT username FROM users WHERE is_banned = FALSE AND id != ? ORDER BY username', [req.user.id]);
        const userOptions = users.map(u => `<option value="${escapeHtml(u.username)}"></option>`).join('');

        const body = `
        <div class="container" style="padding-top:2rem;max-width:800px">
            <div class="section-header">
                <h2>✉️ Messages</h2>
            </div>
            <div class="card" style="padding:1.5rem;margin-bottom:1.5rem">
                <h3 style="margin-bottom:1rem">New Message</h3>
                <form id="newMessageForm">
                    <div class="form-group">
                        <label class="form-label" for="msgTo">To (username)</label>
                        <input class="form-input" id="msgTo" list="userList" type="text" required style="width:100%">
                        <datalist id="userList">${userOptions}</datalist>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="msgContent">Message</label>
                        <textarea class="form-textarea" id="msgContent" rows="4" required placeholder="Write your message... Markdown supported."></textarea>
                        <span class="form-hint">Supports Markdown formatting</span>
                    </div>
                    <button type="submit" class="btn btn-primary">Send Message</button>
                </form>
            </div>
            <div class="thread-list">${convoList || '<div class="empty-state"><h3>No messages yet</h3><p>Start a conversation above.</p></div>'}</div>
        </div>
        <script>
        document.getElementById('newMessageForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const r = await fetch('/api/messages', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                    to: document.getElementById('msgTo').value.trim(),
                    content: document.getElementById('msgContent').value
                })});
                const d = await r.json();
                if (d.success) location.href = '/messages/' + d.conversation_id;
                else showToast(d.error || 'Send failed', 'error');
            } catch (err) { showToast('Send failed', 'error'); }
        });
        </script>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Messages', body, req.user));
    } catch (error) {
        console.error('Messages error:', error);
        res.status(500).send('Server Error');
    }
});

// Single conversation
app.get('/messages/:id', authenticate, async (req, res) => {
    try {
        if (!req.user) return res.redirect('/login');
        const cid = parseInt(req.params.id);
        if (isNaN(cid)) return res.status(404).send('Not Found');

        const [part] = await query('SELECT last_read_at FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [cid, req.user.id]);
        if (!part) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Conversation not found</h3></div></div>', req.user));

        const [convo] = await query('SELECT subject FROM conversations WHERE id = ?', [cid]);
        const msgs = await query(`
            SELECT m.*, u.username, u.display_name, u.avatar
            FROM messages m JOIN users u ON u.id = m.user_id
            WHERE m.conversation_id = ? ORDER BY m.created_at ASC`, [cid]);

        await query('UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?', [cid, req.user.id]);

        const other = await query(`
            SELECT u.username, u.display_name FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
            WHERE cp.conversation_id = ? AND cp.user_id != ? LIMIT 1`, [cid, req.user.id]);
        const otherName = other[0] ? (other[0].display_name || other[0].username) : 'Unknown';

        const msgList = msgs.map(m => `
            <div class="post" style="${m.user_id === req.user.id ? 'border-left:3px solid var(--accent)' : ''}">
                <div class="post-header">
                    <div style="display:flex;align-items:center;gap:0.5rem">
                        <a href="/u/${m.username}" style="font-weight:600;color:var(--text-primary)">${escapeHtml(m.display_name || m.username)}</a>
                        <time>${timeAgo(m.created_at)}</time>
                    </div>
                </div>
                <div class="post-content markdown-body">${renderMarkdown(m.content)}</div>
            </div>
        `).join('');

        const body = `
        <div class="container" style="padding-top:2rem;max-width:800px">
            <div class="quick-bar">
                <div class="breadcrumb">
                    <a href="/messages">Messages</a> <span>/</span>
                    <span style="color:var(--text-primary);font-weight:600">${escapeHtml(otherName)}</span>
                </div>
            </div>
            <div class="thread-header"><h1>Chat with ${escapeHtml(otherName)}</h1>${convo && convo.subject ? `<div class="thread-info"><span>${escapeHtml(convo.subject)}</span></div>` : ''}</div>
            <div style="display:flex;flex-direction:column;gap:0.75rem;margin-bottom:1.5rem">${msgList}</div>
            <div class="reply-box">
                <form id="replyMessageForm">
                    <textarea id="replyMsgContent" class="form-textarea" rows="3" placeholder="Write a message... Markdown supported." required></textarea>
                    <span class="form-hint">Supports Markdown formatting</span>
                    <div style="margin-top:0.75rem;text-align:right"><button type="submit" class="btn btn-primary">Send</button></div>
                </form>
            </div>
        </div>
        <script>
        document.getElementById('replyMessageForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
                const r = await fetch('/api/messages/${cid}', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                    content: document.getElementById('replyMsgContent').value
                })});
                const d = await r.json();
                if (d.success) location.reload();
                else showToast(d.error || 'Send failed', 'error');
            } catch (err) { showToast('Send failed', 'error'); }
        });
        </script>`;

        res.header('Content-Type', 'text/html');
        res.send(page('Messages', body, req.user));
    } catch (error) {
        console.error('Conversation error:', error);
        res.status(500).send('Server Error');
    }
});

// Static info pages
const infoPages = {
    '/about': {
        title: 'About',
        html: `
        <h2>About Nexus</h2>
        <p>Nexus is a community forum for developers, makers, and curious minds. It's a place to share projects, ask questions, debate technology, and hang out with people who care about the same things you do.</p>
        <p>Built with Node.js and Hyper-Express, the forum is lightweight, fast, and entirely self-hosted.</p>`
    },
    '/guidelines': {
        title: 'Community Guidelines',
        html: `
        <h2>Community Guidelines</h2>
        <ul>
            <li><strong>Be respectful.</strong> Disagree with ideas, not people. Personal attacks, harassment, and hate speech are not tolerated.</li>
            <li><strong>Stay on topic.</strong> Post in the appropriate category and keep threads focused.</li>
            <li><strong>No spam.</strong> Self-promotion is fine when relevant, but drive-by advertising will be removed.</li>
            <li><strong>Respect privacy.</strong> Don't post other people's personal information without consent.</li>
            <li><strong>Use Markdown.</strong> Format your posts with Markdown for readability — code blocks, quotes, and lists all work.</li>
        </ul>`
    },
    '/privacy': {
        title: 'Privacy Policy',
        html: `
        <h2>Privacy Policy</h2>
        <p>We collect only the information needed to run this forum: your username, email address, password (stored as a bcrypt hash), and anything you choose to add to your profile.</p>
        <ul>
            <li>We do not sell or share your personal data with third parties.</li>
            <li>Email addresses are never displayed publicly.</li>
            <li>Private messages are visible only to conversation participants.</li>
            <li>You may request deletion of your account and its data at any time by contacting an administrator.</li>
        </ul>`
    },
    '/api': {
        title: 'API',
        html: `
        <h2>Nexus API</h2>
        <p>All endpoints accept and return JSON. Authenticate by sending your session cookie, or use <code>Authorization: Bearer &lt;token&gt;</code> where tokens are issued at login.</p>
        <h3>Authentication</h3>
        <table><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td>POST</td><td><code>/api/auth/register</code></td><td>Create an account</td></tr>
        <tr><td>POST</td><td><code>/api/auth/login</code></td><td>Log in, returns a token</td></tr>
        <tr><td>GET</td><td><code>/api/auth/me</code></td><td>Current user profile</td></tr>
        <tr><td>PATCH</td><td><code>/api/auth/me</code></td><td>Update profile</td></tr>
        <tr><td>POST</td><td><code>/api/auth/password</code></td><td>Change password</td></tr>
        </tbody></table>
        <h3>Threads &amp; replies</h3>
        <table><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td>GET</td><td><code>/api/threads</code></td><td>List threads</td></tr>
        <tr><td>POST</td><td><code>/api/threads</code></td><td>Create a thread</td></tr>
        <tr><td>GET</td><td><code>/api/threads/:id/raw</code></td><td>Raw thread content</td></tr>
        <tr><td>PATCH</td><td><code>/api/threads/:id</code></td><td>Edit a thread</td></tr>
        <tr><td>POST</td><td><code>/api/threads/:id/replies</code></td><td>Reply to a thread</td></tr>
        <tr><td>PATCH</td><td><code>/api/replies/:id</code></td><td>Edit a reply</td></tr>
        </tbody></table>
        <h3>Messages</h3>
        <table><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td>GET</td><td><code>/api/messages</code></td><td>List conversations</td></tr>
        <tr><td>POST</td><td><code>/api/messages</code></td><td>Send a message</td></tr>
        <tr><td>POST</td><td><code>/api/messages/:id</code></td><td>Reply in a conversation</td></tr>
        </tbody></table>`
    }
};

for (const [route, p] of Object.entries(infoPages)) {
    app.get(route, async (req, res) => {
        const body = `<div class="container" style="padding-top:2rem;max-width:800px">
            <div class="thread-header"><h1>${p.title}</h1></div>
            <div class="post-content markdown-body" style="padding:0">${p.html}</div>
        </div>`;
        res.header('Content-Type', 'text/html');
        res.send(page(p.title, body, req.user));
    });
}

// API: send a new message (starts or continues a conversation)
app.post('/api/messages', authenticate, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
        const { to, content, subject } = await req.json();
        if (!to || !content || !content.trim()) return res.status(400).json({ success: false, error: 'Recipient and message are required' });

        const [recipient] = await query('SELECT id FROM users WHERE username = ? AND is_banned = FALSE', [to]);
        if (!recipient) return res.status(404).json({ success: false, error: 'User not found' });
        if (recipient.id === req.user.id) return res.status(400).json({ success: false, error: 'You cannot message yourself' });

        // Find existing 1:1 conversation between the two users
        const existing = await query(`
            SELECT c.id FROM conversations c
            JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = ?
            JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = ?
            WHERE (SELECT COUNT(*) FROM conversation_participants p WHERE p.conversation_id = c.id) = 2
            LIMIT 1`, [req.user.id, recipient.id]);

        let cid;
        if (existing.length > 0) {
            cid = existing[0].id;
        } else {
            const result = await query('INSERT INTO conversations (subject) VALUES (?)', [subject || null]);
            cid = result.insertId;
            await query('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)', [cid, req.user.id, cid, recipient.id]);
        }

        await query('INSERT INTO messages (conversation_id, user_id, content) VALUES (?, ?, ?)', [cid, req.user.id, content.trim()]);
        await query('UPDATE conversations SET updated_at = NOW() WHERE id = ?', [cid]);
        await query('UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?', [cid, req.user.id]);

        res.json({ success: true, conversation_id: cid });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ success: false, error: 'Send failed' });
    }
});

// API: reply within an existing conversation
app.post('/api/messages/:id', authenticate, async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
        const cid = parseInt(req.params.id);
        const { content } = await req.json();
        if (!content || !content.trim()) return res.status(400).json({ success: false, error: 'Message is required' });

        const [part] = await query('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [cid, req.user.id]);
        if (!part) return res.status(404).json({ success: false, error: 'Conversation not found' });

        await query('INSERT INTO messages (conversation_id, user_id, content) VALUES (?, ?, ?)', [cid, req.user.id, content.trim()]);
        await query('UPDATE conversations SET updated_at = NOW() WHERE id = ?', [cid]);
        await query('UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?', [cid, req.user.id]);

        res.json({ success: true });
    } catch (error) {
        console.error('Reply error:', error);
        res.status(500).json({ success: false, error: 'Send failed' });
    }
});

app.get('/notifications', authenticate, async (req, res) => {
    if (!req.user) return res.redirect('/login?return=/notifications');
    const notifications = await query('SELECT n.*, u.username, u.avatar FROM notifications n LEFT JOIN users u ON n.actor_id = u.id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50', [req.user.id]);
    await query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.user.id]);

    const list = notifications.map(n => `
        <a href="${n.link || '#'}" class="card" style="display:flex;align-items:flex-start;gap:1rem;padding:1rem;margin-bottom:0.5rem;${n.is_read ? '' : 'border-left:3px solid var(--accent)'})">
            ${n.actor_id ? `<img src="${n.avatar || generateAvatar(n.username || n.display_name)}" alt="${n.username}" style="width:40px;height:40px;border-radius:50%;flex-shrink:0">` : '<div style="width:40px;height:40px;border-radius:50%;background:var(--bg-tertiary);flex-shrink:0;display:flex;align-items:center;justify-content:center">🔔</div>'}
            <div style="flex:1;min-width:0">
                <div style="font-weight:600;color:var(--text-primary)">${escapeHtml(n.title)}</div>
                <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.25rem">${escapeHtml(n.message || '')}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.35rem">${timeAgo(n.created_at)}</div>
            </div>
        </a>
    `).join('');

    const body = `
    <div class="container-narrow" style="padding-top:2rem">
        <h1 style="font-size:1.75rem;font-weight:800;margin-bottom:1.5rem">Notifications</h1>
        ${list || '<div class="empty-state"><p>No notifications yet.</p></div>'}
    </div>`;

    res.header('Content-Type', 'text/html');
    res.send(page('Notifications', body, req.user));
});

// Moderation console (mod/admin)
app.get('/moderate', requireRole(['moderator', 'admin']), async (req, res) => {
    try {
        const cats = await query('SELECT id, name FROM categories WHERE is_hidden = FALSE ORDER BY name');
        const threads = await query(`
            SELECT t.id, t.title, t.slug, t.is_pinned, t.is_locked, t.reply_count, t.views, t.created_at,
                   c.name as category_name, u.username
            FROM threads t JOIN categories c ON c.id = t.category_id JOIN users u ON u.id = t.user_id
            ORDER BY t.created_at DESC LIMIT 100`);
        const replies = await query(`
            SELECT r.id, r.content, r.created_at, t.id as thread_id, t.title as thread_title, u.username
            FROM replies r JOIN threads t ON t.id = r.thread_id JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC LIMIT 100`);
        const reports = await query(`
            SELECT rp.*, u.username as reporter_username,
                   t.title as thread_title, t.slug as thread_slug, tu.username as thread_author,
                   rc.content as reply_content, rru.username as reply_author, rt.title as reply_thread_title, rt.slug as reply_thread_slug, rt.id as reply_thread_id
            FROM reports rp
            JOIN users u ON u.id = rp.reporter_id
            LEFT JOIN threads t ON rp.target_type = 'thread' AND rp.target_id = t.id
            LEFT JOIN users tu ON tu.id = t.user_id
            LEFT JOIN replies rc ON rp.target_type = 'reply' AND rp.target_id = rc.id
            LEFT JOIN users rru ON rru.id = rc.user_id
            LEFT JOIN threads rt ON rt.id = rc.thread_id
            WHERE rp.status = 'pending'
            ORDER BY rp.created_at ASC`);
        const pendingThreads = await query(`
            SELECT t.id, t.title, t.slug, t.content, t.created_at, c.name as category_name, u.username, u.display_name
            FROM threads t JOIN categories c ON c.id = t.category_id JOIN users u ON u.id = t.user_id
            WHERE t.moderation_status = 'pending' ORDER BY t.created_at ASC`);
        const pendingReplies = await query(`
            SELECT r.id, r.content, r.created_at, t.id as thread_id, t.slug as thread_slug, t.title as thread_title, u.username, u.display_name
            FROM replies r JOIN threads t ON t.id = r.thread_id JOIN users u ON u.id = r.user_id
            WHERE r.moderation_status = 'pending' ORDER BY r.created_at ASC`);

        const catOptions = cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

        const threadRows = threads.map(t => `
            <div class="thread-card mod-row" style="align-items:center">
                <input type="checkbox" class="mod-check" data-type="threads" value="${t.id}" style="width:18px;height:18px;flex-shrink:0">
                <div class="thread-content" style="flex:1">
                    <h4 style="margin:0"><a href="/t/${t.id}/${t.slug}" style="color:var(--text-primary)">${escapeHtml(t.title)}</a></h4>
                </div>
                <div class="thread-meta" style="display:flex;gap:1rem;flex-shrink:0">
                    <span>${escapeHtml(t.category_name)}</span>
                    <span>@${escapeHtml(t.username)}</span>
                    <span>💬 ${t.reply_count}</span>
                    ${t.is_pinned ? '<span title="Pinned">📌</span>' : ''}
                    ${t.is_locked ? '<span title="Locked">🔒</span>' : ''}
                </div>
            </div>`).join('');

        const replyRows = replies.map(r => `
            <div class="thread-card mod-row" style="align-items:center">
                <input type="checkbox" class="mod-check" data-type="replies" value="${r.id}" style="width:18px;height:18px;flex-shrink:0">
                <div class="thread-content" style="flex:1">
                    <div style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(r.content.slice(0, 120))}${r.content.length > 120 ? '…' : ''}</div>
                    <div class="thread-meta"><a href="/t/${r.thread_id}">in: ${escapeHtml(r.thread_title)}</a></div>
                </div>
                <div class="thread-meta" style="flex-shrink:0"><span>@${escapeHtml(r.username)}</span><span>${timeAgo(r.created_at)}</span></div>
            </div>`).join('');

        const reportRows = reports.length === 0 ? '<div class="empty-state" style="padding:1.5rem">No pending reports</div>' : reports.map(rp => {
            const isThread = rp.target_type === 'thread';
            const link = isThread ? `/t/${rp.target_id}/${rp.thread_slug}` : `/t/${rp.reply_thread_id}/${rp.reply_thread_slug}`;
            const content = isThread ? rp.thread_title : rp.reply_content;
            const author = isThread ? rp.thread_author : rp.reply_author;
            return `
            <div class="thread-card" style="padding:1rem;align-items:center;border-left:3px solid var(--warning)">
                <div class="thread-content" style="flex:1">
                    <div style="font-size:0.9rem"><strong>${isThread ? 'Thread' : 'Reply'}</strong> by @${escapeHtml(author || '[deleted]')}: ${escapeHtml((content || '[content no longer exists]').slice(0, 140))}${content && content.length > 140 ? '…' : ''}</div>
                    <div class="thread-meta">
                        <a href="${link}">view post</a>
                        <span>reported by @${escapeHtml(rp.reporter_username)} ${timeAgo(rp.created_at)}</span>
                        ${rp.reason ? `<span style="color:var(--warning)">reason: ${escapeHtml(rp.reason)}</span>` : ''}
                    </div>
                </div>
                <div style="display:flex;gap:0.5rem;flex-shrink:0">
                    <button class="btn btn-danger btn-sm" onclick="handleReport(${rp.id}, 'delete')">🗑 Delete</button>
                    <button class="btn btn-ghost btn-sm" onclick="handleReport(${rp.id}, 'dismiss')">Dismiss</button>
                </div>
            </div>`;
        }).join('');

        const body = `
        <div class="container" style="padding-top:2rem;max-width:1100px">
            <div class="thread-header"><h1>Moderation</h1><div class="thread-info"><span>Select items, then choose an action. Bulk merge folds every selected thread into the lowest selected thread ID.</span></div></div>
            <div class="mod-toolbar" style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;padding:1rem;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:1.5rem">
                <button class="btn btn-ghost" onclick="bulk('pin')">📌 Pin</button>
                <button class="btn btn-ghost" onclick="bulk('unpin')">Unpin</button>
                <button class="btn btn-ghost" onclick="bulk('lock')">🔒 Lock</button>
                <button class="btn btn-ghost" onclick="bulk('unlock')">Unlock</button>
                <select id="moveCat" class="form-input" style="width:auto">${catOptions}</select>
                <button class="btn btn-ghost" onclick="bulk('move')">📦 Move</button>
                <button class="btn btn-ghost" onclick="bulk('merge')">🔗 Merge into first</button>
                <button class="btn btn-danger" onclick="bulk('delete')">🗑 Delete</button>
                <span style="margin-left:auto;color:var(--text-muted);font-size:0.8rem" id="modStatus"></span>
            </div>
            <div style="display:flex;gap:0.75rem;margin-bottom:1rem">
                <button class="btn btn-ghost" id="tabReports" onclick="showTab('reports')" style="font-weight:700">⚑ Reports (${reports.length})</button>
                <button class="btn btn-ghost" id="tabThreads" onclick="showTab('threads')">Threads</button>
                <button class="btn btn-ghost" id="tabReplies" onclick="showTab('replies')">Replies</button>
                <button class="btn btn-ghost" id="tabPending" onclick="showTab('pending')">⏳ Pending Posts (${pendingThreads.length + pendingReplies.length})</button>
            </div>
            <div id="sectionReports" class="thread-list">${reportRows}</div>
            <div id="sectionThreads" class="thread-list" style="display:none">${threadRows || '<div class="empty-state">No threads</div>'}</div>
            <div id="sectionReplies" class="thread-list" style="display:none">${replyRows || '<div class="empty-state">No replies</div>'}</div>
            <div id="sectionPending" class="thread-list" style="display:none">
                ${pendingThreads.length === 0 && pendingReplies.length === 0 ? '<div class="empty-state" style="padding:1.5rem">Nothing pending review</div>' : ''}
                ${pendingThreads.map(pt => `
                <div class="thread-card" style="padding:1rem;align-items:center;border-left:3px solid var(--warning)">
                    <div class="thread-content" style="flex:1">
                        <div style="font-size:0.95rem"><strong>Thread</strong> by <a href="/u/${pt.username}">@${escapeHtml(pt.display_name || pt.username)}</a> in ${escapeHtml(pt.category_name)}: <a href="/t/${pt.id}/${pt.slug}">${escapeHtml(pt.title)}</a></div>
                        <div style="color:var(--text-secondary);font-size:0.85rem">${escapeHtml((pt.content || '').substring(0, 140))}</div>
                        <div class="thread-meta"><span>${timeAgo(pt.created_at)}</span></div>
                    </div>
                    <div style="display:flex;gap:0.5rem;flex-shrink:0">
                        <button class="btn btn-ghost btn-sm" onclick="resolvePending('thread', ${pt.id}, 'approve')">✓ Approve</button>
                        <button class="btn btn-danger btn-sm" onclick="resolvePending('thread', ${pt.id}, 'delete')">🗑 Delete</button>
                    </div>
                </div>`).join('')}
                ${pendingReplies.map(pr => `
                <div class="thread-card" style="padding:1rem;align-items:center;border-left:3px solid var(--warning)">
                    <div class="thread-content" style="flex:1">
                        <div style="font-size:0.95rem"><strong>Reply</strong> by <a href="/u/${pr.username}">@${escapeHtml(pr.display_name || pr.username)}</a> in <a href="/t/${pr.thread_id}/${pr.thread_slug}">${escapeHtml(pr.thread_title)}</a>:</div>
                        <div style="color:var(--text-secondary);font-size:0.85rem">${escapeHtml((pr.content || '').substring(0, 140))}</div>
                        <div class="thread-meta"><span>${timeAgo(pr.created_at)}</span></div>
                    </div>
                    <div style="display:flex;gap:0.5rem;flex-shrink:0">
                        <button class="btn btn-ghost btn-sm" onclick="resolvePending('reply', ${pr.id}, 'approve')">✓ Approve</button>
                        <button class="btn btn-danger btn-sm" onclick="resolvePending('reply', ${pr.id}, 'delete')">🗑 Delete</button>
                    </div>
                </div>`).join('')}
            </div>
        </div>
        <script>
        function showTab(which) {
            document.getElementById('sectionThreads').style.display = which === 'threads' ? '' : 'none';
            document.getElementById('sectionReplies').style.display = which === 'replies' ? '' : 'none';
            document.getElementById('sectionReports').style.display = which === 'reports' ? '' : 'none';
            document.getElementById('sectionPending').style.display = which === 'pending' ? '' : 'none';
            document.getElementById('tabThreads').style.fontWeight = which === 'threads' ? '700' : '400';
            document.getElementById('tabReplies').style.fontWeight = which === 'replies' ? '700' : '400';
            document.getElementById('tabReports').style.fontWeight = which === 'reports' ? '700' : '400';
            document.getElementById('tabPending').style.fontWeight = which === 'pending' ? '700' : '400';
        }
        async function resolvePending(type, id, action) {
            try {
                const r = await fetch('/api/mod/pending/resolve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ type, id, action }) });
                const d = await r.json();
                if (d.success) location.reload(); else showToast(d.error || 'Action failed', 'error');
            } catch { showToast('Action failed', 'error'); }
        }
        async function handleReport(id, action) {
            if (action === 'delete' && !confirm('Delete the reported content? This cannot be undone.')) return;
            try {
                const r = await fetch('/api/mod/reports/' + id + '/resolve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ action }) });
                const d = await r.json();
                if (d.success) location.reload(); else showToast(d.error || 'Action failed', 'error');
            } catch { showToast('Action failed', 'error'); }
        }
        function selected(type) {
            return [...document.querySelectorAll('.mod-check:checked')].filter(c => c.dataset.type === type).map(c => c.value);
        }
        async function bulk(action) {
            const threads = selected('threads');
            const replies = selected('replies');
            if (action === 'delete' && !confirm('Permanently delete the selected items? This cannot be undone.')) return;
            const status = document.getElementById('modStatus');
            const jobs = [];
            if (threads.length) jobs.push({ type: 'threads', ids: threads, action, category_id: document.getElementById('moveCat').value });
            if (replies.length) jobs.push({ type: 'replies', ids: replies, action });
            if (!jobs.length) { status.textContent = 'Nothing selected'; return; }
            try {
                for (const job of jobs) {
                    const r = await fetch('/api/mod/bulk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(job) });
                    const d = await r.json();
                    if (!d.success) { status.textContent = d.error || 'Action failed'; return; }
                }
                status.textContent = 'Done — reloading…';
                location.reload();
            } catch { status.textContent = 'Action failed'; }
        }
        </script>`;

    res.header('Content-Type', 'text/html');
    res.send(page('Moderation', body, req.user));
} catch (error) {
    console.error('Moderation error:', error);
    res.status(500).send('Server Error');
}
});

// Banned words — admin management
app.post('/api/admin/words', requireRole(['admin']), async (req, res) => {
    try {
        const { word, action } = await req.json();
        const w = (word || '').toString().trim().toLowerCase();
        if (!w || w.length > 100) return res.status(400).json({ success: false, error: 'Word is required (max 100 chars)' });
        if (!['block', 'moderate'].includes(action)) return res.status(400).json({ success: false, error: 'Action must be block or moderate' });
        try {
            await query('INSERT INTO banned_words (word, action) VALUES (?, ?)', [w, action]);
        } catch (e) {
            if (e.message.includes('Duplicate')) return res.status(400).json({ success: false, error: 'That word is already listed' });
            throw e;
        }
        clearCache();
        res.json({ success: true, message: `Added "${w}" (${action})` });
    } catch (error) {
        console.error('Add word error:', error);
        res.status(500).json({ success: false, error: 'Failed to add word' });
    }
});

app.delete('/api/admin/words/:id', requireRole(['admin']), async (req, res) => {
    try {
        await query('DELETE FROM banned_words WHERE id = ?', [parseInt(req.params.id)]);
        clearCache();
        res.json({ success: true });
    } catch (error) {
        console.error('Delete word error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete word' });
    }
});

// Ban a user (admin only) — permanent or temporary
app.post('/api/admin/users/:id/ban', requireRole(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { days, reason } = await req.json();
        if (id === req.user.id) return res.status(400).json({ success: false, error: 'You cannot ban yourself' });
        const [target] = await query('SELECT id, username, role FROM users WHERE id = ?', [id]);
        if (!target) return res.status(404).json({ success: false, error: 'User not found' });
        if (target.role === 'admin') return res.status(403).json({ success: false, error: 'Admins cannot be banned' });

        let until = null;
        if (days !== undefined && days !== null && days !== '') {
            const n = parseInt(days);
            if (isNaN(n) || n < 1) return res.status(400).json({ success: false, error: 'Duration must be a positive number of days' });
            until = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
        }
        const cleanReason = (reason || '').toString().slice(0, 500) || null;
        await query('UPDATE users SET is_banned = TRUE, banned_until = ?, ban_reason = ? WHERE id = ?', [until, cleanReason, id]);
        res.json({ success: true, message: until ? `User banned until ${until.toISOString().slice(0, 10)}` : 'User banned permanently' });
    } catch (error) {
        console.error('Ban error:', error);
        res.status(500).json({ success: false, error: 'Ban failed' });
    }
});

// Unban a user (admin only)
app.post('/api/admin/users/:id/unban', requireRole(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [target] = await query('SELECT id FROM users WHERE id = ?', [id]);
        if (!target) return res.status(404).json({ success: false, error: 'User not found' });
        await query('UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL WHERE id = ?', [id]);
        res.json({ success: true, message: 'User unbanned' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Unban failed' });
    }
});

// Admin panel (basic)
app.get('/admin', requireRole(['admin']), async (req, res) => {
    const stats = await query(`SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM threads) as threads, (SELECT COUNT(*) FROM replies) as replies, (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) as newUsers, (SELECT COUNT(*) FROM threads WHERE DATE(created_at) = CURDATE()) as newThreads`);
    const recentUsers = await query('SELECT id, username, display_name, email, created_at, role, is_banned, banned_until, ban_reason FROM users ORDER BY created_at DESC LIMIT 10');
    const bannedUsers = await query(`SELECT u.id, u.username, u.display_name, u.email, u.banned_until, u.ban_reason, u.created_at, a.username as banned_by
        FROM users u LEFT JOIN users a ON a.id = u.id WHERE u.is_banned = TRUE ORDER BY u.banned_until IS NULL DESC, u.banned_until DESC`);

    const searchQ = (req.query.q || '').toString().trim().slice(0, 100);
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 20;
    const userWhere = searchQ ? 'WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ?' : '';
    const searchParams = searchQ ? [`%${searchQ}%`, `%${searchQ}%`, `%${searchQ}%`] : [];
    const [totalUsers] = await query(`SELECT COUNT(*) as c FROM users ${userWhere}`, searchParams);
    const userPages = Math.max(1, Math.ceil(totalUsers.c / perPage));
    const listedUsers = await query(`SELECT id, username, display_name, email, created_at, role, is_banned, banned_until, ban_reason FROM users ${userWhere} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...searchParams, perPage, (pageNum - 1) * perPage]);
    const bannedWords = await query('SELECT id, word, action FROM banned_words ORDER BY word');

    const banStatus = u => u.banned_until ? `temp (until ${new Date(u.banned_until).toISOString().slice(0, 10)})` : 'permanent';

    let paginationHtml = '';
    if (userPages > 1) {
        paginationHtml = '<div class="pagination">';
        if (pageNum > 1) paginationHtml += `<a href="/admin?q=${encodeURIComponent(searchQ)}&page=${pageNum - 1}">←</a>`;
        for (let i = 1; i <= userPages; i++) {
            if (i === pageNum) paginationHtml += `<span class="current">${i}</span>`;
            else if (i === 1 || i === userPages || Math.abs(i - pageNum) <= 2) paginationHtml += `<a href="/admin?q=${encodeURIComponent(searchQ)}&page=${i}">${i}</a>`;
            else if (Math.abs(i - pageNum) === 3) paginationHtml += '<span class="ellipsis">…</span>';
        }
        if (pageNum < userPages) paginationHtml += `<a href="/admin?q=${encodeURIComponent(searchQ)}&page=${pageNum + 1}">→</a>`;
        paginationHtml += '</div>';
    }

    const body = `
    <div class="container" style="padding-top:2rem">
        <h1 style="font-size:2rem;font-weight:800;margin-bottom:1.5rem">Admin Dashboard</h1>
        <div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-bottom:2rem">
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--accent)">${stats[0].users}</div><div style="color:var(--text-muted);font-size:0.875rem">Total Users</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--info)">${stats[0].threads}</div><div style="color:var(--text-muted);font-size:0.875rem">Threads</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--success)">${stats[0].replies}</div><div style="color:var(--text-muted);font-size:0.875rem">Replies</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--warning)">${stats[0].newUsers}</div><div style="color:var(--text-muted);font-size:0.875rem">New Today</div></div>
        </div>
        <h2 style="margin-bottom:1rem">Banned Users</h2>
        <div class="thread-list" style="margin-bottom:2rem">
            ${bannedUsers.length === 0 ? '<div class="empty-state" style="padding:1.5rem">No banned users</div>' : bannedUsers.map(u => `
                <div class="thread-card" style="padding:1rem;align-items:center">
                    <div class="thread-content" style="flex:1">
                        <h4>${escapeHtml(u.display_name || u.username)} <span style="color:var(--text-muted);font-size:0.8rem;font-weight:400">@${u.username} • ${u.email}</span></h4>
                        <div class="thread-meta"><span style="color:var(--danger);font-weight:600">${banStatus(u)}</span>${u.ban_reason ? `<span>— ${escapeHtml(u.ban_reason)}</span>` : ''}</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" onclick="unbanUser(${u.id})">Unban</button>
                </div>`).join('')}
        </div>
        <h2 style="margin-bottom:1rem">User Management <span style="font-size:0.85rem;font-weight:400;color:var(--text-muted)">${totalUsers.c} user${totalUsers.c === 1 ? '' : 's'}${searchQ ? ` found for "${escapeHtml(searchQ)}"` : ''}</span></h2>
        <form method="GET" action="/admin" style="display:flex;gap:0.5rem;margin-bottom:1rem">
            <input class="form-input" type="text" name="q" value="${escapeHtml(searchQ)}" placeholder="Search by username, display name, or email…" style="max-width:360px">
            <button type="submit" class="btn btn-primary btn-sm">Search</button>
            ${searchQ ? `<a href="/admin" class="btn btn-ghost btn-sm" style="align-self:center">Clear</a>` : ''}
        </form>
        <div class="thread-list" style="margin-bottom:2rem">
            ${listedUsers.length === 0 ? '<div class="empty-state" style="padding:1.5rem">No users match that search</div>' : listedUsers.map(u => `
                <div class="thread-card" style="padding:1rem;align-items:center">
                    <div class="thread-content" style="flex:1">
                        <h4>${escapeHtml(u.display_name || u.username)} <span style="color:var(--text-muted);font-size:0.8rem;font-weight:400">@${u.username} • ${u.email}${u.role !== 'user' ? ` • ${u.role}` : ''}${u.is_banned ? ` • <span style=\"color:var(--danger)\">banned: ${banStatus(u)}</span>` : ''}</span></h4>
                        <div class="thread-meta"><span>${timeAgo(u.created_at)}</span></div>
                    </div>
                    ${u.role !== 'admin' && u.id !== req.user.id ? `
                    <div style="display:flex;gap:0.5rem;flex-shrink:0">
                        <button class="btn btn-ghost btn-sm" onclick="banUser(${u.id}, ${u.is_banned ? 1 : 0})">${u.is_banned ? 'Modify Ban' : 'Ban'}</button>
                        ${u.is_banned ? `<button class=\"btn btn-ghost btn-sm\" onclick=\"unbanUser(${u.id})\">Unban</button>` : ''}
                    </div>` : ''}
                </div>
            `).join('')}
        </div>
        ${paginationHtml}
    </div>
    <div class="card" style="margin-top:2rem;padding:1.5rem">
        <h2 style="font-size:1.25rem;font-weight:700;margin-bottom:0.5rem">Banned Words Filter</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;margin-bottom:1rem">Words marked <strong>Block</strong> are rejected outright when users post. Words marked <strong>Moderate</strong> allow the post through but place it in the moderation queue until a moderator approves it. Matching is case-insensitive and matches whole words.</p>
        <form id="wordForm" onsubmit="event.preventDefault(); addWord()" style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">
            <input id="wordInput" class="form-input" placeholder="Word or phrase" required style="width:220px">
            <select id="wordAction" class="form-input" style="width:auto">
                <option value="block">Block</option>
                <option value="moderate">Send to moderation</option>
            </select>
            <button class="btn btn-ghost" type="submit">Add Word</button>
        </form>
        ${bannedWords.length === 0 ? '<div class="empty-state" style="padding:1rem">No words configured</div>' : `<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
            ${bannedWords.map(w => `<span style="display:inline-flex;align-items:center;gap:0.4rem;padding:0.3rem 0.75rem;border:1px solid var(--border);border-radius:999px;font-size:0.85rem;background:var(--bg-secondary)">
                <code>${escapeHtml(w.word)}</code>
                <span style="font-size:0.7rem;font-weight:700;padding:0.1rem 0.45rem;border-radius:999px;color:white;background:${w.action === 'block' ? 'var(--danger)' : 'var(--warning)'}">${w.action === 'block' ? 'BLOCK' : 'MODERATE'}</span>
                <button onclick="deleteWord(${w.id})" title="Remove" style="cursor:pointer;border:none;background:none;color:var(--text-muted);font-weight:700">×</button>
            </span>`).join('')}
        </div>`}
    </div>
    <script>
    async function addWord() {
        const word = document.getElementById('wordInput').value;
        const action = document.getElementById('wordAction').value;
        try {
            const r = await fetch('/api/admin/words', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ word, action }) });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Failed to add word', 'error');
        } catch { showToast('Failed to add word', 'error'); }
    }
    async function deleteWord(id) {
        try {
            const r = await fetch('/api/admin/words/' + id, { method: 'DELETE' });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Failed to delete word', 'error');
        } catch { showToast('Failed to delete word', 'error'); }
    }
    async function banUser(id) {
        const daysStr = prompt('Ban duration in days (leave empty for PERMANENT ban):', '7');
        if (daysStr === null) return;
        const reason = prompt('Reason (optional):') || '';
        const payload = { reason };
        if (daysStr.trim() !== '') payload.days = parseInt(daysStr);
        try {
            const r = await fetch('/api/admin/users/' + id + '/ban', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Ban failed', 'error');
        } catch { showToast('Ban failed', 'error'); }
    }
    async function unbanUser(id) {
        try {
            const r = await fetch('/api/admin/users/' + id + '/unban', { method: 'POST' });
            const d = await r.json();
            if (d.success) location.reload(); else showToast(d.error || 'Unban failed', 'error');
        } catch { showToast('Unban failed', 'error'); }
    }
    </script>`;
    res.header('Content-Type', 'text/html');
    res.send(page('Admin', body, req.user));
});

// Error fallback
app.set_error_handler((req, res, error) => {
    console.error('Server error:', error);
    res.status(500).send('Internal Server Error');
});

app.set_not_found_handler((req, res) => {
    res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state" style="padding:6rem 2rem"><div class="icon">🌑</div><h1>Page Not Found</h1><p>The page you are looking for does not exist.</p><a href="/" class="btn btn-primary">Go Home</a></div></div>', req.user));
});

// Initialize database and seed
async function initDatabase() {
    try {
        const setupSql = fs.readFileSync(path.join(__dirname, 'setup.sql'), 'utf-8');
        const statements = setupSql.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            if (!stmt.trim()) continue;
            try {
                await pool.execute(stmt);
            } catch (e) {
                // Ignore duplicate errors for inserts
                if (!e.message.includes('Duplicate')) console.error('DB init warning:', e.message);
            }
        }
        // Runtime migrations
        try {
            await pool.execute('ALTER TABLE users ADD COLUMN banned_until DATETIME DEFAULT NULL, ADD COLUMN ban_reason VARCHAR(500) DEFAULT NULL');
        } catch (e) { /* column(s) already exist */ }
        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS reports (
                id INT AUTO_INCREMENT PRIMARY KEY,
                reporter_id INT NOT NULL,
                target_type ENUM('thread','reply') NOT NULL,
                target_id INT NOT NULL,
                reason VARCHAR(500) DEFAULT NULL,
                status ENUM('pending','resolved','dismissed') DEFAULT 'pending',
                resolved_by INT DEFAULT NULL,
                resolved_at DATETIME DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_reporter (reporter_id),
                INDEX idx_target (target_type, target_id),
                INDEX idx_status (status),
                FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        } catch (e) { console.error('Reports table warning:', e.message); }
        try {
            await pool.execute(`ALTER TABLE threads ADD COLUMN moderation_status ENUM('visible','pending') NOT NULL DEFAULT 'visible'`);
        } catch (e) { /* exists */ }
        try {
            await pool.execute(`ALTER TABLE replies ADD COLUMN moderation_status ENUM('visible','pending') NOT NULL DEFAULT 'visible'`);
        } catch (e) { /* exists */ }
        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS banned_words (
                id INT AUTO_INCREMENT PRIMARY KEY,
                word VARCHAR(100) NOT NULL,
                action ENUM('block','moderate') NOT NULL DEFAULT 'block',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_word (word)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        } catch (e) { console.error('banned_words table warning:', e.message); }
        console.log('✅ Database initialized');

        // Seed sample data if empty
        const [userCount] = await query('SELECT COUNT(*) as c FROM users');
        if (userCount.c === 0) {
            const bcrypt = require('bcryptjs');
            const hash = await bcrypt.hash('password123', 12);
            const adminHash = await bcrypt.hash('admin123', 12);

            await query('INSERT INTO users (username, email, password_hash, display_name, role, avatar) VALUES (?, ?, ?, ?, ?, ?)',
                ['admin', 'admin@nexus.local', adminHash, 'Administrator', 'admin', generateAvatar('admin')]);
            await query('INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
                ['alice', 'alice@example.com', hash, 'Alice Chen', generateAvatar('alice')]);
            await query('INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
                ['bob', 'bob@example.com', hash, 'Bob Williams', generateAvatar('bob')]);
            await query('INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
                ['carol', 'carol@example.com', hash, 'Carol Smith', generateAvatar('carol')]);
            await query('INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
                ['dave', 'dave@example.com', hash, 'Dave Johnson', generateAvatar('dave')]);
            await query('INSERT INTO users (username, email, password_hash, display_name, avatar) VALUES (?, ?, ?, ?, ?)',
                ['eve', 'eve@example.com', hash, 'Eve Martinez', generateAvatar('eve')]);

            const sampleThreads = [
                { cat: 2, title: 'What is the future of WebAssembly in 2025?', content: 'WebAssembly has been evolving rapidly. I think we\'ll see it becoming a first-class citizen in edge computing and serverless architectures. What do you think about the current trajectory of WASM?', tags: [2,5] },
                { cat: 2, title: 'Building a real-time collaborative editor with CRDTs', content: 'I\'ve been diving deep into Conflict-free Replicated Data Types for a side project. The learning curve is steep but the results are amazing. Here\'s what I\'ve learned so far about Yjs and Automerge...', tags: [2,4] },
                { cat: 1, title: 'What\'s everyone working on this weekend?', content: 'Happy Friday! Share your weekend projects, hobbies, or just what you\'re excited about. I\'m finally getting around to organizing my home lab setup.', tags: [7] },
                { cat: 3, title: 'Showcase: My latest generative art series', content: 'I\'ve been experimenting with flow fields and particle systems. Here\'s a collection of 12 pieces I created over the past month using p5.js and custom shader code.', tags: [4] },
                { cat: 4, title: 'Baldur\'s Gate 3: Best party composition for tactician mode?', content: 'I\'m about to start my second playthrough on Tactician difficulty. What party builds have worked best for you? I\'m thinking of trying a full melee composition.', tags: [5] },
                { cat: 5, title: 'JWST discovers organic molecules in distant galaxy', content: 'Incredible new findings from the James Webb Space Telescope. The detection of complex organic molecules at these distances changes our understanding of chemical evolution in the early universe.', tags: [6] },
                { cat: 2, title: 'Rust vs Go for high-performance APIs', content: 'After building APIs in both languages for production systems, here\'s my honest comparison. Each has strengths depending on your team size, performance requirements, and ecosystem needs.', tags: [2,5] },
                { cat: 6, title: 'Morning routine that actually changed my life', content: 'I used to wake up and immediately check my phone. Now I have a structured 45-minute morning routine and my productivity has skyrocketed. Here\'s the breakdown...', tags: [7] },
                { cat: 7, title: 'How to use the new markdown editor', content: 'The forum now supports full markdown formatting including code blocks, tables, and images. This guide covers everything you need to know to format your posts beautifully.', tags: [2] }
            ];

            for (const st of sampleThreads) {
                const result = await query('INSERT INTO threads (category_id, user_id, title, slug, content) VALUES (?, ?, ?, ?, ?)',
                    [st.cat, Math.floor(Math.random() * 5) + 2, st.title, slugify(st.title), st.content]);
                for (const tagId of st.tags) {
                    await query('INSERT IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)', [result.insertId, tagId]);
                    await query('UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?', [tagId]);
                }
                await query('UPDATE categories SET thread_count = thread_count + 1 WHERE id = ?', [st.cat]);
                await query('UPDATE users SET post_count = post_count + 1 WHERE id = ?', [Math.floor(Math.random() * 5) + 2]);
            }

            // Add some replies
            const sampleReplies = [
                { thread: 1, content: 'Great question! I think WASM will be huge for portable serverless functions.' },
                { thread: 1, content: 'Agreed. The component model is what I\'m most excited about.' },
                { thread: 2, content: 'Yjs is fantastic but have you tried Loro? It has much better performance characteristics.' },
                { thread: 3, content: 'Working on my garden! Finally planting those tomatoes.' },
                { thread: 4, content: 'These are absolutely stunning. The color palettes you chose are incredible.' },
                { thread: 5, content: 'Cleric/Paladin/Wizard/Rogue is the classic power combo for tactician.' },
                { thread: 6, content: 'This is groundbreaking. The implications for astrobiology are enormous.' },
                { thread: 7, content: 'I prefer Rust for CPU-bound work, Go for I/O bound APIs.' }
            ];

            for (const r of sampleReplies) {
                const userId = Math.floor(Math.random() * 5) + 2;
                await query('INSERT INTO replies (thread_id, user_id, content) VALUES (?, ?, ?)', [r.thread, userId, r.content]);
                await query('UPDATE threads SET reply_count = reply_count + 1, last_post_at = NOW(), last_post_user_id = ? WHERE id = ?', [userId, r.thread]);
                await query('UPDATE categories SET post_count = post_count + 1 WHERE id = (SELECT category_id FROM threads WHERE id = ?)', [r.thread]);
                await query('UPDATE users SET post_count = post_count + 1 WHERE id = ?', [userId]);
            }

            console.log('✅ Sample data seeded');
        }
    } catch (error) {
        console.error('Database init error:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await pool.end();
    process.exit(0);
});

// Start
initDatabase().then(() => {
    app.listen(PORT).then(() => {
        console.log(`🚀 Nexus forum running at http://localhost:${PORT}`);
    }).catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
});
