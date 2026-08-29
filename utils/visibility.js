// Category visibility: public categories are open to everyone;
// 'groups' categories are only visible to members of their allowed groups (and mods/admins).
const { query } = require('../config/db');

/**
 * Returns null if the user can see ALL categories (mods/admins),
 * otherwise returns an array of visible category IDs (possibly empty).
 */
async function getVisibleCategoryIds(user) {
    if (user && ['moderator', 'admin'].includes(user.role)) return null;
    if (!user) {
        const rows = await query("SELECT id FROM categories WHERE access_type = 'public'");
        return rows.map(r => r.id);
    }
    const rows = await query(
        `SELECT DISTINCT c.id FROM categories c
         LEFT JOIN category_groups cg ON cg.category_id = c.id
         LEFT JOIN user_group_members m ON m.user_group_id = cg.user_group_id AND m.user_id = ?
         WHERE c.access_type = 'public' OR m.user_id IS NOT NULL`,
        [user.id]
    );
    return rows.map(r => r.id);
}

/** Check whether a specific category is visible to a user. */
async function canSeeCategory(user, categoryId) {
    const ids = await getVisibleCategoryIds(user);
    if (ids === null) return true;
    return ids.includes(Number(categoryId));
}

/**
 * SQL fragment + params to restrict `t.category_id` to visible categories.
 * Returns { sql: '', params: [] } when unrestricted, else an AND fragment.
 */
function categoryFilterFragment(ids, alias = 't', column = 'category_id') {
    if (ids === null) return { sql: '', params: [] };
    if (ids.length === 0) return { sql: ` AND ${alias}.${column} = -1`, params: [] };
    return { sql: ` AND ${alias}.${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

module.exports = { getVisibleCategoryIds, canSeeCategory, categoryFilterFragment };
