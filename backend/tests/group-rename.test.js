import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { initGroupSchema, createGroup } from '../group-store.js';
import { renameGroupWithFolder } from '../group-rename.js';

const makeDb = () => {
    const db = new Database(':memory:');
    initGroupSchema(db);
    db.exec(`
        CREATE TABLE profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            group_id TEXT,
            video_folder TEXT
        );
    `);
    return db;
};

const makeUploadsDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const addProfile = (db, id, groupId, videoFolder) =>
    db
        .prepare(
            'INSERT INTO profiles (id, name, group_id, video_folder) VALUES (?, ?, ?, ?)'
        )
        .run(id, id, groupId, videoFolder);

const videoFolderOf = (db, id) =>
    db.prepare('SELECT video_folder FROM profiles WHERE id = ?').get(id)
        .video_folder;

const nameOf = (db, id) =>
    db.prepare('SELECT name FROM groups WHERE id = ?').get(id).name;

test('renames the folder, the group row and every profile video_folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha', 'p-1'), { recursive: true });
    addProfile(db, 'p-1', 'g-1', path.join(uploadsDir, 'Alpha', 'p-1'));
    addProfile(db, 'p-2', 'g-1', path.join(uploadsDir, 'Alpha', 'p-2'));

    const result = renameGroupWithFolder(db, {
        id: 'g-1',
        name: 'Beta',
        uploadsDir
    });

    assert.deepEqual(result, {
        unchanged: false,
        name: 'Beta',
        folderRenamed: true,
        updatedProfiles: 2
    });
    assert.equal(nameOf(db, 'g-1'), 'Beta');
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Beta', 'p-1')), true);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), false);
    assert.equal(videoFolderOf(db, 'p-1'), path.join(uploadsDir, 'Beta', 'p-1'));
    assert.equal(videoFolderOf(db, 'p-2'), path.join(uploadsDir, 'Beta', 'p-2'));
});

test('leaves profiles of other groups untouched', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    createGroup(db, { id: 'g-2', name: 'Gamma' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });
    addProfile(db, 'p-1', 'g-1', path.join(uploadsDir, 'Alpha', 'p-1'));
    addProfile(db, 'p-2', 'g-2', path.join(uploadsDir, 'Gamma', 'p-2'));

    renameGroupWithFolder(db, { id: 'g-1', name: 'Beta', uploadsDir });

    assert.equal(videoFolderOf(db, 'p-2'), path.join(uploadsDir, 'Gamma', 'p-2'));
});

test('a group with no folder on disk is renamed in the DB only', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });

    const result = renameGroupWithFolder(db, {
        id: 'g-1',
        name: 'Beta',
        uploadsDir
    });

    assert.equal(result.folderRenamed, false);
    assert.equal(result.updatedProfiles, 0);
    assert.equal(nameOf(db, 'g-1'), 'Beta');
});

test('renaming to the same name is a no-op', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });

    const result = renameGroupWithFolder(db, {
        id: 'g-1',
        name: '  Alpha  ',
        uploadsDir
    });

    assert.equal(result.unchanged, true);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), true);
});

test('a profile whose video_folder points elsewhere is left alone', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });
    const custom = path.join(uploadsDir, 'somewhere-else');
    addProfile(db, 'p-1', 'g-1', custom);
    addProfile(db, 'p-2', 'g-1', null);

    const result = renameGroupWithFolder(db, {
        id: 'g-1',
        name: 'Beta',
        uploadsDir
    });

    assert.equal(result.updatedProfiles, 0);
    assert.equal(videoFolderOf(db, 'p-1'), custom);
    assert.equal(videoFolderOf(db, 'p-2'), null);
});

test('a sibling folder whose name merely starts with the old name is not rewritten', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });
    // "AlphaTeam" shares the "Alpha" prefix but is a different folder -- the
    // path separator in the prefix is what keeps it out of the rewrite.
    const sibling = path.join(uploadsDir, 'AlphaTeam', 'p-1');
    addProfile(db, 'p-1', 'g-1', sibling);

    const result = renameGroupWithFolder(db, {
        id: 'g-1',
        name: 'Beta',
        uploadsDir
    });

    assert.equal(result.updatedProfiles, 0);
    assert.equal(videoFolderOf(db, 'p-1'), sibling);
});

test('rejects invalid names before touching the folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });

    assert.throws(
        () => renameGroupWithFolder(db, { id: 'g-1', name: 'Hoa quả', uploadsDir }),
        (err) => err.status === 400 && /can only contain/i.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), true);
    assert.equal(nameOf(db, 'g-1'), 'Alpha');
});

test('rejects a duplicate name before touching the folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    createGroup(db, { id: 'g-2', name: 'Beta' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });

    assert.throws(
        () => renameGroupWithFolder(db, { id: 'g-1', name: 'beta', uploadsDir }),
        (err) => err.status === 400 && /already exists/i.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), true);
});

test('throws 404 for an unknown group', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);

    assert.throws(
        () => renameGroupWithFolder(db, { id: 'nope', name: 'Beta', uploadsDir }),
        (err) => err.status === 404 && /not found/i.test(err.message)
    );
});

test('refuses to rename onto an existing folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });
    fs.mkdirSync(path.join(uploadsDir, 'Beta'), { recursive: true });

    assert.throws(
        () => renameGroupWithFolder(db, { id: 'g-1', name: 'Beta', uploadsDir }),
        (err) => err.status === 400 && /Target folder already exists/i.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), true);
    assert.equal(nameOf(db, 'g-1'), 'Alpha');
});

test('a failure mid-update rolls back the folder, the group row and every profile', (t) => {
    const db = makeDb();
    const uploadsDir = makeUploadsDir(t);
    createGroup(db, { id: 'g-1', name: 'Alpha' });
    fs.mkdirSync(path.join(uploadsDir, 'Alpha'), { recursive: true });
    addProfile(db, 'p-1', 'g-1', path.join(uploadsDir, 'Alpha', 'p-1'));
    addProfile(db, 'p-2', 'g-1', path.join(uploadsDir, 'Alpha', 'p-2'));

    // Fail on the second profile only, so the first UPDATE has already run when
    // the error is raised -- that is the case a bare try/catch cannot undo.
    const realPrepare = db.prepare.bind(db);
    let updateCalls = 0;
    db.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!sql.startsWith('UPDATE profiles SET video_folder')) return stmt;
        return {
            run: (...args) => {
                if (++updateCalls === 2) throw new Error('disk on fire');
                return stmt.run(...args);
            }
        };
    };
    t.after(() => {
        db.prepare = realPrepare;
    });

    assert.throws(
        () => renameGroupWithFolder(db, { id: 'g-1', name: 'Beta', uploadsDir }),
        (err) => err.status === 500 && /disk on fire/.test(err.message)
    );

    assert.equal(nameOf(db, 'g-1'), 'Alpha');
    assert.equal(videoFolderOf(db, 'p-1'), path.join(uploadsDir, 'Alpha', 'p-1'));
    assert.equal(videoFolderOf(db, 'p-2'), path.join(uploadsDir, 'Alpha', 'p-2'));
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Alpha')), true);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'Beta')), false);
});
