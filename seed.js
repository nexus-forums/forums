// Seed demo data for the modern forum
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./config/db');

const users = [
    ['nova', 'nova@forum.dev', 'Nova Sterling', 'Full-stack dev by day, pixel artist by night. Building weird things on the web since dial-up.'],
    ['kai', 'kai@forum.dev', 'Kai Moreno', 'Security researcher. I break things so you do not have to. Coffee-powered.'],
    ['lumen', 'lumen@forum.dev', 'Lumen Wei', 'Product designer obsessed with typography and motion. Figma is my second home.'],
    ['dr_orbit', 'orbit@forum.dev', 'Dr. Orbit', 'Astrophysicist. I explain black holes to strangers at parties.'],
    ['pixelheart', 'pixel@forum.dev', 'PixelHeart', 'Indie game dev. Shipped 3 games, abandoned 30. Ask me about game jams!'],
    ['saashq', 'saa@forum.dev', 'Saa\'shq', 'Distributed systems nerd. Kubernetes whisperer. I dream in YAML.'],
    ['fern', 'fern@forum.dev', 'Fern Holloway', 'Urban gardener, sourdough baker, chronic hobby-collector.'],
    ['vector', 'vector@forum.dev', 'Vector', 'Competitive programmer. ELO 2400. Currently learning Rust and regretting nothing.'],
    ['mochi', 'mochi@forum.dev', 'Mochi Tanaka', 'Cat photos, lo-fi playlists, and ocassional frontend opinions.'],
    ['atlas', 'atlas@forum.dev', 'Atlas Kaine', 'Tech journalist covering the AI beat. Skeptic of hype, believer in progress.'],
];

const categories = [
    [1, 'General Discussion', 'Pull up a chair. This is the campfire of the forum — introductions, off-topic chatter, and everything in between.', 'General', 'message-circle'],
    [2, 'Technology', 'Hardware, software, and the latest in tech news. Hot takes encouraged, receipts required.', 'Tech', 'cpu'],
    [3, 'Creative', 'Share art, music, writing, and works-in-progress. Feedback is a gift — wrap it nicely.', 'Creative', 'palette'],
    [4, 'Gaming', 'From indie gems to AAA blockbusters. Spoiler tags are your friends.', 'Gaming', 'gamepad-2'],
    [5, 'Science', 'Discuss the universe, from quantum foam to galactic superclusters. Citations appreciated.', 'Science', 'atom'],
    [6, 'Lifestyle', 'Food, fitness, travel, productivity — the art of living well.', 'Lifestyle', 'leaf'],
    [7, 'Help & Support', 'Stuck? Ask here. No question too small, no bug too weird.', 'Support', 'life-buoy'],
];

// [category, author, title, content]
const threads = [
    [2, 'atlas', 'The AI hype cycle is cooling — and that is exactly what the industry needed',
`After two years of breathless demos and vaporware, something interesting is happening: **quiet, boring, genuinely useful AI** is shipping.

Consider what actually survived the hype cycle:
- Code assistants that autocomplete boilerplate (not "replace all engineers")
- Medical imaging triage tools with real clinical validation
- Search that actually understands what you meant

The monoculture-of-prediction era is over. What replaced it is more fragmented, less glamorous, and infinitely more valuable.

What do you all think — was the correction inevitable, or did we just get tired?`],
    [2, 'saashq', 'I deleted Kubernetes from our stack and our infrastructure bill dropped 70%',
`Hot take incoming: most teams running Kubernetes do not need Kubernetes.

We were a 12-person startup running 40 microservices on a managed K8s cluster. Our bill was **$8,400/month** and half our eng time went into YAML archaeology.

What we did:
1. Collapsed 40 services into 6 actual domain boundaries
2. Moved to three beefy VMs behind a load balancer
3. Replaced the service mesh with... plain HTTP and DNS

Result: $2,500/month, deploy time went from 14 minutes to 90 seconds, and oncall pings dropped by a factor of ten.

I am not saying K8s is bad. I am saying it is an enterprise tool cosplaying as a default choice. Fight me.`],
    [5, 'dr_orbit', 'The James Webb telescope just found the strongest hints of life on an exoplanet yet',
`Okay, deep breath everyone. The JWST atmospheric survey of K2-18b came back and the data includes what looks like a **dimethyl sulfide signature** — a molecule that, on Earth, is *only* produced by living organisms (mostly marine phytoplankton).

Important caveats before we all lose our minds:
- This is a preliminary spectral fit, not a confirmed detection
- DMS can theoretically be produced abiotically, we just have never seen it happen
- K2-18b is a hycean world candidate — possibly a ocean planet under a hydrogen atmosphere, which is... not Earth-like at all

Still. If this holds up under replication, it is the biggest discovery in the history of astronomy. The follow-up observations are scheduled for next cycle.

Paper link and spectral charts in the comments.`],
    [3, 'lumen', 'Why does every new app look identical? A designers diagnosis of the great flattening',
`Somewhere around 2019, the entire internet agreed on one design language and nobody told me why.

The symptoms:
- Rounded-corner cards floating in pastel voids
- Inter, or if you are feeling exotic, SF Pro
- The same four icons from the same two icon packs
- "SaaS minimalism" where personality is treated as a bug

Here is my theory: **component libraries ate design**. When everyone builds from the same shadcn/Tailwind/Radix primitives, convergence is not a choice — it is physics.

But there is a counter-movement happening. Sites like this forum, Gumroad's weird 2022 rebrand, the whole "brutalist revival" thing. Designers are craving *texture* again.

What are examples of apps that feel genuinely distinct in 2024? I want to build a collection.`],
    [1, 'nova', 'Introduce yourself here! (and tell us one weird thing about your setup)',
`Welcome to the campfire! :fire:

New here? Drop an intro below. The only rule: include **one weird thing about your dev setup** to break the ice.

Mine: I do all my coding on a mechanical keyboard with clicky switches that my roommate has described as "sounding like a typerwriter falling down stairs". Zero regrets.

Ill start the roll call:
- @kai — security, keyboards, coffee
- @lumen — design, typography
- @pixelheart — games, game jams`],
    [4, 'pixelheart', 'We shipped our indie game in 9 months on a $0 marketing budget — full postmortem',
`Three months ago we launched **Hollow Circuit**, a cyberpunk puzzle-platformer made by 3 people. Today it crossed 40,000 copies. Here is everything we learned, the good and the ugly.

**What worked:**
- Demo at Steam Next Fest: 38k wishlists from that alone
- Three short devlogs showing the *process*, not trailers
- Getting featured by two mid-size YouTubers (we just emailed them, worst they can say is no)

**What flopped:**
- Paid ads: $900 spent, ~20 wishlists. Never again
- Launching same week as a Nintendo Direct (rip our visibility)
- Trying to support macOS at launch on a Unity project with zero mac hardware

**The numbers:** 40k units, 91% positive reviews, ~$180k gross. We can make another game.

Happy to answer anything — marketing, engine choices, how we split the work, whatever.`],
    [5, 'vector', 'What is the most beautiful algorithm you know? Mine: the FFT',
`Not the most *useful* (although it is certainly in the running), the most **beautiful**.

The Fast Fourier Transform takes an O(n²) problem and hands you O(n log n) through what is essentially mathematical judo: you notice that a DFT of size n can be split into two DFTs of size n/2, one over evens, one over odds, and the whole thing recurses into elegance.

Honorable mentions:
- **Reservoir sampling** — sample k items from an infinite stream with uniform probability in a single pass
- **Union-Find with path compression** — amortized almost-constant time from two lines of code
- **The fast inverse square root** — cursed, illegal, iconic

What is yours? Bonus points if you can explain it without a single formula.`],
    [6, 'fern', 'I turned my balcony into a functioning micro-farm — 4 months, $200, absurd amounts of tomatoes',
`Photo dump and full breakdown below!

**The setup:**
- 6 fabric grow bags (5-gallon) on a $40 DIY cedar shelf
- Drip irrigation from a $25 kit on a cheap timer — this changed everything, no more dead plants when I travel
- South-facing balcony, zone 7b

**Harvest so far:** 11 lbs of cherry tomatoes, endless basil, three generations of lettuce, one heroic jalapeño plant that refuses to die.

**Total spend:** ~$200 including soil, seeds, and the irrigation kit. First harvest already paid for it if you price tomatoes at *organic heirloom* rates and squint.

The real ROI is that I now check on plants with my coffee every morning and it has replaced doomscrolling. Highly recommend.

AMA about small-space growing — I have opinions about cheap grow lights.`],
    [1, 'mochi', 'Post your pets working from home (they are all so useless and I love them)',
`Biscuit has attended 47 standup calls and contributed exactly zero points. Her primary responsibilities include:
1. Sitting on the laptop warm zone during deploys
2. Yelling at 5:43pm sharp, which is honestly better than my calendar reminders
3. Keyboardwalking across a half-written PR

Post yours. Cat tax is mandatory in this thread.`],
    [2, 'kai', 'PSA: that npm package you just installed has postinstall scripts. Audit them.',
`Friendly reminder that \`npm install\` runs arbitrary code on your machine by default.

The pattern is well-worn at this point: a package with a nice name, a nice README, a few hundred stars (possibly bought), and a \`postinstall\` hook that exfiltrates your \`~/.ssh\`, environment variables, or AWS credentials.

Practical defenses that take five minutes:
- Run \`npm config set ignore-scripts true\` in your global config, then explicitly allow scripts where you trust them
- Actually read the \`postinstall\` hook of new dependencies (it is one line in package.json)
- Use \`npm ls\` to catch packages you did not know you had — the dependency tree is where the bodies are buried
- Pin versions. \`^1.2.3\` is how you wake up to a supply chain incident

Paranoia is a professional skill. Stay safe out there.`],
    [3, 'nova', 'I built a synth that turns GitHub commit history into music',
`Weekend project turned obsession: every commit becomes a note. Repo activity becomes a melody.

**The mapping:**
- Pitch = hour of day the commit landed (24-note chromatic scale)
- Note length = lines changed (log scale, otherwise refactor commits scream)
- Instrument = author (each collaborator gets their own voice)
- Rests = days with no commits

Solo repos sound like lonely jazz. Monorepos with 200 contributors sound like a dial-up modem having a panic attack.

Web Audio demo link in the comments. Source is MIT licensed, remix it!`],
    [7, 'saashq', 'Getting ERR_CONNECTION_RESET on websocket upgrades behind our new reverse proxy — any ideas?',
`Migrating from nginx to Caddy and websockets started failing with connection resets on *some* clients (mostly behind corporate proxies).

Works fine: Chrome on residential connections, curl with Upgrade headers.
Fails: clients through what I assume are proxy middleboxes.

Caddyfile is the standard reverse_proxy setup with \`header_up Connection {header.Connection}\` handled by defaults as far as I can tell.

Things I have tried:
- Explicitly setting flush_interval to -1 (forces streaming)
- Disabling HTTP/2 to upstream
- Checking idle timeouts on both sides

Next step is packet captures, but before I go down that rabbit hole — has anyone hit this specific pattern with Caddy + Hyper-Express websockets? Our prod is on Hyper-Express and I know its websocket handling has some quirks with proxy buffering.`],
];

const replies = [
    [0, 1, 'The correction was inevitable. Every platform shift goes through the "trough of boring productivity" — cloud did in 2016, mobile did in 2013. The teams still standing are the ones who stopped giving keynotes and started shipping internal tools that quietly save 20 minutes a day.'],
    [0, 3, 'Respectfully, the "correction" is a mirage. Spending is up 40% YoY. What ended is the *narrative* of instant world domination, not the investment. Those are very different things.'],
    [0, 8, 'Atlas with the reasonable takes as usual. The most underrated development is small local models running on-device. No hype, no API bill, and genuinely useful.'],
    [1, 5, '"YAML archaeology" is the most accurate two words ever written about Kubernetes. We did a similar collapse — 30 services to 8 — and nobody has missed the mesh for a single day.'],
    [1, 2, 'Curious what you did about autoscaling? The one thing K8s genuinely gave us was handling the 10x traffic spikes during product launches.'],
    [1, 0, 'The correct K8s take has always been "it is a platform for building platforms". If you are not building a platform, you are paying enterprise tax for features you will never use.'],
    [2, 6, 'Even the abiotic pathway for DMS requires chemistry we have never observed outside a lab. I am trying so hard to stay calm and failing completely.'],
    [2, 5, 'The hycean atmosphere angle is fascinating — a hydrogen atmosphere actually makes the spectral signals *easier* to read, no clouds to muddle things. The universe might be about to hand us a gift.'],
    [2, 8, 'I have been refreshing arXiv all morning like it is playoff season. Next observation cycle cannot come soon enough.'],
    [3, 0, 'The component library theory is exactly right. Add the hiring funnel on top: every designer portfolio is now screened on the same SaaS case studies, so the taste ceiling flattens generationally.'],
    [3, 8, 'Honestly this forum is a good example — it does not look like every other Discourse instance and I immediately noticed. Texture matters!'],
    [3, 6, 'Gumroad 2022 is such a good reference. Sahil basically said "what if a website had a personality" and the internet had a meltdown. Miss those days.'],
    [4, 2, 'Keyboard noise is a signal of passion. Roommates simply would not understand. Welcome everyone!'],
    [4, 7, 'Weird setup thing: I run my dev environment inside a-tmux session on a Raspberry Pi that I SSH into. It is objectively worse in every way and I love it.'],
    [4, 9, 'My weird thing: I have a rubber duck on my monitor that I have never explained to a coworker and at this point I physically cannot debug without it.'],
    [5, 0, 'This is the best postmortem format I have seen on any forum. The paid ads flopping does not surprise me — wishlists from ads convert terribly for narrative games.'],
    [5, 4, 'Congrats on 40k!! Hollow Circuit is gorgeous — the lighting in the neon district alone is worth the price. How did you handle the puzzle difficulty curve?'],
    [5, 7, 'The "email mid-size YouTubers" tip is so underrated. We did the same and one video drove 9k wishlists in a weekend. Creators want content, you have content. It is a match made in heaven.'],
    [6, 3, 'Reservoir sampling deserves its own museum. The first time I saw the proof I just sat there for a minute. So simple, so obviously correct, so unexpected.'],
    [6, 5, 'Fast inverse square root is less "beautiful" and more "beautiful crime scene". 0x5f3759df forever.'],
    [6, 8, 'Union-Find is my pick too. Tarjan proved the amortized bound is the inverse Ackermann function, which grows so slowly that it is constant for any input that will ever exist in this universe. Two lines of code, inverse-Ackermann time. Absurd.'],
    [7, 0, 'Biscuit doing "keyboardwalking across a half-written PR" took me out. My cat specifically targets the tab key.'],
    [7, 3, 'The 5:43pm yelling is a precision instrument. Better than any cron job ever written.'],
    [7, 6, 'My dog sleeps under the desk during calls and his snoring has, on at least one occasion, been mistaken for a coworker on mute.'],
    [8, 0, 'Good writeup. Also worth checking: Caddy defaults to flushing immediately for streaming responses, but websocket upgrade paths with intermediate proxies can still buffer. If the failures correlate with specific corporate networks, it is almost certainly their TLS interception appliance mangling the 101 switch.'],
    [8, 2, 'We hit something similar. Try setting an explicit read/write timeout on the websocket route in Hyper-Express — some proxies hold the connection open longer than the server expects and it gets reaped mid-handshake.'],
    [8, 6, 'Packet capture will tell you in ten minutes which side is sending the RST. Do not skip it, guessing at proxy behavior is a losing game.'],
];

async function main() {
    const conn = await pool.getConnection();
    try {
        const [userCount] = await conn.query('SELECT COUNT(*) c, (SELECT COUNT(*) FROM threads) threads FROM users');
        if (userCount[0].c >= 10) { console.log('Users seeded.'); }

        const hash = await bcrypt.hash('password123', 12);
        for (const [u, e, d, bio] of users) {
            await conn.query(
                'INSERT IGNORE INTO users (username, email, password_hash, display_name, bio, role, reputation, post_count, created_at) VALUES (?,?,?,?,?,?,?,1, NOW() - INTERVAL ? DAY)',
                [u, e, hash, d, bio, 'user', Math.floor(Math.random() * 800) + 50, Math.floor(Math.random() * 300) + 10]
            );
        }

        for (const [id, name, desc, color, icon] of categories) {
            await conn.query('UPDATE categories SET description=?, color=?, icon=?, sort_order=? WHERE id=?', [desc, color, icon, id, id]);
        }

        const userByName = {};
        const [userRows] = await conn.query('SELECT id, username FROM users');
        for (const u of userRows) userByName[u.username] = u.id;
        const userIds = {};
        users.forEach(([uname], i) => { userIds[i] = userByName[uname]; userIds[uname] = userByName[uname]; });
        let hoursAgo = threads.length * 19 + 30;
        const threadIds = [];
        for (let i = 0; i < threads.length; i++) {
            const [cat, authorIdx, title, content] = threads[i];
            const uid = userIds[authorIdx];
            const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
            const created = `NOW() - INTERVAL ${hoursAgo} HOUR`;
            const views = Math.floor(Math.random() * 4200) + 180;
            const [r] = await conn.query(
                `INSERT INTO threads (category_id, user_id, title, slug, content, views, like_count, created_at, last_post_at) VALUES (?,?,?,?,?,?,?, ${created}, ${created})`,
                [cat, uid, title, slug, content, views, Math.floor(Math.random() * 90) + 5]
            );
            threadIds.push(r.insertId);
            hoursAgo -= Math.floor(Math.random() * 14) + 6;
        }

        let rHours = 5;
        for (const [threadIdx, authorIdx, content] of replies) {
            const tid = threadIds[threadIdx];
            const uid = userIds[authorIdx];
            rHours += Math.floor(Math.random() * 10) + 2;
            await conn.query(
                `INSERT INTO replies (thread_id, user_id, content, like_count, created_at) VALUES (?,?,?,0, NOW() - INTERVAL ${Math.max(rHours, 1)} HOUR)`,
                [tid, uid, content]
            );
            await conn.query('UPDATE threads SET reply_count = reply_count + 1, last_post_at = GREATEST(last_post_at, NOW() - INTERVAL ' + Math.max(rHours,1) + ' HOUR) WHERE id = ?', [tid]);
        }

        // sync category counters
        await conn.query(`UPDATE categories c SET
            thread_count = (SELECT COUNT(*) FROM threads t WHERE t.category_id = c.id),
            post_count = (SELECT COALESCE(SUM(t.reply_count),0) FROM threads t WHERE t.category_id = c.id)`);

        console.log('Seeded: ' + users.length + ' users, ' + threads.length + ' threads, ' + replies.length + ' replies');
    } finally {
        conn.release();
        await pool.end();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
