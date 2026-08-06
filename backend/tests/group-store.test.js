import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db.js';

import {
    initGroupSchema,
    createGroup,
    listGroups,
    renameGroup,
    deleteGroup,
    assertGroupExists
} from '../group-store.js';

const makeDb = async () => {
    // Drop and recreate to ensure clean PG types
    await db.exec('DROP TABLE IF EXISTS profiles CASCADE');
    await db.exec('DROP TABLE IF EXISTS groups CASCADE');
    await db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE,
            group_id TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
    initGroupSchema(db);
    return db;
};

test('createGroup trims name and listGroups returns profile_count sorted by created_at desc', async () => {
    const tdb = await makeDb();

    await createGroup(tdb, { id: 'g-1', name: '  Team A  ' });
    await tdb.prepare("UPDATE groups SET created_at = '2026-04-14 10:00:00+00' WHERE id = 'g-1'").run();
    await tdb.prepare(
        "INSERT INTO groups (id, name, created_at) VALUES ('g-2', 'Team B', '2026-04-15 10:00:00+00')"
    ).run();
    const groups = await listGroups(tdb);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].id, 'g-2');
    assert.equal(groups[1].id, 'g-1');
    assert.equal(groups[1].name, 'Team A');
    assert.equal(groups[1].profile_count, 0);
});

test('renameGroup rejects duplicate names', async () => {
    const tdb = await makeDb();

    await createGroup(tdb, { id: 'g-1', name: 'Alpha' });
    await createGroup(tdb, { id: 'g-2', name: 'Beta' });

    await assert.rejects(
        renameGroup(tdb, { id: 'g-2', name: 'Alpha' }),
        /already exists/i
    );
});

test('assertGroupExists throws when group is missing', async () => {
    const tdb = await makeDb();

    await assert.rejects(
        assertGroupExists(tdb, 'missing'),
        /not found/i
    );
});

test('deleteGroup blocks removal when profiles still reference the group', async () => {
    const tdb = await makeDb();

    await createGroup(tdb, { id: 'g-1', name: 'Team A' });
    await tdb.prepare(
        "INSERT INTO profiles (id, name, group_id) VALUES ('p-1', 'Profile 1', 'g-1')"
    ).run();

    await assert.rejects(
        deleteGroup(tdb, 'g-1'),
        /still has profiles/i
    );
});
