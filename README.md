# Nexus — Modern Forum

A modern, radically-redesigned forum built with **Hyper-Express** (uWebSockets) and **MySQL**.

No boring tables — the homepage features a gradient hero, category cards with live "latest thread" previews, trending threads, and a community sidebar. Dark theme by default with a light-mode toggle.

## Run

```bash
npm install
mysql -u root -p < setup.sql   # creates modern_forum database
node seed.js                   # optional: demo users/threads/replies
npm start                      # http://localhost:3000
```

Demo accounts (via seed): any username from `seed.js` with password `password123`.

## Stack
- Hyper-Express 7 (uWebSockets.js v20.52.0 — pinned for glibc 2.36 compatibility)
- MySQL (mysql2 pool), JWT auth in httpOnly cookies, bcryptjs
- Server-rendered HTML with marked + sanitize-html for Markdown posts

## Patches applied to node_modules (do not `npm ci` away)
`hyper-express` v7 expects uWS ≥ 20.53 APIs. With uWS pinned to 20.52 we shimmed:
- `Request.js`: `onDataV2` fallback to legacy `onData`, `getRemotePort`/`getProxiedRemotePort` guards
- `Response.js`: `beginWrite` guard, `getRemotePort` guard
- `Websocket.js`: `getRemotePort` guard

If the host has glibc ≥ 2.38, you can unpin uWS (`github:uNetworking/uWebSockets.js#v20.69.0`) and drop the shims.

## Notable routes
- `/` homepage (hero + card grid + sidebar)
- `/c/:slug` category, `/t/:id/:slug` thread, `/u/:username` profile
- `/api/auth/*`, `/api/threads`, `/api/search`, `/api/leaderboard`
