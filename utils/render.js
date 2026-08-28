const { escapeHtml, generateAvatar } = require('./helpers');

function page(title, body, user = null, extraHead = '') {
    const isAdmin = user?.role === 'admin';
    const isMod = user?.role === 'moderator' || isAdmin;

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} - Nexus</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/style.css">
    ${extraHead}
</head>
<body${user ? ` data-user="${user.id}" data-username="${escapeHtml(user.username)}"` : ''}>
    <div id="app">
        <nav class="navbar">
            <div class="nav-brand">
                <a href="/" class="logo">
                    <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="16 2 30 9 30 23 16 30 2 23 2 9"></polygon>
                        <line x1="16" y1="2" x2="16" y2="30"></line>
                        <line x1="2" y1="9" x2="30" y2="9"></line>
                        <line x1="2" y1="23" x2="30" y2="23"></line>
                    </svg>
                    <span class="logo-text">Nexus</span>
                </a>
            </div>
            <div class="nav-search">
                <input type="text" id="globalSearch" placeholder="Search discussions, users, topics..." autocomplete="off">
                <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <div id="searchResults" class="search-dropdown"></div>
            </div>
            <div class="nav-actions">
                <button class="theme-toggle" id="themeToggle" title="Toggle theme">
                    <span class="moon">&#9790;</span>
                    <span class="sun">&#9788;</span>
                </button>
                ${user ? `
                <a href="/notifications" class="nav-icon" title="Notifications">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                    <span class="badge" id="notifBadge" style="display:none"></span>
                </a>
                <a href="/messages" class="nav-icon" title="Messages">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
                </a>
                <div class="user-menu">
                    <a href="/u/${user.username}" class="user-avatar">
                        <img src="${user.avatar || generateAvatar(user.username)}" alt="${user.username}" width="32" height="32">
                        <span class="user-name">${escapeHtml(user.display_name || user.username)}</span>
                        <span class="user-rep">${user.reputation || 0}</span>
                    </a>
                    <div class="dropdown">
                        <a href="/u/${user.username}">Profile</a>
                        <a href="/settings">Settings</a>
                        ${isMod ? '<a href="/moderate">Moderation</a>' : ''}
                        ${isAdmin ? '<a href="/admin">Admin Panel</a>' : ''}
                        <hr>
                        <a href="#" id="logoutLink">Sign Out</a>
                    </div>
                </div>
                ` : `
                <a href="/login" class="btn btn-ghost">Sign In</a>
                <a href="/register" class="btn btn-primary">Join</a>
                `}
            </div>
        </nav>
        <main class="main-content">
            ${body}
        </main>
        <footer class="site-footer">
            <div class="footer-content">
                <div class="footer-brand">
                    <span class="logo-text">Nexus</span>
                    <p>A modern community platform built with Hyper Express</p>
                </div>
                <div class="footer-links">
                    <a href="/about">About</a>
                    <a href="/guidelines">Guidelines</a>
                    <a href="/privacy">Privacy</a>
                    <a href="/api">API</a>
                </div>
            </div>
        </footer>
    </div>
    <script src="/js/app.js"></script>
</body>
</html>`;
}

function alertBox(type, message) {
    const colors = {
        success: '#10b981',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };
    return `<div class="alert alert-${type}" style="border-left: 3px solid ${colors[type] || colors.info}">${message}</div>`;
}

module.exports = { page, alertBox };
