import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../db.js';

import { initGroupSchema, createGroup } from '../group-store.js';
import { createProfileRecord } from '../profile-store.js';

const makeDb = async () => {
    // Drop and recreate to ensure clean PG types (BOOLEAN, not INTEGER)
    await db.exec('DROP TABLE IF EXISTS profiles, groups CASCADE');
    await db.exec(`
        CREATE TABLE IF NOT EXISTS profiles (
            id              TEXT PRIMARY KEY,
            name            TEXT UNIQUE,
            status          TEXT DEFAULT 'idle',
            video_folder    TEXT,
            proxy           TEXT,
            is_scheduled    BOOLEAN DEFAULT FALSE,
            last_run        TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            group_id        TEXT,
            set_music       BOOLEAN DEFAULT TRUE,
            auto_increment_schedule BOOLEAN DEFAULT FALSE,
            upload_count    INTEGER DEFAULT 1,
            channel_ids     TEXT,
            needs_render    BOOLEAN DEFAULT TRUE,
            render_concat_video BOOLEAN DEFAULT FALSE,
            remove_title    BOOLEAN DEFAULT TRUE,
            render_video_long BOOLEAN DEFAULT FALSE,
            need_content_check BOOLEAN DEFAULT TRUE,
            account_id      TEXT,
            pass            TEXT,
            email           TEXT,
            pass_email      TEXT,
            avatar_image    TEXT,
            music_search    TEXT,
            cookies         TEXT,
            schedule_interval INTEGER DEFAULT 5
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

test('createProfileRecord stores a profile without group when group_id is empty', async () => {
    const tdb = await makeDb();

    const profile = await createProfileRecord(tdb, {
        id: 'p-1',
        name: 'Profile A',
        group_id: ''
    });

    assert.equal(profile.id, 'p-1');
    assert.equal(profile.name, 'Profile A');
    assert.equal(profile.group_id, null);
    assert.equal(profile.group_name, null);
    assert.equal(profile.status, 'idle');
    assert.equal(profile.is_scheduled, false);
});

test('createProfileRecord stores a valid group_id', async () => {
    const tdb = await makeDb();
    await createGroup(tdb, { id: 'g-1', name: 'Team A' });

    const profile = await createProfileRecord(tdb, {
        id: 'p-2',
        name: 'Profile B',
        group_id: 'g-1'
    });

    assert.equal(profile.group_id, 'g-1');
    assert.equal(profile.group_name, 'Team A');
});

test('createProfileRecord stores video_folder when provided', async () => {
    const tdb = await makeDb();

    const profile = await createProfileRecord(tdb, {
        id: 'p-video-1',
        name: 'Profile With Folder',
        group_id: '',
        video_folder: '/tmp/profile-videos'
    });

    assert.equal(profile.video_folder, '/tmp/profile-videos');
});

test('createProfileRecord normalizes empty video_folder to null', async () => {
    const tdb = await makeDb();

    const profile = await createProfileRecord(tdb, {
        id: 'p-video-2',
        name: 'Profile Without Folder',
        group_id: '',
        video_folder: '   '
    });

    assert.equal(profile.video_folder, null);
});

test('createProfileRecord rejects a missing group', async () => {
    const tdb = await makeDb();

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-3',
            name: 'Profile C',
            group_id: 'missing'
        }),
        /group not found/i
    );
});

test('createProfileRecord does not insert when group is missing', async () => {
    const tdb = await makeDb();

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-3',
            name: 'Profile C',
            group_id: 'missing'
        }),
        /group not found/i
    );

    const row = await tdb.prepare('SELECT COUNT(*) AS n FROM profiles').get();
    assert.equal(Number(row.n), 0);
});

test('createProfileRecord rejects non-string name', async () => {
    const tdb = await makeDb();

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-nonstring',
            name: {},
            group_id: ''
        }),
        (err) =>
            err.status === 400 && /name must be a string/i.test(err.message)
    );

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-nonstring-2',
            name: 123,
            group_id: ''
        }),
        (err) =>
            err.status === 400 && /name must be a string/i.test(err.message)
    );

    const row = await tdb.prepare('SELECT COUNT(*) AS n FROM profiles').get();
    assert.equal(Number(row.n), 0);
});

test('createProfileRecord rejects blank or whitespace-only name', async () => {
    const tdb = await makeDb();

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-bad',
            name: '',
            group_id: ''
        }),
        (err) => err.status === 400 && /name is required/i.test(err.message)
    );

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-bad2',
            name: '   \t  ',
            group_id: ''
        }),
        (err) => err.status === 400 && /name is required/i.test(err.message)
    );

    const row = await tdb.prepare('SELECT COUNT(*) AS n FROM profiles').get();
    assert.equal(Number(row.n), 0);
});

test('createProfileRecord maps duplicate name insert to a store error', async () => {
    const tdb = await makeDb();

    await createProfileRecord(tdb, {
        id: 'p-first',
        name: 'Unique Name',
        group_id: ''
    });

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-second',
            name: 'Unique Name',
            group_id: ''
        }),
        (err) =>
            err.status === 400 &&
            /profile with this name already exists/i.test(err.message)
    );

    const row = await tdb.prepare('SELECT COUNT(*) AS n FROM profiles').get();
    assert.equal(Number(row.n), 1);
});

test('createProfileRecord maps duplicate id insert to a store error', async () => {
    const tdb = await makeDb();

    await createProfileRecord(tdb, {
        id: 'p-same-id',
        name: 'First Profile',
        group_id: ''
    });

    await assert.rejects(
        createProfileRecord(tdb, {
            id: 'p-same-id',
            name: 'Second Profile',
            group_id: ''
        }),
        (err) =>
            err.status === 400 &&
            /profile with this id already exists/i.test(err.message)
    );

    const row = await tdb.prepare('SELECT COUNT(*) AS n FROM profiles').get();
    assert.equal(Number(row.n), 1);
});
