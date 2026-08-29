// Banned words / moderation keyword filter
const { query } = require('../config/db');

let cache = { words: [], at: 0 };
const CACHE_TTL = 30 * 1000; // 30s

async function getWords() {
    if (Date.now() - cache.at < CACHE_TTL) return cache.words;
    try {
        const rows = await query('SELECT word, action FROM banned_words');
        cache = { words: rows, at: Date.now() };
    } catch (e) {
        console.error('Filter word load error:', e.message);
        return [];
    }
    return cache.words;
}

function findMatches(text, words, action) {
    const found = [];
    for (const w of words) {
        if (w.action !== action) continue;
        const escaped = w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
        if (re.test(text)) found.push(w.word);
    }
    return found;
}

/**
 * Check text against banned words.
 * Returns { blocked: [words], flagged: [words] } — blocked = reject outright,
 * flagged = post goes to the moderation queue.
 */
async function checkContent(text) {
    const words = await getWords();
    return {
        blocked: findMatches(text, words, 'block'),
        flagged: findMatches(text, words, 'moderate')
    };
}

function clearCache() { cache = { words: [], at: 0 }; }

module.exports = { checkContent, clearCache };
