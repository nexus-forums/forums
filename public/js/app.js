// === Modern Forum Client ===
(function() {
    'use strict';

    // CSRF: attach double-submit token header to all mutating API requests
    const origFetch = window.fetch;
    window.fetch = function(input, init = {}) {
        const method = ((init && init.method) || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            const m = document.cookie.match(/(?:^|; )csrf=([^;]*)/);
            if (m) {
                init.headers = new Headers(init.headers || {});
                if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', m[1]);
            }
        }
        return origFetch.call(this, input, init);
    };

    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const html = document.documentElement;
            const isDark = html.classList.contains('dark');
            html.classList.toggle('dark', !isDark);
            html.classList.toggle('light', isDark);
            localStorage.setItem('theme', isDark ? 'light' : 'dark');
        });
        // Restore theme
        const saved = localStorage.getItem('theme');
        if (saved === 'light') {
            document.documentElement.classList.remove('dark');
            document.documentElement.classList.add('light');
        }
    }

    // Logout
    const logoutLink = document.getElementById('logoutLink');
    if (logoutLink) {
        logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            window.location.href = '/';
        });
    }

    // Global avatar fallback: if an avatar image fails to load, swap in the
    // deterministic SVG avatar derived from the img's alt text (username).
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (img.tagName !== 'IMG' || img.dataset.fallbackApplied) return;
        img.dataset.fallbackApplied = '1';
        const name = img.getAttribute('alt') || 'user';
        // generateAvatar is injected server-side on pages that use it
        if (typeof window.generateAvatar === 'function') {
            img.src = window.generateAvatar(name);
        } else {
            img.src = 'data:image/svg+xml;base64,' + btoa(
                `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6366f1"/><text x="48" y="60" font-size="40" fill="white" text-anchor="middle" font-family="sans-serif">${name[0].toUpperCase()}</text></svg>`
            );
        }
    }, true);

    // Toast notification system
    window.showToast = function(message, type = 'info') {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    };

    // Global search
    const searchInput = document.getElementById('globalSearch');
    const searchDropdown = document.getElementById('searchResults');
    let searchTimeout;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const q = searchInput.value.trim();
            if (q.length < 2) { searchDropdown?.classList.remove('active'); return; }
            searchTimeout = setTimeout(async () => {
                try {
                    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
                    const data = await res.json();
                    if (!data.success || !searchDropdown) return;
                    let html = '';
                    const { threads, users, categories } = data.results;
                    if (categories.length) html += '<div style="padding:0.5rem 1rem;font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Categories</div>' + categories.map(c => `<a href="/c/${c.slug}" class="search-item"><strong>${escapeHtml(c.name)}</strong></a>`).join('');
                    if (threads.length) html += '<div style="padding:0.5rem 1rem;font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Threads</div>' + threads.map(t => `<a href="/t/${t.id}/${t.slug}" class="search-item">${escapeHtml(t.title)}</a>`).join('');
                    if (users.length) html += '<div style="padding:0.5rem 1rem;font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Users</div>' + users.map(u => `<a href="/u/${u.username}" class="search-item"><strong>${escapeHtml(u.display_name || u.username)}</strong> <span style="color:var(--text-muted)">@${u.username}</span></a>`).join('');
                    if (!html) html = '<div class="search-item">No results found</div>';
                    searchDropdown.innerHTML = html;
                    searchDropdown.classList.add('active');
                } catch (e) { console.error(e); }
            }, 200);
        });
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchDropdown?.contains(e.target)) {
                searchDropdown?.classList.remove('active');
            }
        });
    }

    // Like handler helper
    window.handleLike = async function(type, id, btn) {
        if (!document.body.dataset.user) { showToast('Please sign in to like', 'info'); return; }
        try {
            const res = await fetch('/api/reactions', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_type: type, target_id: id })
            });
            const data = await res.json();
            if (!data.success) return;
            const countSpan = btn.querySelector('span');
            const current = parseInt((countSpan?.textContent || btn.textContent).replace(/[^0-9]/g, '')) || 0;
            const next = Math.max(0, data.liked ? current + 1 : current - 1);
            if (countSpan) countSpan.textContent = next;
            if (btn.firstChild) btn.firstChild.textContent = data.liked ? '❤️ ' : '🤍 ';
            btn.classList.toggle('liked', data.liked);
        } catch (e) { showToast('Failed to like', 'error'); }
    };

    // Escape HTML helper
    function escapeHtml(str) {
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Handle dynamic thread loading (SPA-like infinite scroll on thread list)
    const threadContainer = document.getElementById('threadList');
    if (threadContainer && threadContainer.dataset.infinite === 'true') {
        let page = 2;
        let loading = false;
        let finished = false;
        const category = threadContainer.dataset.category || '';
        window.addEventListener('scroll', async () => {
            if (loading || finished) return;
            if (window.innerHeight + window.scrollY < document.body.offsetHeight - 800) return;
            loading = true;
            try {
                const res = await fetch(`/api/threads?page=${page}&category=${category}`);
                const data = await res.json();
                if (!data.success || !data.threads.length) { finished = true; return; }
                // Append rendered thread cards... simplified - would need template rendering
            } catch (e) {}
            loading = false;
            page++;
        });
    }

    // Reply form toggle
    window.toggleReplyForm = function(id) {
        const el = document.getElementById('replyForm_' + id);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    };

    // Quote a reply into the reply composer (used by the ❝ button on thread pages)
    window.quotePost = async function(id, btn) {
        try {
            const r = await fetch('/api/replies/' + id + '/raw');
            const d = await r.json();
            if (!d.success || !d.content) return showToast('Cannot quote post', 'error');
            const author = (btn && btn.dataset.author) || 'someone';
            const nl = String.fromCharCode(10);
            const quoted = d.content.split(nl).map(line => '> ' + line).join(nl);
            const block = '**@' + author + ' wrote:**' + nl + nl + quoted + nl + nl;
            const ta = document.getElementById('replyContent');
            if (!ta) return showToast('Reply box not found', 'error');
            const existing = ta.value;
            ta.value = existing ? existing.trimEnd() + nl + nl + block : block;
            ta.focus();
            ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch { showToast('Cannot quote post', 'error'); }
    };

    // Editor toolbar
    document.querySelectorAll('.editor-toolbar').forEach(toolbar => {
        const textarea = toolbar.nextElementSibling;
        if (!textarea) return;
        toolbar.querySelectorAll('button[data-action]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const selected = textarea.value.substring(start, end);
                let replacement = selected;
                switch (action) {
                    case 'bold': replacement = `**${selected || 'bold text'}**`; break;
                    case 'italic': replacement = `*${selected || 'italic text'}*`; break;
                    case 'link': replacement = `[${selected || 'link text'}](url)`; break;
                    case 'image': replacement = `![${selected || 'image alt'}](https://example.com/image.jpg)`; break;
                    case 'code': replacement = `\`\`\`\n${selected || 'code'}\n\`\`\``; break;
                    case 'quote': replacement = `> ${selected || 'quote'}`; break;
                }
                textarea.setRangeText(replacement, start, end, 'select');
                textarea.focus();
            });
        });
    });

    // Fetch notifications count
    async function refreshNotifications() {
        const badge = document.getElementById('notifBadge');
        if (!badge) return;
        try {
            const res = await fetch('/api/notifications');
            if (!res.ok) return;
            const data = await res.json();
            if (data.success && data.unread > 0) {
                badge.textContent = data.unread;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        } catch(e) {}
    }
    if (document.body.dataset.user) { refreshNotifications(); setInterval(refreshNotifications, 30000); }

})();
