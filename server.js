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
                ORDER BY t.views DESC LIMIT 4`),
            query(`SELECT t.*, c.name as category_name, c.slug as category_slug, c.color as category_color,
                u.username, u.display_name, u.avatar
                FROM threads t JOIN categories c ON t.category_id = c.id JOIN users u ON t.user_id = u.id
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
                WHERE t.category_id = ? ORDER BY t.is_pinned DESC, t.last_post_at DESC LIMIT ? OFFSET ?`,
                [category.id, limit, offset]),
            query('SELECT COUNT(*) as total FROM threads WHERE category_id = ?', [category.id])
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

        if (!thread) return res.status(404).send(page('Not Found', '<div class="container"><div class="empty-state"><h3>Thread not found</h3></div></div>', req.user));

        const pageNum = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 15;
        const offset = (pageNum - 1) * limit;

        const replies = await query(`
            SELECT r.*, u.username, u.display_name, u.avatar, u.role, u.reputation, u.post_count, u.created_at as user_created,
                (SELECT COUNT(*) FROM reactions WHERE target_type = 'reply' AND target_id = r.id) as likes
            FROM replies r JOIN users u ON r.user_id = u.id
            WHERE r.thread_id = ? AND r.parent_id IS NULL ORDER BY r.is_solution DESC, r.created_at ASC LIMIT ? OFFSET ?`,
            [threadId, limit, offset]);

        const [replyCount] = await query('SELECT COUNT(*) as total FROM replies WHERE thread_id = ? AND parent_id IS NULL', [threadId]);
        const totalReplies = replyCount.total;
        const pages = Math.ceil(totalReplies / limit);

        const renderPost = (p, isThread = false) => {
            const roleBadge = p.role !== 'user' ? `<span class="author-role ${p.role}">${p.role}</span>` : '';
            const isAuthor = req.user && req.user.id === (isThread ? thread.user_id : p.user_id);
            const isMod = req.user && ['moderator', 'admin'].includes(req.user.role);
            const solutionBadge = p.is_solution ? '<span style="background:var(--success);color:white;padding:0.15rem 0.5rem;border-radius:var(--radius-sm);font-size:0.7rem;font-weight:700;margin-left:0.5rem">✓ Solution</span>' : '';
            const modActions = isMod ? `
                <button onclick="fetch('/api/threads/${thread.id}/lock',{method:'PATCH'}).then(()=>location.reload())" title="${thread.is_locked ? 'Unlock' : 'Lock'}">🔒</button>
                <button onclick="fetch('/api/threads/${thread.id}/pin',{method:'PATCH'}).then(()=>location.reload())" title="${thread.is_pinned ? 'Unpin' : 'Pin'}">📌</button>
            ` : '';
            const editActions = isAuthor ? `<button onclick="alert('Edit coming soon')">✏️</button>` : '';
            return `
            <div class="post ${isThread ? 'thread-post' : ''}">
                <div class="post-author">
                    <img src="${p.avatar || generateAvatar(p.username || p.display_name)}" alt="${p.username}" class="author-avatar" width="64" height="64">
                    <a href="/u/${p.username}" class="author-name">${escapeHtml(p.display_name || p.username)}</a>
                    ${roleBadge}
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
                            ${solutionBadge}
                            ${isThread && thread.is_locked ? '<span style="background:var(--danger);color:white;padding:0.15rem 0.5rem;border-radius:var(--radius-sm);font-size:0.7rem;font-weight:700">🔒 Locked</span>' : ''}
                        </div>
                        <div class="post-actions">
                            <button onclick="handleLike('${isThread ? 'thread' : 'reply'}', ${p.id}, this)">🤍 <span>${p.likes || 0}</span></button>
                            ${!isThread && (req.user?.id === thread.user_id || isMod) ? `<button onclick="fetch('/api/replies/${p.id}/solution',{method:'PATCH'}).then(()=>location.reload())" title="Mark as solution">✓</button>` : ''}
                            ${editActions}
                            ${modActions}
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
            </div>
            <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:1.5rem">
                ${posts}
            </div>
            ${pagination}
            ${replyForm}
        </div>
        <script>
        async function submitReply(threadId) {
            const content = document.getElementById('replyContent').value;
            if (!content.trim()) return showToast('Reply cannot be empty', 'error');
            try {
                const res = await fetch('/api/threads/' + threadId + '/replies', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                const data = await res.json();
                if (data.success) { location.reload(); }
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
            if (data.success) { window.location = '/t/' + data.thread.id + '/' + data.thread.slug; }
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
             WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 5`, [user.id]);

        const recentReplies = await query(
            `SELECT r.id, r.content, r.created_at, t.id as thread_id, t.title as thread_title, t.slug as thread_slug
             FROM replies r JOIN threads t ON r.thread_id = t.id
             WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 5`, [user.id]);

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
                <button class="tab active">Discussions</button>
                <button class="tab">Replies</button>
            </div>
            <div style="display:flex;flex-direction:column;gap:0.75rem">
                ${threadList || '<div class="empty-state"><p>No discussions yet.</p></div>'}
            </div>
            <h2 style="margin-top:2rem;margin-bottom:1rem;font-size:1.25rem;font-weight:700">Recent Replies</h2>
            <div style="display:flex;flex-direction:column;gap:0.75rem">
                ${replyList || '<div class="empty-state"><p>No replies yet.</p></div>'}
            </div>
        </div>`;

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
                ORDER BY t.last_post_at DESC LIMIT ? OFFSET ?`, [limit, offset]),
            query('SELECT COUNT(*) as total FROM threads')
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

// Admin panel (basic)
app.get('/admin', requireRole(['admin']), async (req, res) => {
    const stats = await query(`SELECT (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM threads) as threads, (SELECT COUNT(*) FROM replies) as replies, (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURDATE()) as newUsers, (SELECT COUNT(*) FROM threads WHERE DATE(created_at) = CURDATE()) as newThreads`);
    const recentUsers = await query('SELECT id, username, display_name, email, created_at FROM users ORDER BY created_at DESC LIMIT 10');

    const body = `
    <div class="container" style="padding-top:2rem">
        <h1 style="font-size:2rem;font-weight:800;margin-bottom:1.5rem">Admin Dashboard</h1>
        <div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin-bottom:2rem">
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--accent)">${stats[0].users}</div><div style="color:var(--text-muted);font-size:0.875rem">Total Users</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--info)">${stats[0].threads}</div><div style="color:var(--text-muted);font-size:0.875rem">Threads</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--success)">${stats[0].replies}</div><div style="color:var(--text-muted);font-size:0.875rem">Replies</div></div>
            <div class="card" style="text-align:center"><div style="font-size:2.5rem;font-weight:800;color:var(--warning)">${stats[0].newUsers}</div><div style="color:var(--text-muted);font-size:0.875rem">New Today</div></div>
        </div>
        <h2 style="margin-bottom:1rem">Recent Users</h2>
        <div class="thread-list">
            ${recentUsers.map(u => `
                <div class="thread-card" style="padding:1rem">
                    <div class="thread-content">
                        <h4>${escapeHtml(u.display_name || u.username)} <span style="color:var(--text-muted);font-size:0.8rem;font-weight:400">@${u.username} • ${u.email}</span></h4>
                        <div class="thread-meta"><span>${timeAgo(u.created_at)}</span></div>
                    </div>
                </div>
            `).join('')}
        </div>
    </div>`;
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
