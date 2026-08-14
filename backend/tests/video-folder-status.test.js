import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFolderVideoStatus } from '../video-folder-status.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-test-'));

test('null/empty path -> not_set', () => {
    assert.deepEqual(getFolderVideoStatus(null), { video_count: 0, folder_status: 'not_set' });
    assert.deepEqual(getFolderVideoStatus(''), { video_count: 0, folder_status: 'not_set' });
    assert.deepEqual(getFolderVideoStatus('   '), { video_count: 0, folder_status: 'not_set' });
});

test('nonexistent path -> missing', () => {
    const p = path.join(tmpRoot, 'does-not-exist');
    assert.deepEqual(getFolderVideoStatus(p), { video_count: 0, folder_status: 'missing' });
});

test('path is a file -> missing', () => {
    const f = path.join(tmpRoot, 'not-a-dir.mp4');
    fs.writeFileSync(f, 'x');
    assert.deepEqual(getFolderVideoStatus(f), { video_count: 0, folder_status: 'missing' });
});

test('folder with 3 videos + junk + subfolder video -> count 3, ok', () => {
    const dir = path.join(tmpRoot, 'mixed');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    fs.writeFileSync(path.join(dir, 'b.MOV'), 'x');
    fs.writeFileSync(path.join(dir, 'c.webm'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'thumb.jpg'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'd.mp4'), 'x');
    assert.deepEqual(getFolderVideoStatus(dir), { video_count: 3, folder_status: 'ok' });
});

test('empty folder -> count 0, ok', () => {
    const dir = path.join(tmpRoot, 'empty');
    fs.mkdirSync(dir);
    assert.deepEqual(getFolderVideoStatus(dir), { video_count: 0, folder_status: 'ok' });
});
