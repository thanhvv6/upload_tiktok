import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { initGroupSchema, createGroup } from '../group-store.js';
import {
    resolveProfileFolder,
    mergeMoveFolder,
    syncProfileFolderOnGroupChange,
    resolveDeletableVideoFolders
} from '../profile-folder.js';

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

const makeTmpDir = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-folder-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const writeFile = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
};

const addProfile = (db, { id, name, groupId = null, videoFolder = null }) =>
    db
        .prepare(
            'INSERT INTO profiles (id, name, group_id, video_folder) VALUES (?, ?, ?, ?)'
        )
        .run(id, name, groupId, videoFolder);

const profileRow = (db, id) =>
    db
        .prepare('SELECT group_id, video_folder FROM profiles WHERE id = ?')
        .get(id);

// --- resolveProfileFolder -------------------------------------------------

test('resolveProfileFolder nests the profile under its group', () => {
    assert.equal(
        resolveProfileFolder('/uploads', 'check1', 'user1'),
        path.join('/uploads', 'check1', 'user1')
    );
});

test('resolveProfileFolder puts an ungrouped profile at the uploads root', () => {
    const expected = path.join('/uploads', 'user1');
    assert.equal(resolveProfileFolder('/uploads', null, 'user1'), expected);
    assert.equal(resolveProfileFolder('/uploads', '', 'user1'), expected);
    assert.equal(resolveProfileFolder('/uploads', undefined, 'user1'), expected);
});

// --- mergeMoveFolder ------------------------------------------------------

test('mergeMoveFolder moves the whole folder when the destination is free', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'check1', 'user1');
    const dest = path.join(root, 'check2', 'user1');
    writeFile(path.join(src, 'a.mp4'), 'A');

    const result = mergeMoveFolder(src, dest);

    assert.equal(result.moved, true);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(path.join(dest, 'a.mp4'), 'utf8'), 'A');
});

test('mergeMoveFolder overwrites same-named files and keeps the rest', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'same.mp4'), 'FROM_SRC');
    writeFile(path.join(src, 'only-src.mp4'), 'S');
    writeFile(path.join(dest, 'same.mp4'), 'FROM_DEST');
    writeFile(path.join(dest, 'only-dest.mp4'), 'D');

    const result = mergeMoveFolder(src, dest);

    assert.equal(result.moved, true);
    assert.equal(result.overwritten, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'same.mp4'), 'utf8'), 'FROM_SRC');
    assert.equal(fs.readFileSync(path.join(dest, 'only-src.mp4'), 'utf8'), 'S');
    assert.equal(fs.readFileSync(path.join(dest, 'only-dest.mp4'), 'utf8'), 'D');
    assert.equal(fs.existsSync(src), false);
});

test('mergeMoveFolder merges same-named subfolders instead of replacing them', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'done', 'from-src.mp4'), 'S');
    writeFile(path.join(dest, 'done', 'from-dest.mp4'), 'D');

    mergeMoveFolder(src, dest);

    assert.equal(
        fs.readFileSync(path.join(dest, 'done', 'from-src.mp4'), 'utf8'),
        'S'
    );
    assert.equal(
        fs.readFileSync(path.join(dest, 'done', 'from-dest.mp4'), 'utf8'),
        'D'
    );
});

test('mergeMoveFolder creates an empty destination when the source is missing', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'nope');
    const dest = path.join(root, 'dest');

    const result = mergeMoveFolder(src, dest);

    assert.equal(result.moved, false);
    assert.equal(fs.existsSync(dest), true);
    assert.deepEqual(fs.readdirSync(dest), []);
});

test('mergeMoveFolder is a no-op when source and destination are the same', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'same');
    writeFile(path.join(src, 'a.mp4'), 'A');

    const result = mergeMoveFolder(src, src);

    assert.equal(result.moved, false);
    assert.equal(fs.readFileSync(path.join(src, 'a.mp4'), 'utf8'), 'A');
});

test('mergeMoveFolder falls back to copy+delete when rename crosses devices', (t) => {
    const root = makeTmpDir(t);
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'a.mp4'), 'A');
    writeFile(path.join(src, 'sub', 'b.mp4'), 'B');

    const renameSync = () => {
        const err = new Error('cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
    };

    const result = mergeMoveFolder(src, dest, { renameSync });

    assert.equal(result.moved, true);
    assert.equal(fs.readFileSync(path.join(dest, 'a.mp4'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'b.mp4'), 'utf8'), 'B');
    assert.equal(fs.existsSync(src), false);
});

// --- syncProfileFolderOnGroupChange ---------------------------------------

test('moving a profile to another group moves its folder and rewrites video_folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    createGroup(db, { id: 'g-2', name: 'check2' });
    const oldFolder = path.join(uploadsDir, 'check1', 'user1');
    writeFile(path.join(oldFolder, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: oldFolder
    });

    const result = syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-2',
        uploadsDir
    });

    const newFolder = path.join(uploadsDir, 'check2', 'user1');
    assert.equal(result.videoFolder, newFolder);
    assert.deepEqual(profileRow(db, 'p-1'), {
        group_id: 'g-2',
        video_folder: newFolder
    });
    assert.equal(fs.readFileSync(path.join(newFolder, 'a.mp4'), 'utf8'), 'A');
    assert.equal(fs.existsSync(oldFolder), false);
});

test('removing a profile from its group moves the folder to the uploads root', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    const oldFolder = path.join(uploadsDir, 'check1', 'user1');
    writeFile(path.join(oldFolder, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: oldFolder
    });

    syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: null,
        uploadsDir
    });

    const newFolder = path.join(uploadsDir, 'user1');
    assert.deepEqual(profileRow(db, 'p-1'), {
        group_id: null,
        video_folder: newFolder
    });
    assert.equal(fs.readFileSync(path.join(newFolder, 'a.mp4'), 'utf8'), 'A');
});

test('a folder chosen by hand outside uploads is pulled back under the new group', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const elsewhere = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    const custom = path.join(elsewhere, 'my-videos');
    writeFile(path.join(custom, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: null,
        videoFolder: custom
    });

    syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-1',
        uploadsDir
    });

    const newFolder = path.join(uploadsDir, 'check1', 'user1');
    assert.equal(profileRow(db, 'p-1').video_folder, newFolder);
    assert.equal(fs.readFileSync(path.join(newFolder, 'a.mp4'), 'utf8'), 'A');
    assert.equal(fs.existsSync(custom), false);
});

test('a profile with no video_folder gets one created for the new group', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    addProfile(db, { id: 'p-1', name: 'user1' });

    syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-1',
        uploadsDir
    });

    const newFolder = path.join(uploadsDir, 'check1', 'user1');
    assert.equal(profileRow(db, 'p-1').video_folder, newFolder);
    assert.equal(fs.existsSync(newFolder), true);
});

test('files already in the destination are overwritten by the incoming ones', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    createGroup(db, { id: 'g-2', name: 'check2' });
    const oldFolder = path.join(uploadsDir, 'check1', 'user1');
    const newFolder = path.join(uploadsDir, 'check2', 'user1');
    writeFile(path.join(oldFolder, 'a.mp4'), 'FROM_CHECK1');
    writeFile(path.join(newFolder, 'a.mp4'), 'FROM_CHECK2');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: oldFolder
    });

    syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-2',
        uploadsDir
    });

    assert.equal(
        fs.readFileSync(path.join(newFolder, 'a.mp4'), 'utf8'),
        'FROM_CHECK1'
    );
});

test('re-assigning a profile to the group it is already in changes nothing', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    const folder = path.join(uploadsDir, 'check1', 'user1');
    writeFile(path.join(folder, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: folder
    });

    const result = syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-1',
        uploadsDir
    });

    assert.equal(result.moved, false);
    assert.equal(fs.readFileSync(path.join(folder, 'a.mp4'), 'utf8'), 'A');
    assert.equal(profileRow(db, 'p-1').video_folder, folder);
});

test('leaves a hand-picked folder alone when the group is not actually changing', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const elsewhere = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    const custom = path.join(elsewhere, 'my-videos');
    writeFile(path.join(custom, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: custom
    });

    const result = syncProfileFolderOnGroupChange(db, {
        profileId: 'p-1',
        groupId: 'g-1',
        uploadsDir
    });

    assert.equal(result.moved, false);
    assert.equal(result.videoFolder, custom);
    assert.equal(fs.readFileSync(path.join(custom, 'a.mp4'), 'utf8'), 'A');
    assert.equal(profileRow(db, 'p-1').video_folder, custom);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'check1', 'user1')), false);
});

test('throws 404 for an unknown profile', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);

    assert.throws(
        () =>
            syncProfileFolderOnGroupChange(db, {
                profileId: 'nope',
                groupId: null,
                uploadsDir
            }),
        (err) => err.status === 404 && /Profile not found/i.test(err.message)
    );
});

test('throws 404 for an unknown group and leaves the profile alone', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const folder = path.join(uploadsDir, 'user1');
    writeFile(path.join(folder, 'a.mp4'), 'A');
    addProfile(db, { id: 'p-1', name: 'user1', videoFolder: folder });

    assert.throws(
        () =>
            syncProfileFolderOnGroupChange(db, {
                profileId: 'p-1',
                groupId: 'ghost',
                uploadsDir
            }),
        (err) => err.status === 404 && /Group not found/i.test(err.message)
    );
    assert.deepEqual(profileRow(db, 'p-1'), {
        group_id: null,
        video_folder: folder
    });
    assert.equal(fs.existsSync(folder), true);
});

// --- resolveDeletableVideoFolders -----------------------------------------

const profileById = (db, id) =>
    db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);

test('deleting a profile returns its own video folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    createGroup(db, { id: 'g-1', name: 'check1' });
    const folder = path.join(uploadsDir, 'check1', 'user1');
    writeFile(path.join(folder, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        groupId: 'g-1',
        videoFolder: folder
    });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, [folder]);
});

test('deleting a profile never returns a folder belonging to a group', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    // The reported bug: profile "test" sits inside a group also called "test",
    // so uploads/test is the GROUP folder, not this profile's.
    createGroup(db, { id: 'g-1', name: 'test' });
    const groupFolder = path.join(uploadsDir, 'test');
    const folder = path.join(groupFolder, 'test');
    writeFile(path.join(folder, 'a.mp4'), 'A');
    addProfile(db, {
        id: 'p-1',
        name: 'test',
        groupId: 'g-1',
        videoFolder: folder
    });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, [folder]);
    assert.equal(folders.includes(groupFolder), false);
});

test('deleting a profile never returns a folder holding another profile', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const shared = path.join(uploadsDir, 'user1');
    const sibling = path.join(shared, 'nested');
    writeFile(path.join(sibling, 'b.mp4'), 'B');
    addProfile(db, { id: 'p-1', name: 'user1', videoFolder: null });
    addProfile(db, { id: 'p-2', name: 'other', videoFolder: sibling });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, []);
});

test('deleting an ungrouped profile still cleans up uploads/<name>', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const folder = path.join(uploadsDir, 'user1');
    writeFile(path.join(folder, 'a.mp4'), 'A');
    addProfile(db, { id: 'p-1', name: 'user1', videoFolder: null });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, [folder]);
});

test('deleting a profile also cleans up its lowercased no-space folder', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    const legacy = path.join(uploadsDir, 'myuser');
    writeFile(path.join(legacy, 'a.mp4'), 'A');
    addProfile(db, { id: 'p-1', name: 'My User', videoFolder: null });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, [legacy]);
});

test('deleting a profile never returns the uploads root itself', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    addProfile(db, { id: 'p-1', name: 'user1', videoFolder: uploadsDir });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, []);
});

test('deleting a profile skips folders that do not exist', (t) => {
    const db = makeDb();
    const uploadsDir = makeTmpDir(t);
    addProfile(db, {
        id: 'p-1',
        name: 'user1',
        videoFolder: path.join(uploadsDir, 'gone')
    });

    const folders = resolveDeletableVideoFolders(db, {
        profile: profileById(db, 'p-1'),
        uploadsDir
    });

    assert.deepEqual(folders, []);
});
