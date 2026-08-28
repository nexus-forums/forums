// === Modern Forum Client ===
(function() {
    'use strict';

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
            btn.classList.toggle('liked', data.liked);
            const countSpan = btn.querySelector('span') || btn;
            const current = parseInt(countSpan.textContent.replace(/[^0-9]/g, ''));
            countSpan.innerHTML = data.liked ? '❤️ ' + (current + 1) : '🤍 ' + Math.max(0, current - 1);
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
