/**
 * SQLite persistence helpers for profile groups (no HTTP layer).
 */

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

export function initGroupSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

export function normalizeGroupName(name) {
    if (typeof name !== 'string') {
        throw httpError(400, 'Group name is required');
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        throw httpError(400, 'Group name is required');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        throw httpError(
            400,
            'Group name can only contain letters, numbers, underscores and hyphens (no spaces or accented characters)'
        );
    }
    return trimmed;
}

export function assertGroupNameAvailable(db, name, excludeId) {
    const conflict =
        excludeId !== undefined
            ? db
                  .prepare(
                      'SELECT id FROM groups WHERE LOWER(name) = LOWER(?) AND id != ?'
                  )
                  .get(name, excludeId)
            : db
                  .prepare('SELECT id FROM groups WHERE LOWER(name) = LOWER(?)')
                  .get(name);
    if (conflict) {
        throw httpError(400, 'A group with this name already exists');
    }
}

export function getGroupById(db, id) {
    return db
        .prepare('SELECT id, name, created_at FROM groups WHERE id = ?')
        .get(id);
}

export function assertGroupExists(db, id) {
    if (!getGroupById(db, id)) {
        throw httpError(404, 'Group not found');
    }
}

export function listGroups(db) {
    return db
        .prepare(
            `
            SELECT
                g.id,
                g.name,
                g.created_at,
                COUNT(p.id) AS profile_count
            FROM groups g
            LEFT JOIN profiles p ON p.group_id = g.id
            GROUP BY g.id, g.name, g.created_at
            ORDER BY g.created_at DESC
        `
        )
        .all()
        .map((row) => ({
            ...row,
            profile_count: Number(row.profile_count)
        }));
}

export function createGroup(db, { id, name }) {
    if (!id || typeof id !== 'string' || id.trim() === '') {
        throw httpError(400, 'Group id is required');
    }
    const trimmedName = normalizeGroupName(name);
    assertGroupNameAvailable(db, trimmedName);
    try {
        db.prepare(
            'INSERT INTO groups (id, name) VALUES (?, ?)'
        ).run(id.trim(), trimmedName);
    } catch (e) {
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            throw httpError(400, 'A group with this name already exists');
        }
        if (e && e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            throw httpError(400, 'A group with this id already exists');
        }
        throw e;
    }
}

export function renameGroup(db, { id, name }) {
    assertGroupExists(db, id);
    const trimmedName = normalizeGroupName(name);
    assertGroupNameAvailable(db, trimmedName, id);
    db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(
        trimmedName,
        id
    );
}

export function deleteGroup(db, id) {
    assertGroupExists(db, id);
    const row = db
        .prepare(
            'SELECT COUNT(*) AS n FROM profiles WHERE group_id = ?'
        )
        .get(id);
    const n = Number(row.n);
    if (n > 0) {
        throw httpError(
            409,
            'Cannot delete group: it still has profiles assigned'
        );
    }
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}
