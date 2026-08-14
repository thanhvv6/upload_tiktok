import fs from 'fs';
import path from 'path';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm']);

export function getFolderVideoStatus(folderPath) {
    if (!folderPath || typeof folderPath !== 'string' || folderPath.trim() === '') {
        return { video_count: 0, folder_status: 'not_set' };
    }
    let isDir = false;
    try {
        isDir = fs.statSync(folderPath).isDirectory();
    } catch (e) {
        return { video_count: 0, folder_status: 'missing' };
    }
    if (!isDir) return { video_count: 0, folder_status: 'missing' };
    try {
        const count = fs.readdirSync(folderPath).filter(file => {
            const ext = path.extname(file).toLowerCase();
            return VIDEO_EXTS.has(ext);
        }).length;
        return { video_count: count, folder_status: 'ok' };
    } catch (e) {
        return { video_count: 0, folder_status: 'missing' };
    }
}
