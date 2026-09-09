import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { exec, spawn, execSync, execFileSync } from 'child_process';
import axios from 'axios';
import {
    computeNextScheduledTime,
    computeAutoIncrementTime,
    computeDelayedFirstTime,
    projectRunSchedule,
    POST_DELAY_MIN_MINUTES,
    POST_DELAY_MAX_MINUTES,
    SCHEDULE_MIN_LEAD_MINUTES,
    SCHEDULE_SLOT_MINUTES,
    STUDIO_MAX_PENDING_DAYS,
    parseScheduleValue,
    parseStudioScheduleLabel,
    formatScheduleValue,
    getScheduleHintText,
    inferScheduleFieldKind,
    sortScheduleInputs
} from './schedule-utils.js';
import { parseCookieHeader, hasLiveTikTokSession } from './cookie-utils.js';
import {
    initGroupSchema,
    listGroups,
    createGroup,
    deleteGroup,
    assertGroupExists,
    getGroupById
} from './group-store.js';
import { renameGroupWithFolder } from './group-rename.js';
import {
    resolveProfileFolder,
    resolveDeletableVideoFolders,
    syncProfileFolderOnGroupChange
} from './profile-folder.js';
import { createProfileRecord } from './profile-store.js';
import {
    parseMusicList,
    pickMusicAt,
    nextMusicIndex,
    wrapIndex,
    musicEntryMatches
} from './music-list.js';
import { getFolderVideoStatus } from './video-folder-status.js';
import {
  createJob, getJob, addClient, removeClient,
  pushEvent, appendResult, setProfileMeta, markProfileDone, markError,
  markAllDone, cancelJob, isAborted, getExcelBuffer,
} from './stats-store.js';
import { runStatsForProfile } from './stats-automation.mjs';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3010;

let lastTime = Date.now();
setInterval(() => {
    const lag = Date.now() - lastTime - 1000;
    if (lag > 200) {
        console.log(`[EventLoopLag] WARNING: Event loop blocked for ${lag}ms`);
    }
    lastTime = Date.now();
}, 1000);

app.use(cors());
app.use(express.json());

// Catch unhandled exceptions and promise rejections to prevent Playwright abrupt closures from crashing the server
process.on('uncaughtException', (err) => {
    console.error('[System] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[System] Unhandled Rejection at:', promise, 'reason:', reason);
});

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'tiktok.db');
const OLD_DB_PATH = path.join(DB_DIR, 'db.json');
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const EXTENSIONS_DIR = path.join(__dirname, '..', 'extensions');
const DUMMY_VIDEOS_DIR = path.join(__dirname, '..', 'dummy_videos');
const AVATARS_DIR = path.join(DB_DIR, 'avatars');

// Ensure directories exist
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(EXTENSIONS_DIR)) fs.mkdirSync(EXTENSIONS_DIR);
if (!fs.existsSync(DUMMY_VIDEOS_DIR)) fs.mkdirSync(DUMMY_VIDEOS_DIR);
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// Clean stale Singleton lock files that prevent Chromium from launching
// (left behind after crashes or force-kills)
function cleanSingletonLock(userDataDir) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    lockFiles.forEach(file => {
        const filePath = path.join(userDataDir, file);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[Cleanup] Removed stale lock: ${filePath}`);
            }
        } catch (e) {
            // ignore - file might not exist or be in use
        }
    });
}

// Wrapper around chromium.launchPersistentContext that cleans stale locks first
async function launchBrowser(userDataDir, options) {
    if (fs.existsSync(userDataDir)) {
        cleanSingletonLock(userDataDir);
    }
    return chromium.launchPersistentContext(userDataDir, options);
}

// Init SQLite DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        status TEXT DEFAULT 'idle',
        video_folder TEXT,
        proxy TEXT,
        is_scheduled INTEGER DEFAULT 0,
        last_run TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT,
        time TEXT,
        FOREIGN KEY(profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
`);

// Migration: Add proxy column if not exists
try {
    const tableInfo = db.prepare("PRAGMA table_info(profiles)").all();
    const hasProxy = tableInfo.some(col => col.name === 'proxy');
    if (!hasProxy) {
        db.exec("ALTER TABLE profiles ADD COLUMN proxy TEXT;");
        console.log('Added proxy column to profiles table');
    }
} catch (err) {
    console.error('Migration error (proxy column):', err);
}

// Migration: Add is_scheduled column if not exists
try {
    const tableInfo = db.prepare("PRAGMA table_info(profiles)").all();
    const hasScheduled = tableInfo.some(col => col.name === 'is_scheduled');
    if (!hasScheduled) {
        db.exec("ALTER TABLE profiles ADD COLUMN is_scheduled INTEGER DEFAULT 0;");
        console.log('Added is_scheduled column to profiles table');
    }
} catch (err) {
    console.error('Migration error (is_scheduled column):', err);
}

initGroupSchema(db);

// Migration: Add group_id column to profiles if not exists
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasGroupId = tableInfo.some((col) => col.name === 'group_id');
    if (!hasGroupId) {
        db.exec('ALTER TABLE profiles ADD COLUMN group_id TEXT;');
        console.log('Added group_id column to profiles table');
    }
} catch (err) {
    console.error('Migration error (group_id column):', err);
}

// Migration: set_music — khi bật mới chạy Edit video + chọn nhạc khi upload
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasSetMusic = tableInfo.some((col) => col.name === 'set_music');
    if (!hasSetMusic) {
        db.exec('ALTER TABLE profiles ADD COLUMN set_music INTEGER DEFAULT 0;');
        db.prepare('UPDATE profiles SET set_music = 1').run();
        console.log('Added set_music column to profiles (existing rows default to on)');
    }
} catch (err) {
    console.error('Migration error (set_music column):', err);
}

// Migration: auto_increment_schedule — Lên lịch nối tiếp (+5 phút mỗi video)
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasAutoIncrement = tableInfo.some((col) => col.name === 'auto_increment_schedule');
    if (!hasAutoIncrement) {
        db.exec('ALTER TABLE profiles ADD COLUMN auto_increment_schedule INTEGER DEFAULT 0;');
        console.log('Added auto_increment_schedule column to profiles table');
    }
} catch (err) {
    console.error('Migration error (auto_increment_schedule column):', err);
}

// Migration: upload_count — Số lượng video upload mỗi lần
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasUploadCount = tableInfo.some((col) => col.name === 'upload_count');
    if (!hasUploadCount) {
        db.exec('ALTER TABLE profiles ADD COLUMN upload_count INTEGER DEFAULT 1;');
        console.log('Added upload_count column to profiles table');
    }
} catch (err) {
    console.error('Migration error (upload_count column):', err);
}
// Migration: channel_ids — Danh sách ID channel quản lý (cách nhau bằng dấu ,)
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasChannelIds = tableInfo.some((col) => col.name === 'channel_ids');
    if (!hasChannelIds) {
        db.exec('ALTER TABLE profiles ADD COLUMN channel_ids TEXT;');
        console.log('Added channel_ids column to profiles table');
    }
} catch (err) {
    console.error('Migration error (channel_ids column):', err);
}

// Migration: needs_render — Xác định profile này có cần render video bypass không
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasNeedsRender = tableInfo.some((col) => col.name === 'needs_render');
    if (!hasNeedsRender) {
        db.exec('ALTER TABLE profiles ADD COLUMN needs_render INTEGER DEFAULT 1;');
        console.log('Added needs_render column to profiles table');
    }
} catch (err) {
    console.error('Migration error (needs_render column):', err);
}

// Migration: render_concat_video — Xác định profile này có nối video render thay vì bypass render không
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasRenderConcatVideo = tableInfo.some((col) => col.name === 'render_concat_video');
    if (!hasRenderConcatVideo) {
        db.exec('ALTER TABLE profiles ADD COLUMN render_concat_video INTEGER DEFAULT 0;');
        console.log('Added render_concat_video column to profiles table');
    }
} catch (err) {
    console.error('Migration error (render_concat_video column):', err);
}

// Migration: remove_title — Xác định profile này có xóa tiêu đề mặc định khi upload không
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasRemoveTitle = tableInfo.some((col) => col.name === 'remove_title');
    if (!hasRemoveTitle) {
        db.exec('ALTER TABLE profiles ADD COLUMN remove_title INTEGER DEFAULT 1;');
        console.log('Added remove_title column to profiles table with default 1');
    }
} catch (err) {
    console.error('Migration error (remove_title column):', err);
}

// Migration: render_video_long — Xác định profile này có xử lý video dài không
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasRenderVideoLong = tableInfo.some((col) => col.name === 'render_video_long');
    if (!hasRenderVideoLong) {
        db.exec('ALTER TABLE profiles ADD COLUMN render_video_long INTEGER DEFAULT 0;');
        console.log('Added render_video_long column to profiles table');
    }
} catch (err) {
    console.error('Migration error (render_video_long column):', err);
}

// Migration: need_content_check — Xác định profile này có cần check content không
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasNeedContentCheck = tableInfo.some((col) => col.name === 'need_content_check');
    if (!hasNeedContentCheck) {
        db.exec('ALTER TABLE profiles ADD COLUMN need_content_check INTEGER DEFAULT 1;');
        console.log('Added need_content_check column to profiles table with default 1');
    }
} catch (err) {
    console.error('Migration error (need_content_check column):', err);
}

// Migration: account_id, pass, email, pass_email — CSV import fields
const csvImportFields = [
    { name: 'account_id', type: 'TEXT' },
    { name: 'pass', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'pass_email', type: 'TEXT' },
];
for (const field of csvImportFields) {
    try {
        const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
        const hasField = tableInfo.some((col) => col.name === field.name);
        if (!hasField) {
            db.exec(`ALTER TABLE profiles ADD COLUMN ${field.name} ${field.type};`);
            console.log(`Added ${field.name} column to profiles table`);
        }
    } catch (err) {
        console.error(`Migration error (${field.name} column):`, err);
    }
}

// Migration: avatar_image — path to avatar image file for profile
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasAvatarImage = tableInfo.some((col) => col.name === 'avatar_image');
    if (!hasAvatarImage) {
        db.exec('ALTER TABLE profiles ADD COLUMN avatar_image TEXT;');
        console.log('Added avatar_image column to profiles table');
    }
} catch (err) {
    console.error('Migration error (avatar_image column):', err);
}

// Migration: music_search — danh sách nhạc, mỗi bài một dòng
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasMusicSearch = tableInfo.some((col) => col.name === 'music_search');
    if (!hasMusicSearch) {
        db.exec('ALTER TABLE profiles ADD COLUMN music_search TEXT;');
        console.log('Added music_search column to profiles table');
    }
} catch (err) {
    console.error('Migration error (music_search column):', err);
}

// Migration: music_index — bài kế tiếp trong danh sách music_search. Lượt chạy
// sau nối tiếp lượt trước chứ không quay lại bài đầu, nên con trỏ phải nằm
// trong DB. Hàng cũ mặc định 0 tức là bắt đầu từ bài trên cùng.
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasMusicIndex = tableInfo.some((col) => col.name === 'music_index');
    if (!hasMusicIndex) {
        db.exec('ALTER TABLE profiles ADD COLUMN music_index INTEGER DEFAULT 0;');
        console.log('Added music_index column to profiles table');
    }
} catch (err) {
    console.error('Migration error (music_index column):', err);
}

// Migration: use_favorite_music — chọn nhạc theo tab Favorites thay vì search
// tên bài. Mặc định 0 nên profile cũ giữ nguyên cách search như trước.
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasUseFavorite = tableInfo.some((col) => col.name === 'use_favorite_music');
    if (!hasUseFavorite) {
        db.exec('ALTER TABLE profiles ADD COLUMN use_favorite_music INTEGER DEFAULT 0;');
        console.log('Added use_favorite_music column to profiles table');
    }
} catch (err) {
    console.error('Migration error (use_favorite_music column):', err);
}

// Migration: cookies — JSON cookie array for cookie-based login
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasCookies = tableInfo.some((col) => col.name === 'cookies');
    if (!hasCookies) {
        db.exec('ALTER TABLE profiles ADD COLUMN cookies TEXT;');
        console.log('Added cookies column to profiles table');
    }
} catch (err) {
    console.error('Migration error (cookies column):', err);
}

// Migration: schedule_interval — Khoảng cách thời gian lên lịch (5 hoặc 10 phút, mặc định 5)
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasScheduleInterval = tableInfo.some((col) => col.name === 'schedule_interval');
    if (!hasScheduleInterval) {
        db.exec('ALTER TABLE profiles ADD COLUMN schedule_interval INTEGER DEFAULT 5;');
        console.log('Added schedule_interval column to profiles table');
    }
} catch (err) {
    console.error('Migration error (schedule_interval column):', err);
}

// Migration: channel_avatar — avatar hiện tại của kênh, quét từ header TikTok
// Studio rồi tải về data/avatars. Khác hẳn avatar_image ở trên: cột kia là ảnh
// local người dùng chọn để ĐỔI avatar, cột này là ảnh kênh đang dùng.
// channel_avatar_at vừa là dấu thời gian quét, vừa là tham số phá cache của
// thẻ <img> ở frontend — đường dẫn file không đổi nên trình duyệt sẽ giữ ảnh cũ.
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasChannelAvatar = tableInfo.some((col) => col.name === 'channel_avatar');
    if (!hasChannelAvatar) {
        db.exec('ALTER TABLE profiles ADD COLUMN channel_avatar TEXT;');
        console.log('Added channel_avatar column to profiles table');
    }
    const hasChannelAvatarAt = tableInfo.some((col) => col.name === 'channel_avatar_at');
    if (!hasChannelAvatarAt) {
        db.exec('ALTER TABLE profiles ADD COLUMN channel_avatar_at TEXT;');
        console.log('Added channel_avatar_at column to profiles table');
    }
} catch (err) {
    console.error('Migration error (channel_avatar columns):', err);
}

// Migration: last_scheduled_at — mốc hẹn giờ của video cuối cùng đã đăng thành
// công trong lượt chạy gần nhất. Xoá về NULL mỗi khi profile bắt đầu chạy, nên
// con số luôn thuộc về lượt hiện tại chứ không phải một loạt lịch cũ.
try {
    const tableInfo = db.prepare('PRAGMA table_info(profiles)').all();
    const hasLastScheduled = tableInfo.some((col) => col.name === 'last_scheduled_at');
    if (!hasLastScheduled) {
        db.exec('ALTER TABLE profiles ADD COLUMN last_scheduled_at TEXT;');
        console.log('Added last_scheduled_at column to profiles table');
    }
} catch (err) {
    console.error('Migration error (last_scheduled_at column):', err);
}

// Migration from db.json
if (fs.existsSync(OLD_DB_PATH)) {
    try {
        const oldData = JSON.parse(fs.readFileSync(OLD_DB_PATH, 'utf-8'));
        if (oldData.profiles) {
            const insertProfile = db.prepare('INSERT OR IGNORE INTO profiles (id, name, status) VALUES (?, ?, ?)');
            for (const p of oldData.profiles) {
                insertProfile.run(p.id, p.name, p.status || 'idle');
            }
        }
        if (oldData.config) {
            const insertConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
            Object.entries(oldData.config).forEach(([k, v]) => {
                insertConfig.run(k, String(v));
            });
        }
        // Rename old DB to avoid repeat migration
        fs.renameSync(OLD_DB_PATH, OLD_DB_PATH + '.bak');
        console.log('Migrated data from db.json to SQLite');
    } catch (err) {
        console.error('Migration error:', err);
    }
}

// Default config if missing
const getConfig = (key, defaultValue) => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
};
const setConfig = (key, value) => {
    if (value === null || value === undefined) {
        db.prepare('DELETE FROM config WHERE key = ?').run(key);
    } else {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
    }
};

if (!getConfig('videoFolder', null)) setConfig('videoFolder', UPLOADS_DIR);
if (!getConfig('maxConcurrency', null)) setConfig('maxConcurrency', '2');
if (!getConfig('postDelayEnabled', null)) setConfig('postDelayEnabled', '0');

// Migration: hẹn giờ đăng chuyển từ giờ sang phút, để cài được mốc 15 phút mà
// đơn vị giờ không diễn tả gọn được. Giá trị cũ được quy đổi đúng một lần, chứ
// không bỏ đi — người dùng đã cài 1 giờ thì sau khi nâng cấp vẫn là 60 phút.
if (!getConfig('postDelayMinutes', null)) {
    // getConfig trả null khi thiếu khoá, mà Number(null) là 0 chứ không phải
    // NaN -- nên phải tách trường hợp thiếu ra trước, nếu không máy cài mới sẽ
    // nhận 0 phút thay vì mặc định 60.
    const legacyRaw = getConfig('postDelayHours', null);
    const legacyHours = legacyRaw === null ? NaN : Number(legacyRaw);
    setConfig(
        'postDelayMinutes',
        Number.isFinite(legacyHours) && legacyHours > 0 ? Math.round(legacyHours * 60) : 60
    );
    setConfig('postDelayHours', null);
}

// Hẹn giờ đăng — setting toàn cục, ăn cho mọi profile và mọi kiểu chạy.
const normalizePostDelayMinutes = (value) => {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return null;
    // Làm tròn lên bội số 5 chứ không phải về số nguyên gần nhất: mọi mốc lịch
    // đều rơi vào bội số 5 phút, nên để ô cài đặt nhận 27 chỉ tạo ra khoảng
    // lệch mà người dùng không hiểu vì sao.
    const slot = SCHEDULE_SLOT_MINUTES;
    const rounded = Math.ceil(minutes / slot) * slot;
    return Math.min(Math.max(rounded, POST_DELAY_MIN_MINUTES), POST_DELAY_MAX_MINUTES);
};

// Trả về 0 khi tắt, để chỗ gọi chỉ cần kiểm tra > 0.
const getPostDelayMinutes = () => {
    if (String(getConfig('postDelayEnabled', '0')) !== '1') return 0;
    return normalizePostDelayMinutes(getConfig('postDelayMinutes', 60)) ?? 0;
};

// Cleanup: Reset any stuck profiles to "idle" on startup
db.prepare("UPDATE profiles SET status = 'idle' WHERE status IN ('uploading', 'queued', 'logging_in', 'changing_avatar', 'adding_favorite_music')").run();
console.log('Reset stuck profiles (uploading, queued, logging_in, changing_avatar, adding_favorite_music) to idle');

function normalizeGroupId(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const s = typeof value === 'string' ? value : String(value);
    const trimmed = s.trim();
    return trimmed.length === 0 ? null : trimmed;
}

function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    let server, username, password;

    // Remove protocol first if present
    let raw = proxyStr;
    const protocolMatch = proxyStr.match(/^(\w+):\/\//);
    let protocol = 'http';
    if (protocolMatch) {
        protocol = protocolMatch[1];
        raw = proxyStr.slice(protocolMatch[0].length);
    }

    // Handle user:pass@host:port
    if (raw.includes('@')) {
        const [auth, hostPort] = raw.split('@');
        const [user, pass] = auth.split(':');
        username = user;
        password = pass;
        server = `${protocol}://${hostPort}`;
    }
    // Handle host:port:user:pass
    else if (raw.split(':').length === 4) {
        const parts = raw.split(':');
        server = `${protocol}://${parts[0]}:${parts[1]}`;
        username = parts[2];
        password = parts[3];
    }
    // Handle host:port or protocol://host:port
    else {
        server = proxyStr.includes('://') ? proxyStr : `http://${proxyStr}`;
    }

    // Strip trailing slash if present to avoid Chromium proxy authentication issues
    if (server && server.endsWith('/')) {
        server = server.slice(0, -1);
    }

    return { server, username, password };
}

async function injectProfileCookies(browser, profile) {
    if (profile.cookies && profile.cookies.trim()) {
        // Đừng đè lên một phiên đang sống sẵn trong user-data-dir. Cookie trong
        // folder được Chrome cập nhật sau mỗi phiên, còn bản trong DB chỉ được
        // ghi khi đăng nhập qua luồng tự động — nên bản trong DB luôn cũ hơn
        // hoặc bằng. Bỏ qua bước này chính là thứ giữ lại lần đăng nhập tay:
        // trước đây quét QR xong bấm Chạy là mất phiên, vì lượt tiêm kế tiếp
        // thay nó bằng bộ cookie cũ đã chết trong DB.
        const existing = await browser.cookies().catch(() => []);
        if (hasLiveTikTokSession(existing)) {
            console.log(`[${profile.name}] Profile đã có phiên TikTok đang sống — bỏ qua việc tiêm cookie từ DB.`);
            return;
        }

        try {
            let cookies;
            try {
                cookies = JSON.parse(profile.cookies);
            } catch (jsonErr) {
                // Dạng chuỗi "name1=value1; name2=value2". parseCookieHeader gán
                // hạn cho chúng — thiếu hạn thì Playwright tạo cookie phiên và
                // ghi đè mất cookie persistent đang có trong user-data-dir.
                cookies = parseCookieHeader(profile.cookies);
            }
            if (Array.isArray(cookies) && cookies.length > 0) {
                const cleanedCookies = cookies.map(c => {
                    const clean = { ...c };
                    if (typeof clean.expires === 'number') {
                        clean.expires = Math.round(clean.expires);
                    }
                    if (clean.sameSite && !['Lax', 'Strict', 'None'].includes(clean.sameSite)) {
                        delete clean.sameSite;
                    }
                    return clean;
                });
                await browser.addCookies(cleanedCookies);
                console.log(`[${profile.name}] Automatically injected ${cleanedCookies.length} cookies into browser context`);
            }
        } catch (e) {
            console.error(`[${profile.name}] Failed to inject cookies:`, e.message);
        }
    }
}

// API Routes
app.get('/api/profiles', (req, res) => {
    const profiles = db
        .prepare(
            `
            SELECT
                p.*,
                g.name AS group_name,
                (SELECT group_concat(time) FROM profile_schedules WHERE profile_id = p.id) as schedules
            FROM profiles p
            LEFT JOIN groups g ON g.id = p.group_id
            ORDER BY p.created_at DESC
        `
        )
        .all();
    // Đọc một lần cho cả lượt: cấu hình và đồng hồ giống nhau với mọi profile,
    // mà endpoint này bị poll 5 giây một lần.
    const postDelayMinutes = getPostDelayMinutes();
    const now = new Date();

    res.json(profiles.map(p => {
        const folder = getFolderVideoStatus(p.video_folder);
        // Ước lượng "bấm chạy bây giờ thì video cuối lên lúc mấy giờ".
        const projection = projectRunSchedule({
            lastScheduledAt: p.last_scheduled_at,
            videoCount: folder.video_count,
            intervalMinutes: p.schedule_interval,
            postDelayMinutes,
            autoIncrement: p.auto_increment_schedule === 1,
            isScheduled: p.is_scheduled === 1,
            uploadCount: p.upload_count,
            now,
        });
        return {
            ...p,
            schedules: p.schedules ? p.schedules.split(',') : [],
            ...folder,
            projected_first_schedule: projection ? projection.first.toISOString() : null,
            projected_last_schedule: projection ? projection.last.toISOString() : null,
            projected_count: projection ? projection.count : 0,
        };
    }));
});

app.post('/api/profiles', (req, res) => {
    const { name, group_id, video_folder, channel_ids, need_content_check, render_video_long, set_music, render_concat_video } = req.body;

    try {
        const id = Date.now().toString();

        // No folder picked by hand -> fall back to the uploads/<group>/<profile>
        // layout the CSV and folder importers already use. The mkdir waits until
        // the row is in, so a rejected profile leaves no stray folder behind.
        let resolvedVideoFolder = video_folder;
        if (!resolvedVideoFolder || String(resolvedVideoFolder).trim() === '') {
            const groupId = normalizeGroupId(group_id);
            if (groupId) assertGroupExists(db, groupId);
            const profileName = typeof name === 'string' ? name.trim() : '';
            if (profileName) {
                resolvedVideoFolder = resolveProfileFolder(
                    UPLOADS_DIR,
                    groupId ? getGroupById(db, groupId).name : null,
                    profileName
                );
            }
        }

        const profile = createProfileRecord(db, {
            id,
            name,
            group_id,
            video_folder: resolvedVideoFolder,
            channel_ids,
            need_content_check,
            render_video_long,
            set_music,
            render_concat_video
        });
        if (profile.video_folder) {
            fs.mkdirSync(profile.video_folder, { recursive: true });
        }
        res.json(profile);
    } catch (err) {
        res.status(err.status || 400).json({
            error: err.message || 'Profile already exists or database error'
        });
    }
});

// CSV Import: parse CSV text and create profiles + groups
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length === 0 || values.every((v) => v === '')) continue;
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] !== undefined ? values[idx] : '';
        });
        rows.push(row);
    }
    return { headers, rows };
}

function findOrCreateGroupByName(db, groupName) {
    if (!groupName || groupName.trim() === '') return null;

    const trimmed = groupName.trim();
    const existing = db.prepare('SELECT id FROM groups WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) return existing.id;

    const id = Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8);
    try {
        db.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').run(id, trimmed);
        return id;
    } catch (e) {
        // Race condition: another import may have created it
        const retry = db.prepare('SELECT id FROM groups WHERE LOWER(name) = LOWER(?)').get(trimmed);
        return retry ? retry.id : null;
    }
}

app.post('/api/profiles/import-csv', (req, res) => {
    const { csvText } = req.body;
    if (!csvText || typeof csvText !== 'string') {
        return res.status(400).json({ error: 'csvText is required' });
    }

    try {
        const { headers, rows } = parseCSV(csvText);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'CSV file has no data rows' });
        }

        const results = { imported: 0, skipped: 0, errors: [] };

        const insertProfile = db.prepare(`
            INSERT INTO profiles (id, name, status, is_scheduled, auto_increment_schedule,
                group_id, video_folder, set_music, upload_count, needs_render, remove_title,
                need_content_check, account_id, pass, email, pass_email, cookies, music_search)
            VALUES (?, ?, 'idle', 0, 0, ?, ?, 0, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?)
        `);

        const existingNames = new Set(
            db.prepare('SELECT name FROM profiles').all().map((r) => r.name.toLowerCase())
        );

        for (const row of rows) {
            const profileName = (row.profile_name || row.name || '').trim();
            if (!profileName) {
                results.errors.push('Row skipped: empty profile_name');
                results.skipped++;
                continue;
            }

            if (existingNames.has(profileName.toLowerCase())) {
                results.errors.push(`"${profileName}": profile name already exists`);
                results.skipped++;
                continue;
            }

            const groupName = (row.group_name || row.group || '').trim();
            let groupId = null;
            if (groupName) {
                groupId = findOrCreateGroupByName(db, groupName);
            }

            let accountId = (row.account_id || '').trim() || null;
            let pass = (row.pass || row.password || '').trim() || null;
            let email = (row.email || '').trim() || null;
            let passEmail = (row.pass_email || row.pass_email_password || '').trim() || null;
            let cookies = (row.cookies || '').trim() || null;
            let musicSearch = (row.music_search || row.favorite_music || row.music || '').trim() || null;

            if (accountId && accountId.includes('|') && !pass && !email && !passEmail) {
                const parts = accountId.split('|');
                accountId = parts[0] ? parts[0].trim() : null;
                pass = parts[1] ? parts[1].trim() : null;
                email = parts[2] ? parts[2].trim() : null;
                passEmail = parts[3] ? parts[3].trim() : null;
            }

            const id = Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8);

            const videoFolder = resolveProfileFolder(UPLOADS_DIR, groupName, profileName);

            try {
                if (videoFolder) {
                    fs.mkdirSync(videoFolder, { recursive: true });
                }
                insertProfile.run(id, profileName, groupId, videoFolder, accountId, pass, email, passEmail, cookies, musicSearch);
                existingNames.add(profileName.toLowerCase());
                results.imported++;
            } catch (e) {
                results.errors.push(`"${profileName}": ${e.message}`);
                results.skipped++;
            }
        }

        res.json(results);
    } catch (err) {
        console.error('CSV import error:', err);
        res.status(500).json({ error: `Failed to import CSV: ${err.message}` });
    }
});

app.post('/api/profiles/import-folder', (req, res) => {
    const { folderPath } = req.body;
    if (!folderPath || typeof folderPath !== 'string') {
        return res.status(400).json({ error: 'folderPath is required' });
    }

    try {
        const resolvedPath = path.resolve(folderPath);
        if (!fs.existsSync(resolvedPath)) {
            return res.status(400).json({ error: 'Folder path does not exist' });
        }
        const stats = fs.statSync(resolvedPath);
        if (!stats.isDirectory()) {
            return res.status(400).json({ error: 'Path is not a directory' });
        }

        const configPath = path.join(resolvedPath, 'config.json');
        if (!fs.existsSync(configPath)) {
            return res.status(400).json({ error: 'config.json not found in the directory' });
        }

        const configContent = fs.readFileSync(configPath, 'utf8');
        let configData;
        try {
            configData = JSON.parse(configContent);
        } catch (parseErr) {
            return res.status(400).json({ error: 'Failed to parse config.json as JSON' });
        }

        const accounts = configData.accounts;
        if (!Array.isArray(accounts)) {
            return res.status(400).json({ error: 'accounts list not found in config.json' });
        }

        const results = { imported: 0, skipped: 0, errors: [] };

        const insertProfile = db.prepare(`
            INSERT INTO profiles (id, name, status, is_scheduled, auto_increment_schedule,
                group_id, video_folder, set_music, upload_count, needs_render, remove_title,
                need_content_check, account_id, pass, email, pass_email, cookies, music_search, proxy)
            VALUES (?, ?, 'idle', 0, 0, ?, ?, 0, 1, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?)
        `);

        const existingNames = new Set(
            db.prepare('SELECT name FROM profiles').all().map((r) => r.name.toLowerCase())
        );

        const cookiesDir = path.join(resolvedPath, 'cookies');

        for (const account of accounts) {
            const profileName = (account.name || '').trim();
            const accountId = (account.id || '').trim();

            if (!profileName) {
                results.errors.push(`Row skipped: empty account name for id "${accountId}"`);
                results.skipped++;
                continue;
            }

            // Check if cookie file exists first (as requested by the user)
            const cookieFileName = `${accountId}.json`;
            const cookieFilePath = path.join(cookiesDir, cookieFileName);
            if (!accountId || !fs.existsSync(cookieFilePath)) {
                results.errors.push(`"${profileName}": skipped because no corresponding cookie file "${cookieFileName}" was found`);
                results.skipped++;
                continue;
            }

            if (existingNames.has(profileName.toLowerCase())) {
                results.errors.push(`"${profileName}": profile name already exists`);
                results.skipped++;
                continue;
            }

            const groupName = (account.group || '').trim();
            let groupId = null;
            if (groupName) {
                groupId = findOrCreateGroupByName(db, groupName);
            }

            let cookiesContent = null;
            try {
                const rawCookies = fs.readFileSync(cookieFilePath, 'utf8');
                // Validate it is valid JSON
                JSON.parse(rawCookies);
                cookiesContent = rawCookies;
            } catch (err) {
                results.errors.push(`"${profileName}": failed to parse cookie file "${cookieFileName}"`);
                results.skipped++;
                continue;
            }

            const proxy = (account.proxy || '').trim() || null;
            const id = Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8);

            const videoFolder = resolveProfileFolder(UPLOADS_DIR, groupName, profileName);

            try {
                if (videoFolder) {
                    fs.mkdirSync(videoFolder, { recursive: true });
                }
                insertProfile.run(id, profileName, groupId, videoFolder, accountId, null, null, null, cookiesContent, null, proxy);
                existingNames.add(profileName.toLowerCase());
                results.imported++;
            } catch (e) {
                results.errors.push(`"${profileName}": ${e.message}`);
                results.skipped++;
            }
        }

        res.json(results);
    } catch (err) {
        console.error('Folder import error:', err);
        res.status(500).json({ error: `Failed to import folder: ${err.message}` });
    }
});

app.post('/api/profiles/export-folder', async (req, res) => {
    try {
        const { profileIds, exportPath, downloadZip } = req.body;

        if (!Array.isArray(profileIds) || profileIds.length === 0) {
            return res.status(400).json({ error: 'Chưa chọn profile nào để xuất' });
        }

        // Fetch selected profiles
        const placeholders = profileIds.map(() => '?').join(',');
        const profiles = db.prepare(`SELECT * FROM profiles WHERE id IN (${placeholders})`).all(...profileIds);

        if (!profiles || profiles.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy profile nào phù hợp' });
        }

        // Fetch group names mapping
        const groupRows = db.prepare('SELECT id, name FROM groups').all();
        const groupMap = new Map(groupRows.map(g => [g.id, g.name]));

        // Determine output directory
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const folderName = `TikTok_Export_selected_${profiles.length}TK_${dateStr}`;
        let targetDir;
        if (exportPath && exportPath.trim()) {
            targetDir = path.resolve(exportPath.trim());
        } else {
            targetDir = path.join(__dirname, '..', folderName);
        }

        fs.mkdirSync(targetDir, { recursive: true });

        const cookiesDir = path.join(targetDir, 'cookies');
        fs.mkdirSync(cookiesDir, { recursive: true });

        const accounts = [];
        let exportedCookiesCount = 0;
        let missingCookiesCount = 0;

        const updateAccountIdStmt = db.prepare('UPDATE profiles SET account_id = ? WHERE id = ?');

        for (const profile of profiles) {
            let accountId = (profile.account_id || '').trim();
            if (!accountId) {
                accountId = 'qr' + Math.random().toString(36).substring(2, 12);
                try {
                    updateAccountIdStmt.run(accountId, profile.id);
                } catch (e) {}
            }

            const rawCookies = (profile.cookies || '').trim();
            const cookieFilePath = path.join(cookiesDir, `${accountId}.json`);

            if (rawCookies) {
                try {
                    let cookieObj;
                    if (rawCookies.startsWith('[') || rawCookies.startsWith('{')) {
                        cookieObj = JSON.parse(rawCookies);
                    } else {
                        cookieObj = rawCookies.split(';').map(part => {
                            const [name, ...val] = part.trim().split('=');
                            return { name, value: val.join('='), domain: '.tiktok.com', path: '/' };
                        });
                    }
                    fs.writeFileSync(cookieFilePath, JSON.stringify(cookieObj, null, 2), 'utf8');
                    exportedCookiesCount++;
                } catch (err) {
                    fs.writeFileSync(cookieFilePath, '[]', 'utf8');
                    missingCookiesCount++;
                }
            } else {
                fs.writeFileSync(cookieFilePath, '[]', 'utf8');
                missingCookiesCount++;
            }

            const groupName = groupMap.get(profile.group_id) || '';

            accounts.push({
                id: accountId,
                name: profile.name,
                browser_data_dir: `C:\\Users\\PC\\Desktop\\TikTokAllInOne3.exe\\data\\browser_data\\acc_${accountId}`,
                proxy: (profile.proxy || '').trim(),
                note: "exported cookie login",
                group: groupName,
                video_folder: "",
                youtube_channels: [],
                music_claim: "",
                folder_enabled: true,
                need_login: false
            });
        }

        const instanceId = (Math.random().toString(36).substring(2, 11) + '-' + Math.random().toString(36).substring(2, 5)).toUpperCase();
        const configData = {
            instance_id: instanceId,
            accounts: accounts,
            check_interval_seconds: 300,
            max_concurrent_uploads: 2,
            download_dir: "",
            videos_per_account: 1,
            folder_threads: 2,
            delete_after_upload: false,
            music_claim: "",
            telegram_bot_token: "",
            telegram_chat_id: "",
            vps_id: "",
            hmcaptcha_apikey: "",
            backup_keep_startup: 5,
            backup_keep_daily: 7,
            groups: [],
            recently_deleted: [],
            keep_original_audio: false,
            folder_schedule: false,
            folder_schedule_gap: 0,
            folder_schedule_perday: 0,
            folder_schedule_mode: "even",
            folder_schedule_perbatch: 1,
            yt_freshness: "all",
            acc_alive: {}
        };

        fs.writeFileSync(path.join(targetDir, 'config.json'), JSON.stringify(configData, null, 2), 'utf8');
        fs.writeFileSync(path.join(targetDir, 'archive.json'), JSON.stringify({ known_ids: [] }, null, 2), 'utf8');

        let zipPath = null;
        let downloadUrl = null;

        if (downloadZip) {
            zipPath = `${targetDir}.zip`;
            try {
                execFileSync('powershell.exe', [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    `Compress-Archive -Path '${targetDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
                ], { windowsHide: true });
                downloadUrl = `/api/profiles/download-export-zip?file=${encodeURIComponent(path.basename(zipPath))}`;
            } catch (zErr) {
                console.error('ZIP creation error:', zErr);
            }
        }

        return res.json({
            success: true,
            exportPath: targetDir,
            zipPath: zipPath,
            downloadUrl: downloadUrl,
            total: profiles.length,
            exportedCookies: exportedCookiesCount,
            missingCookies: missingCookiesCount
        });

    } catch (err) {
        console.error('Export folder error:', err);
        return res.status(500).json({ error: `Failed to export folder: ${err.message}` });
    }
});

app.get('/api/profiles/download-export-zip', (req, res) => {
    try {
        const fileName = req.query.file;
        if (!fileName || !fileName.endsWith('.zip')) {
            return res.status(400).send('Invalid file parameter');
        }
        const safeFileName = path.basename(fileName);
        const zipPath = path.join(__dirname, '..', safeFileName);
        if (!fs.existsSync(zipPath)) {
            return res.status(404).send('ZIP file not found');
        }
        res.download(zipPath, safeFileName);
    } catch (err) {
        res.status(500).send('Error downloading zip file');
    }
});


app.delete('/api/profiles/:id', async (req, res) => {
    const profileId = req.params.id;
    try {
        // 1. Get profile info before deleting from DB
        const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
        
        if (profile) {
            console.log(`[System] Deleting profile ${profile.name}...`);

            // 1.5. Stop any active browser sessions
            const stopSession = async (map, id) => {
                if (map.has(id)) {
                    try {
                        const session = map.get(id);
                        if (session) {
                            if (session.stop !== undefined) session.stop = true;
                            if (session.browser) await session.browser.close().catch(() => {});
                            else if (session.close) await session.close().catch(() => {});
                        }
                    } catch (e) {}
                    map.delete(id);
                }
            };
            await stopSession(manualBrowsers, profileId);
            await stopSession(engagingProfiles, profileId);
            await stopSession(loggingInProfiles, profileId);

            // Give Windows a moment to release file locks
            await new Promise(r => setTimeout(r, 1000));

            // 2. Delete browser profile folder
            const profileFolder = path.join(PROFILES_DIR, profile.name);
            if (fs.existsSync(profileFolder) && profileFolder !== PROFILES_DIR && profile.name.length > 0) {
                try {
                    fs.rmSync(profileFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
                    console.log(`[System] Deleted browser profile folder: ${profileFolder}`);
                } catch (err) {
                    console.error(`[System] Error deleting browser profile folder: ${err.message}`);
                }
            }

            // 3. Delete the video upload folders that belong to this profile
            // only -- never a group folder, never one holding another profile.
            for (const folder of resolveDeletableVideoFolders(db, { profile, uploadsDir: UPLOADS_DIR })) {
                try {
                    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
                    console.log(`[System] Deleted video upload folder: ${folder}`);
                } catch (err) {
                    console.error(`[System] Error deleting video upload folder ${folder}: ${err.message}`);
                }
            }
        }

        // Delete from Database
        db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
        res.json({ success: true });
    } catch (err) {
        console.error(`[System] Error during profile deletion: ${err.message}`);
        res.status(500).json({ error: `Failed to delete profile: ${err.message}` });
    }
});

app.post('/api/profiles/delete-multiple', async (req, res) => {
    const { profileIds } = req.body;
    if (!profileIds || !Array.isArray(profileIds) || profileIds.length === 0) {
        return res.status(400).json({ error: 'profileIds array is required' });
    }

    try {
        for (const profileId of profileIds) {
            const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
            
            if (profile) {
                console.log(`[System] Deleting profile ${profile.name}...`);

                // 1.5. Stop any active browser sessions
                const stopSession = async (map, id) => {
                    if (map.has(id)) {
                        try {
                            const session = map.get(id);
                            if (session) {
                                if (session.stop !== undefined) session.stop = true;
                                if (session.browser) await session.browser.close().catch(() => {});
                                else if (session.close) await session.close().catch(() => {});
                            }
                        } catch (e) {}
                        map.delete(id);
                    }
                };
                await stopSession(manualBrowsers, profileId);
                await stopSession(engagingProfiles, profileId);
                await stopSession(loggingInProfiles, profileId);

                // Give Windows a moment to release file locks
                await new Promise(r => setTimeout(r, 1000));

                // 2. Delete browser profile folder
                const profileFolder = path.join(PROFILES_DIR, profile.name);
                if (fs.existsSync(profileFolder) && profileFolder !== PROFILES_DIR && profile.name.length > 0) {
                    try {
                        fs.rmSync(profileFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
                        console.log(`[System] Deleted browser profile folder: ${profileFolder}`);
                    } catch (err) {
                        console.error(`[System] Error deleting browser profile folder: ${err.message}`);
                    }
                }

                // 3. Delete the video upload folders that belong to this profile
                // only -- never a group folder, never one holding another profile.
                for (const folder of resolveDeletableVideoFolders(db, { profile, uploadsDir: UPLOADS_DIR })) {
                    try {
                        fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
                        console.log(`[System] Deleted video upload folder: ${folder}`);
                    } catch (err) {
                        console.error(`[System] Error deleting video upload folder ${folder}: ${err.message}`);
                    }
                }
            }

            // Delete from Database
            db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
        }
        res.json({ success: true, count: profileIds.length });
    } catch (err) {
        console.error(`[System] Error during multiple profile deletion: ${err.message}`);
        res.status(500).json({ error: `Failed to delete profiles: ${err.message}` });
    }
});

// POST /api/profiles/clear-trash — Clear cache/trash from profile folders to free disk space
// Safely removes only Chromium cache directories, preserving auth (Cookies, Login Data, Local Storage, Preferences)
app.post('/api/profiles/clear-trash', (req, res) => {
    const { profileIds } = req.body;
    if (!profileIds || !Array.isArray(profileIds) || profileIds.length === 0) {
        return res.status(400).json({ error: 'profileIds array is required' });
    }

    // Directories safe to delete (cache only, no auth data)
    const TRASH_DIRS = [
        'Cache', 'Code Cache', 'GPUCache',
        'Service Worker',
        'GraphiteDawnCache', 'DawnWebGPUCache', 'DawnGraphiteCache',
        'ShaderCache', 'GrShaderCache',
        'Session Storage',
        'component_crx_cache', 'extensions_crx_cache',
        'segmentation_platform',
        'shared_proto_db',
        'GCM Store',
        'Site Characteristics Database',
        'Sync Data',
        'Feature Engagement Tracker',
        'Extension State', 'Extension Scripts', 'Extension Rules',
        'Search Logos',
        'VideoDecodeStats',
        'PersistentOriginTrials',
        'parcel_tracking_db',
        'Safe Browsing',
        'NativeMessagingHosts',
        // TikTok video/media cache — chiếm hàng GB mỗi profile
        'IndexedDB',
        'blob_storage',
        'BrowserMetrics',
        'Crashpad',
    ];

    // Also clear specific cache files in Default/ (not directories)
    const TRASH_FILES = [
        'TransportSecurity',   // HSTS preload cache
        'Network Persistent State',  // network state cache
        'Reporting and NEL',   // network error logging
        'OriginTrials',        // origin trial tokens (file version)
        'QuotaManager',        // quota tracking (rebuilt on next launch)
        'QuotaManager-journal',
        'LOCK',                // DB lock file
        'LOG',                 // DB log file
        'LOG.old',             // old DB log
    ];

    const results = [];
    let totalFreedBytes = 0;

    for (const profileId of profileIds) {
        const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
        if (!profile) {
            results.push({ profileId, profileName: '(unknown)', error: 'Profile not found', freedBytes: 0 });
            continue;
        }

        const profileDir = path.join(PROFILES_DIR, profile.name);
        if (!fs.existsSync(profileDir)) {
            results.push({ profileId, profileName: profile.name, error: 'Profile folder not found', freedBytes: 0 });
            continue;
        }

        let profileFreedBytes = 0;

        // Helper: recursive directory size (before deletion)
        const getDirSize = (dirPath) => {
            let size = 0;
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    try {
                        if (entry.isDirectory()) {
                            size += getDirSize(fullPath);
                        } else if (entry.isFile()) {
                            size += fs.statSync(fullPath).size;
                        }
                    } catch (e) { /* skip inaccessible entry */ }
                }
            } catch (e) { /* directory not accessible */ }
            return size;
        };

        // Helper: sync sleep (ms), works on all platforms
        const syncSleep = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { /* spin */ }
        };

        // Helper: remove a path with retry (Windows may lock files briefly)
        const rmWithRetry = (targetPath) => {
            let bytes = 0;
            try {
                bytes = getDirSize(targetPath);
            } catch (e) { /* size check failed, still try to delete */ }

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (fs.existsSync(targetPath)) {
                        fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                    }
                    break; // success
                } catch (e) {
                    if (attempt < 2) {
                        syncSleep(200 * (attempt + 1));
                    } else {
                        console.error(`[ClearTrash] Failed to delete ${targetPath}: ${e.message}`);
                    }
                }
            }
            return bytes;
        };

        // Delete trash directories in profile root and Default/
        for (const trashDir of TRASH_DIRS) {
            // Check in profile root
            const rootPath = path.join(profileDir, trashDir);
            if (fs.existsSync(rootPath)) {
                profileFreedBytes += rmWithRetry(rootPath);
            }
            // Check in Default/ subfolder
            const defaultPath = path.join(profileDir, 'Default', trashDir);
            if (fs.existsSync(defaultPath)) {
                profileFreedBytes += rmWithRetry(defaultPath);
            }
        }

        // Delete specific trash files in Default/
        for (const trashFile of TRASH_FILES) {
            const filePath = path.join(profileDir, 'Default', trashFile);
            if (fs.existsSync(filePath)) {
                try {
                    const fileSize = fs.statSync(filePath).size;
                    fs.rmSync(filePath, { force: true, maxRetries: 3, retryDelay: 100 });
                    profileFreedBytes += fileSize;
                } catch (e) {
                    console.error(`[ClearTrash] Failed to delete ${filePath}: ${e.message}`);
                }
            }
        }

        totalFreedBytes += profileFreedBytes;
        const freedMB = (profileFreedBytes / (1024 * 1024)).toFixed(1);
        console.log(`[ClearTrash] ${profile.name}: freed ${freedMB} MB`);
        results.push({
            profileId,
            profileName: profile.name,
            freedBytes: profileFreedBytes,
            freedMB: parseFloat(freedMB),
        });
    }

    const totalMB = (totalFreedBytes / (1024 * 1024)).toFixed(1);
    console.log(`[ClearTrash] Total freed: ${totalMB} MB across ${profileIds.length} profile(s)`);
    res.json({
        success: true,
        totalFreedBytes,
        totalFreedMB: parseFloat(totalMB),
        results,
    });
});

// POST /api/system/clear-debug — Xóa debug PNG + truncate automation.log để giải phóng dung lượng
app.post('/api/system/clear-debug', (req, res) => {
    try {
        let freedBytes = 0;

        // Xóa tất cả file debug_*.png trong thư mục backend
        const backendDir = __dirname;
        const entries = fs.readdirSync(backendDir);
        let deletedFiles = 0;
        for (const entry of entries) {
            if (entry.startsWith('debug_') && entry.endsWith('.png')) {
                const filePath = path.join(backendDir, entry);
                try {
                    freedBytes += fs.statSync(filePath).size;
                    fs.rmSync(filePath, { force: true });
                    deletedFiles++;
                } catch (e) {
                    console.error(`[ClearDebug] Failed to delete ${filePath}: ${e.message}`);
                }
            }
        }

        // Truncate automation.log (xóa nội dung nhưng giữ file)
        const logPath = path.join(backendDir, 'automation.log');
        let logFreedBytes = 0;
        if (fs.existsSync(logPath)) {
            try {
                logFreedBytes = fs.statSync(logPath).size;
                fs.writeFileSync(logPath, `[${new Date().toISOString()}] Log cleared by user\n`);
                freedBytes += logFreedBytes;
                console.log(`[ClearDebug] Truncated automation.log (freed ${(logFreedBytes / 1024 / 1024).toFixed(1)} MB)`);
            } catch (e) {
                console.error(`[ClearDebug] Failed to truncate automation.log: ${e.message}`);
            }
        }

        const freedMB = (freedBytes / 1024 / 1024).toFixed(1);
        console.log(`[ClearDebug] Deleted ${deletedFiles} debug PNG files, freed ${freedMB} MB total`);
        res.json({
            success: true,
            deletedFiles,
            freedMB: parseFloat(freedMB),
            message: `Đã xóa ${deletedFiles} file debug và dọn log, giải phóng ${freedMB} MB`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/profiles/:id', (req, res) => {
    const { name, video_folder, proxy, is_scheduled, auto_increment_schedule, schedule_interval, set_music, use_favorite_music, upload_count, channel_ids, needs_render, remove_title, need_content_check, render_video_long, cookies, music_search, render_concat_video, avatar_image } = req.body;
    const profileId = req.params.id;

    // Check if profile exists
    const currentProfile = db.prepare('SELECT name FROM profiles WHERE id = ?').get(profileId);
    if (!currentProfile) return res.status(404).json({ error: 'Profile not found' });

    if ('group_id' in req.body) {
        const normalizedGroupId = normalizeGroupId(req.body.group_id);
        if (normalizedGroupId !== undefined) {
            try {
                // Also carries the video folder over to the new group.
                syncProfileFolderOnGroupChange(db, {
                    profileId,
                    groupId: normalizedGroupId,
                    uploadsDir: UPLOADS_DIR
                });
            } catch (err) {
                console.error('Move profile folder error:', err);
                return res
                    .status(err.status || 400)
                    .json({ error: err.message });
            }
        }
    }

    if (name !== undefined) {
        if (currentProfile.name !== name) {
            // Check if new name exists
            const existing = db.prepare('SELECT id FROM profiles WHERE name = ?').get(name);
            if (existing) return res.status(400).json({ error: 'Profile name already exists' });

            // Rename folder
            const oldPath = path.join(PROFILES_DIR, currentProfile.name);
            const newPath = path.join(PROFILES_DIR, name);
            try {
                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                    console.log(`Renamed profile folder from ${currentProfile.name} to ${name}`);
                }
                const result = db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, profileId);
                console.log(`Database update for name: ${result.changes} rows affected`);
            } catch (err) {
                console.error('Rename folder error:', err);
                return res.status(500).json({ error: 'Failed to rename profile directory' });
            }
        }
    }
    if (video_folder !== undefined) {
        db.prepare('UPDATE profiles SET video_folder = ? WHERE id = ?').run(video_folder, profileId);
    }
    if (proxy !== undefined) {
        db.prepare('UPDATE profiles SET proxy = ? WHERE id = ?').run(proxy, profileId);
    }
    if (is_scheduled !== undefined) {
        const val = is_scheduled ? 1 : 0;
        db.prepare('UPDATE profiles SET is_scheduled = ? WHERE id = ?').run(val, profileId);
    }
    if (use_favorite_music !== undefined) {
        db.prepare('UPDATE profiles SET use_favorite_music = ? WHERE id = ?')
            .run(use_favorite_music ? 1 : 0, profileId);
    }

    if (set_music !== undefined) {
        const val = set_music ? 1 : 0;
        db.prepare('UPDATE profiles SET set_music = ? WHERE id = ?').run(val, profileId);
    }
    if (auto_increment_schedule !== undefined) {
        const val = auto_increment_schedule ? 1 : 0;
        db.prepare('UPDATE profiles SET auto_increment_schedule = ? WHERE id = ?').run(val, profileId);
    }
    if (schedule_interval !== undefined) {
        const intervalNum = Number(schedule_interval);
        const val = [5, 10, 15, 20].includes(intervalNum) ? intervalNum : 5;
        db.prepare('UPDATE profiles SET schedule_interval = ? WHERE id = ?').run(val, profileId);
    }
    if (upload_count !== undefined) {
        db.prepare('UPDATE profiles SET upload_count = ? WHERE id = ?').run(upload_count, profileId);
    }
    if (channel_ids !== undefined) {
        db.prepare('UPDATE profiles SET channel_ids = ? WHERE id = ?').run(channel_ids, profileId);
    }
    if (needs_render !== undefined) {
        const val = needs_render ? 1 : 0;
        db.prepare('UPDATE profiles SET needs_render = ? WHERE id = ?').run(val, profileId);
    }
    if (remove_title !== undefined) {
        const val = remove_title ? 1 : 0;
        db.prepare('UPDATE profiles SET remove_title = ? WHERE id = ?').run(val, profileId);
    }
    if (need_content_check !== undefined) {
        const val = need_content_check ? 1 : 0;
        db.prepare('UPDATE profiles SET need_content_check = ? WHERE id = ?').run(val, profileId);
    }
    if (render_video_long !== undefined) {
        const val = render_video_long ? 1 : 0;
        db.prepare('UPDATE profiles SET render_video_long = ? WHERE id = ?').run(val, profileId);
    }
    if (render_concat_video !== undefined) {
        const val = render_concat_video ? 1 : 0;
        db.prepare('UPDATE profiles SET render_concat_video = ? WHERE id = ?').run(val, profileId);
    }
    if (avatar_image !== undefined) {
        db.prepare('UPDATE profiles SET avatar_image = ? WHERE id = ?').run(avatar_image, profileId);
    }
    if (cookies !== undefined) {
        db.prepare('UPDATE profiles SET cookies = ? WHERE id = ?').run(cookies, profileId);
    }
    if (music_search !== undefined) {
        db.prepare('UPDATE profiles SET music_search = ? WHERE id = ?').run(music_search, profileId);
    }

    res.json({ success: true });
});

app.get('/api/groups', (req, res) => {
    try {
        res.json(listGroups(db));
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

app.post('/api/groups', (req, res) => {
    try {
        const rawId = req.body.id;
        const id =
            typeof rawId === 'string' && rawId.trim() !== ''
                ? rawId.trim()
                : randomUUID();
        createGroup(db, { id, name: req.body.name });
        fs.mkdirSync(path.join(UPLOADS_DIR, getGroupById(db, id).name), {
            recursive: true
        });
        res.json({ success: true, id });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

app.patch('/api/groups/:id', (req, res) => {
    try {
        renameGroupWithFolder(db, {
            id: req.params.id,
            name: req.body.name,
            uploadsDir: UPLOADS_DIR
        });
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

app.delete('/api/groups/:id', (req, res) => {
    try {
        deleteGroup(db, req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
    }
});

// Ảnh avatar kênh đã quét. Phải nằm dưới /api vì vite chỉ proxy đúng tiền tố
// đó sang backend; đặt ở đường dẫn khác thì dev server trả về index.html.
app.get('/api/profiles/:id/avatar', (req, res) => {
    try {
        const row = db.prepare('SELECT channel_avatar FROM profiles WHERE id = ?').get(req.params.id);
        if (!row || !row.channel_avatar) return res.status(404).json({ error: 'No avatar scanned yet' });

        // basename() để một giá trị rác trong DB không leo ra khỏi thư mục avatar.
        const filePath = path.join(AVATARS_DIR, path.basename(row.channel_avatar));
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Avatar file is missing' });

        // Frontend gắn ?v=<channel_avatar_at> nên URL đổi mỗi lần quét lại; nhờ
        // vậy cache được lâu mà vẫn thấy ảnh mới ngay.
        res.set('Cache-Control', 'public, max-age=3600');
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/profiles/:id/schedules', (req, res) => {
    try {
        const schedules = db.prepare('SELECT time FROM profile_schedules WHERE profile_id = ? ORDER BY time ASC').all(req.params.id);
        res.json(schedules.map(s => s.time));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/profiles/:id/schedules', (req, res) => {
    const { times } = req.body; // Array of "HH:mm"
    if (!Array.isArray(times)) return res.status(400).json({ error: 'times must be an array' });

    try {
        db.transaction(() => {
            db.prepare('DELETE FROM profile_schedules WHERE profile_id = ?').run(req.params.id);
            const insert = db.prepare('INSERT INTO profile_schedules (profile_id, time) VALUES (?, ?)');
            for (const time of times) {
                if (/^\d{2}:\d{2}$/.test(time)) {
                    insert.run(req.params.id, time);
                }
            }
        })();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/config', (req, res) => {
    const rows = db.prepare('SELECT * FROM config').all();
    const config = {};
    rows.forEach(r => {
        // Convert to number if possible
        const val = r.value;
        config[r.key] = isNaN(val) ? val : Number(val);
    });
    res.json(config);
});

app.post('/api/select-folder', (req, res) => {
    let script = '';

    if (process.platform === 'darwin') {
        script = `osascript -e 'tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Select Video Folder")'`;
    } else if (process.platform === 'win32') {
        script = `powershell -Command "$app = New-Object -ComObject Shell.Application; $folder = $app.BrowseForFolder(0, 'Select Folder', 64); if ($folder) { $folder.Self.Path }"`;
    } else {
        return res.status(501).json({ error: 'Folder picker not supported on this platform' });
    }

    exec(script, (error, stdout, stderr) => {
        if (error) {
            console.error(`Folder picker error: ${error.message}`);
            return res.status(500).json({ error: 'Folder selection cancelled or failed' });
        }
        const selectedPath = stdout.trim();
        if (!selectedPath) return res.status(500).json({ error: 'No folder selected' });
        res.json({ path: selectedPath });
    });
});

app.post('/api/profiles/:id/open-folder', (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    if (!profile.video_folder) return res.status(400).json({ error: 'not_set' });
    if (!fs.existsSync(profile.video_folder)) return res.status(400).json({ error: 'missing' });

    const folder = profile.video_folder;
    let command = '';
    if (process.platform === 'darwin') {
        command = `open ${JSON.stringify(folder)}`;
    } else if (process.platform === 'win32') {
        command = `explorer ${JSON.stringify(folder)}`;
    } else {
        return res.status(501).json({ error: 'Open folder not supported on this platform' });
    }

    exec(command, (error) => {
        if (error) {
            console.error(`Open folder error: ${error.message}`);
            return res.status(500).json({ error: 'Failed to open folder' });
        }
        res.json({ success: true });
    });
});

app.post('/api/select-image-file', (req, res) => {
    let script = '';

    if (process.platform === 'darwin') {
        script = `osascript -e 'POSIX path of (choose file of type {"public.png","public.jpeg","com.compuserve.gif"} with prompt "Select Avatar Image")'`;
    } else if (process.platform === 'win32') {
        script = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; \\$dialog = New-Object System.Windows.Forms.OpenFileDialog; \\$dialog.Filter = 'Image Files (*.png;*.jpg;*.jpeg)|*.png;*.jpg;*.jpeg'; \\$dialog.Title = 'Select Avatar Image'; if (\\$dialog.ShowDialog() -eq 'OK') { \\$dialog.FileName }"`;
    } else {
        return res.status(501).json({ error: 'File picker not supported on this platform' });
    }

    exec(script, (error, stdout, stderr) => {
        if (error) {
            console.error(`Image file picker error: ${error.message}`);
            return res.status(500).json({ error: 'File selection cancelled or failed' });
        }
        const selectedPath = stdout.trim();
        if (!selectedPath) return res.status(500).json({ error: 'No file selected' });
        res.json({ path: selectedPath });
    });
});

app.post('/api/config', (req, res) => {
    Object.entries(req.body).forEach(([k, v]) => {
        if (k === 'postDelayEnabled') {
            return setConfig(k, v && String(v) !== '0' ? '1' : '0');
        }
        if (k === 'postDelayMinutes') {
            // Số phút ngoài khoảng TikTok chấp nhận bị kẹp lại; không đọc được
            // thì giữ nguyên giá trị cũ thay vì ghi NaN vào config.
            const minutes = normalizePostDelayMinutes(v);
            if (minutes === null) return;
            return setConfig(k, minutes);
        }
        // Khoá cũ từ thời tính bằng giờ: bỏ qua hẳn, nếu không một client cũ
        // còn gửi kèm postDelayHours sẽ ghi lại khoá đã được migration dọn đi.
        if (k === 'postDelayHours') return;
        setConfig(k, v);
    });
    res.json({ success: true });
});

function sanitizeToAscii(str) {
    if (!str) return '';
    // Normalize to decompose combined graphemes (removes Vietnamese accents)
    let sanitized = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // Replace custom letters like đ, Đ
    sanitized = sanitized.replace(/đ/g, 'd').replace(/Đ/g, 'D');
    // Keep only letters, digits, spaces, hyphens, and underscores
    sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-_]/g, '');
    // Clean spaces
    sanitized = sanitized.trim().replace(/\s+/g, ' ');
    return sanitized;
}

// Automation state - must be declared before any endpoint that uses them
const runningProfiles = new Set();
const processingProfiles = new Set();
const processingVideoIds = new Map(); // video_id -> profile.id currently processing that video
const manualBrowsers = new Map(); // profileId -> browserContext
const engagingProfiles = new Map(); // profileId -> { browser, stop: boolean }
const loggingInProfiles = new Map(); // profileId -> { browser, stop, stats }
const avatarChangingProfiles = new Set();
const addingFavoriteMusicProfiles = new Set(); // profileId set — prevents concurrent favorite music operations

app.post('/api/upload_new_video', async (req, res) => {
    const { video_id, channel_id, profile_id, profile_name } = req.body;

    if (!video_id || !channel_id) {
        return res.status(400).json({ error: 'Both video_id and channel_id are required' });
    }

    // Find profile
    let profile = null;
    if (profile_id) {
        profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile_id);
    } else if (profile_name) {
        profile = db.prepare('SELECT * FROM profiles WHERE name = ?').get(profile_name);
    }

    if (!profile) {
        // Fallback to channel_id lookup
        const profiles = db.prepare('SELECT * FROM profiles').all();
        profile = profiles.find(p => {
            if (!p.channel_ids) return false;
            const ids = p.channel_ids.split(',').map(id => id.trim());
            return ids.includes(channel_id.trim());
        });
    }

    if (!profile) {
        return res.status(404).json({ error: `No profile found managing channel ID: ${channel_id}` });
    }

    // Lock 1: Check if this exact video_id is already being processed
    if (processingVideoIds.has(video_id)) {
        console.log(`[${profile.name}] Duplicate request: video_id=${video_id} is already being processed.`);
        return res.status(400).json({ error: `Video ID '${video_id}' is already being processed. Please wait.` });
    }

    // Lock 2: Check if profile is already running automation or processing another video
    if (runningProfiles.has(profile.id) || processingProfiles.has(profile.id)) {
        return res.status(400).json({ error: `Profile '${profile.name}' is already running automation or processing a video` });
    }

    // Acquire both locks immediately
    processingVideoIds.set(video_id, profile.id);
    processingProfiles.add(profile.id);

    let downloadedFilePath = null;
    const activeProcesses = [];

    // Helper to spawn process safely
    const safeSpawn = (cmd, args, timeoutMs = 300000) => {
        const child = spawn(cmd, args);
        activeProcesses.push(child);

        let timeout = null;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                console.log(`[${profile.name}] Process '${cmd} ${args.join(' ')}' timed out after ${timeoutMs}ms. Killing it.`);
                try { child.kill('SIGKILL'); } catch (e) {}
            }, timeoutMs);
        }

        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            const idx = activeProcesses.indexOf(child);
            if (idx !== -1) activeProcesses.splice(idx, 1);
        };

        child.on('close', cleanup);
        child.on('error', cleanup);
        return child;
    };

    req.on('close', () => {
        if (activeProcesses.length > 0) {
            console.log(`[${profile.name}] Request closed/aborted. Killing ${activeProcesses.length} active process(es)...`);
            for (const child of activeProcesses) {
                try { child.kill('SIGKILL'); } catch (e) {}
            }
        }
    });

    try {

        // Determine destination folder
        const videoFolder = profile.video_folder || getConfig('videoFolder', UPLOADS_DIR);
        if (!fs.existsSync(videoFolder)) {
            fs.mkdirSync(videoFolder, { recursive: true });
        }

        // Ensure backgrounds folder exists
        const backgroundsFolder = path.join(__dirname, 'backgrounds');
        if (!fs.existsSync(backgroundsFolder)) {
            fs.mkdirSync(backgroundsFolder, { recursive: true });
        }

        // 1. Resolve the correct URL and Get Title
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        const cookieArgs = fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];

        let targetUrl = `https://youtube.com/shorts/${video_id}`;
        console.log(`[${profile.name}] Checking if video is a Short: ${targetUrl}`);
        
        let originalTitle = await new Promise((resolve) => {
            const child = safeSpawn('yt-dlp', ['--js-runtimes', `node:${process.execPath}`, '--get-title', '--no-playlist', ...cookieArgs, targetUrl]);
            let titleData = '';
            child.stdout.on('data', (data) => { titleData += data.toString(); });
            child.on('close', (code) => {
                if (code === 0 && titleData.trim()) resolve(titleData.trim());
                else resolve(null);
            });
            child.on('error', () => resolve(null));
        });

        if (!originalTitle) {
            // Fallback to long format
            targetUrl = `https://youtube.com/watch?v=${video_id}`;
            console.log(`[${profile.name}] Short not found. Falling back to Long video format: ${targetUrl}`);
            
            originalTitle = await new Promise((resolve) => {
                const child = safeSpawn('yt-dlp', ['--js-runtimes', `node:${process.execPath}`, '--get-title', '--no-playlist', ...cookieArgs, targetUrl]);
                let titleData = '';
                child.stdout.on('data', (data) => { titleData += data.toString(); });
                child.on('close', (code) => {
                    if (code === 0 && titleData.trim()) resolve(titleData.trim());
                    else resolve('video');
                });
                child.on('error', () => resolve('video'));
            });
        }

        console.log(`[${profile.name}] Original title retrieved: "${originalTitle}"`);
        const cleanTitle = sanitizeToAscii(originalTitle).substring(0, 80);
        const fileNameBase = cleanTitle || 'video';

        // Generate a 100% safe, clean ASCII filename containing original title
        const safeFileName = `${fileNameBase}_${Date.now()}_${randomUUID().slice(0, 8)}.mp4`;
        downloadedFilePath = path.join(videoFolder, safeFileName);

        console.log(`[${profile.name}] Starting yt-dlp download from: ${targetUrl} to: ${downloadedFilePath}`);

        // Download video using yt-dlp command line
        const downloadArgs = [
            '--js-runtimes', `node:${process.execPath}`,
            targetUrl,
            '-o', downloadedFilePath,
            '-f', 'bestvideo[height<=1080]+bestaudio/best/best',
            '--merge-output-format', 'mp4',
            '--no-playlist',
            ...cookieArgs
        ];

        await new Promise((resolve, reject) => {
            const child = safeSpawn('yt-dlp', downloadArgs);
            let stderrData = '';
            child.stdout.on('data', () => {}); // Consume stdout to prevent hanging
            child.stderr.on('data', (data) => { stderrData += data.toString(); });
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`yt-dlp exited with code ${code}. Stderr: ${stderrData}`));
            });
            child.on('error', (err) => { child.kill(); reject(err); });
        });

        console.log(`[${profile.name}] Video download complete via yt-dlp.`);

        // Check video duration - skip if less than 5 seconds
        let videoDuration = await new Promise((resolve) => {
            const ffprobe = safeSpawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                downloadedFilePath
            ]);
            let output = '';
            ffprobe.stdout.on('data', (data) => output += data.toString());
            ffprobe.on('close', () => {
                const dur = parseFloat(output.trim());
                resolve(isNaN(dur) ? 0 : dur);
            });
            ffprobe.on('error', () => resolve(0));
        });

        console.log(`[${profile.name}] Video duration: ${videoDuration.toFixed(2)}s`);

        if (videoDuration < 5.0) {
            console.log(`[${profile.name}] Video duration is under 5s (${videoDuration.toFixed(2)}s). Slowing down by factor 0.9.`);
            const speedFactor = 0.9;
            const slowedFilePath = downloadedFilePath.replace('.mp4', '_slowed.mp4');

            // Check if there is an audio stream to avoid mapping errors in ffmpeg
            const hasAudio = await new Promise((resolve) => {
                const ffprobe = safeSpawn('ffprobe', [
                    '-v', 'error',
                    '-select_streams', 'a',
                    '-show_entries', 'stream=codec_type',
                    '-of', 'csv=p=0',
                    downloadedFilePath
                ]);
                let output = '';
                ffprobe.stdout.on('data', (data) => output += data.toString());
                ffprobe.on('close', () => resolve(output.trim() === 'audio'));
                ffprobe.on('error', () => resolve(false));
            });

            const ffmpegArgs = [
                '-y',
                '-i', downloadedFilePath,
                '-filter_complex', hasAudio ? `[0:v]setpts=PTS/${speedFactor}[v];[0:a]atempo=${speedFactor}[a]` : `[0:v]setpts=PTS/${speedFactor}[v]`,
                '-map', '[v]'
            ];
            if (hasAudio) ffmpegArgs.push('-map', '[a]');
            ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', slowedFilePath);

            try {
                await new Promise((resolve, reject) => {
                    const ffmpegProcess = safeSpawn('ffmpeg', ffmpegArgs);
                    ffmpegProcess.on('close', (code) => {
                        if (code === 0) resolve(true);
                        else reject(new Error(`ffmpeg exited with code ${code}`));
                    });
                    ffmpegProcess.on('error', (err) => reject(err));
                });
                if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
                fs.renameSync(slowedFilePath, downloadedFilePath);
                console.log(`[${profile.name}] Successfully slowed down video.`);
                
                // Re-measure duration
                videoDuration = await new Promise((resolve) => {
                    const ffprobe = safeSpawn('ffprobe', [
                        '-v', 'error',
                        '-show_entries', 'format=duration',
                        '-of', 'default=noprint_wrappers=1:nokey=1',
                        downloadedFilePath
                    ]);
                    let output = '';
                    ffprobe.stdout.on('data', (data) => output += data.toString());
                    ffprobe.on('close', () => {
                        const dur = parseFloat(output.trim());
                        resolve(isNaN(dur) ? 0 : dur);
                    });
                    ffprobe.on('error', () => resolve(0));
                });
                console.log(`[${profile.name}] Duration after slowing down: ${videoDuration.toFixed(2)}s`);
            } catch (err) {
                console.error(`[${profile.name}] Failed to slow down video:`, err.message);
                if (fs.existsSync(slowedFilePath)) {
                    try { fs.unlinkSync(slowedFilePath); } catch (e) {}
                }
            }
        }

        // If still under 5 seconds, pad it by appending a random slice of itself
        if (videoDuration < 5.0 && videoDuration > 0) {
            const neededDuration = 5.1 - videoDuration;
            console.log(`[${profile.name}] Video duration still under 5s (${videoDuration.toFixed(2)}s). Appending a random chunk of ${neededDuration.toFixed(2)}s.`);

            // Ensure needed duration does not exceed the video's actual duration (if it does, we will just slice the whole video)
            const sliceDuration = Math.min(neededDuration, videoDuration);
            // Choose a random start position for the slice
            const maxStart = Math.max(0, videoDuration - sliceDuration);
            const startPos = Math.random() * maxStart;

            const slicePath = downloadedFilePath.replace('.mp4', '_slice.mp4');
            const concatFilePath = downloadedFilePath.replace('.mp4', '_concat.mp4');
            const listFilePath = downloadedFilePath.replace('.mp4', '_list.txt');

            try {
                // Extract the slice
                await new Promise((resolve, reject) => {
                    const sliceArgs = [
                        '-y',
                        '-ss', startPos.toString(),
                        '-t', sliceDuration.toString(),
                        '-i', downloadedFilePath,
                        '-c', 'copy',
                        slicePath
                    ];
                    const child = safeSpawn('ffmpeg', sliceArgs);
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Extract slice exited with code ${code}`));
                    });
                    child.on('error', reject);
                });

                // Generate concat list file. ffmpeg concat filter/demuxer requires full paths or relative to execution directory.
                // We use paths safe for windows/ffmpeg.
                const fileContent = `file '${downloadedFilePath.replace(/\\/g, '/')}'\nfile '${slicePath.replace(/\\/g, '/')}'\n`;
                fs.writeFileSync(listFilePath, fileContent);

                // Concatenate original and slice
                await new Promise((resolve, reject) => {
                    const concatArgs = [
                        '-y',
                        '-f', 'concat',
                        '-safe', '0',
                        '-i', listFilePath,
                        '-c', 'copy',
                        concatFilePath
                    ];
                    const child = safeSpawn('ffmpeg', concatArgs);
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Concat exited with code ${code}`));
                    });
                    child.on('error', reject);
                });

                // Clean up and swap files
                if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
                fs.renameSync(concatFilePath, downloadedFilePath);
                console.log(`[${profile.name}] Successfully padded video to over 5s.`);

                // Re-measure final duration
                videoDuration = await new Promise((resolve) => {
                    const ffprobe = safeSpawn('ffprobe', [
                        '-v', 'error',
                        '-show_entries', 'format=duration',
                        '-of', 'default=noprint_wrappers=1:nokey=1',
                        downloadedFilePath
                    ]);
                    let output = '';
                    ffprobe.stdout.on('data', (data) => output += data.toString());
                    ffprobe.on('close', () => {
                        const dur = parseFloat(output.trim());
                        resolve(isNaN(dur) ? 0 : dur);
                    });
                    ffprobe.on('error', () => resolve(0));
                });
                console.log(`[${profile.name}] Final video duration: ${videoDuration.toFixed(2)}s`);

            } catch (err) {
                console.error(`[${profile.name}] Failed to pad video:`, err.message);
                if (fs.existsSync(concatFilePath)) {
                    try { fs.unlinkSync(concatFilePath); } catch (e) {}
                }
            } finally {
                // Clean up temporary files
                if (fs.existsSync(slicePath)) {
                    try { fs.unlinkSync(slicePath); } catch (e) {}
                }
                if (fs.existsSync(listFilePath)) {
                    try { fs.unlinkSync(listFilePath); } catch (e) {}
                }
            }
        }

        // Re-fetch profile to get the latest settings in case the user changed them during a long download
        const latestProfile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id);
        if (latestProfile) profile = latestProfile;

        // Check if render is needed based on profile configuration
        let forceUploadAll = false;
        if (profile.render_video_long !== 0 && profile.render_video_long !== undefined) {
            console.log(`[${profile.name}] Starting long render pipeline (render-then-upload per segment)...`);
            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';

            // Step 1: Get video info (duration + segment count) without rendering
            const videoInfo = await new Promise((resolve) => {
                const child = safeSpawn(pythonBinary, [
                    path.join(__dirname, 'render_long.py'),
                    '--video', downloadedFilePath,
                    '--title', originalTitle || 'Video',
                    '--info-only'
                ]);
                let out = '';
                child.stdout.on('data', d => out += d.toString());
                child.stderr.on('data', d => console.error(`[${profile.name}][render_long info stderr] ${d.toString().trim()}`));
                child.on('close', () => {
                    const info = {};
                    out.split('\n').forEach(line => {
                        const [key, val] = line.trim().split(':');
                        if (key === 'DURATION') info.totalDuration = parseFloat(val);
                        if (key === 'NUM_SEGMENTS') info.numSegments = parseInt(val);
                        if (key === 'SEGMENT_DURATION') info.segmentDuration = parseFloat(val);
                    });
                    resolve(info);
                });
                child.on('error', err => {
                    console.error(`[${profile.name}] render_long.py info error:`, err.message);
                    resolve({});
                });
            });

            const totalDuration = videoInfo.totalDuration || 0;
            const numSegments = videoInfo.numSegments || 1;
            const segmentDuration = videoInfo.segmentDuration || 120;
            const baseName = path.basename(downloadedFilePath, path.extname(downloadedFilePath));

            console.log(`[${profile.name}] Video: ${totalDuration.toFixed(1)}s → ${numSegments} segment(s), ${segmentDuration}s each`);

            // Respond to client BEFORE starting the long render+upload process
            res.json({
                success: true,
                message: `Video downloaded. Starting render+upload for ${numSegments} segment(s)...`,
                profile: profile.name,
                profileId: profile.id,
                filePath: downloadedFilePath
            });

            // Run render+upload in background (do not await — already responded)
            (async () => {
                try {
                    for (let i = 0; i < numSegments; i++) {
                        const startTime = i * segmentDuration;
                        const duration = Math.min(segmentDuration, totalDuration - startTime);
                        const outputFile = path.join(videoFolder, `${baseName}_part${i + 1}.mp4`);

                        console.log(`[${profile.name}] Rendering segment ${i + 1}/${numSegments}: ${outputFile}`);

                        // Render single segment
                        await new Promise((resolve) => {
                            const child = safeSpawn(pythonBinary, [
                                path.join(__dirname, 'render_long.py'),
                                '--video', downloadedFilePath,
                                '--title', originalTitle || 'Video',
                                '--start-time', String(startTime),
                                '--duration', String(duration),
                                '--output', outputFile
                            ]);
                            child.stdout.on('data', d => console.log(`[${profile.name}][render_long] ${d.toString().trim()}`));
                            child.stderr.on('data', d => console.error(`[${profile.name}][render_long stderr] ${d.toString().trim()}`));
                            child.on('close', (code) => {
                                if (code !== 0) console.warn(`[${profile.name}] Segment ${i + 1} render exited with code ${code}`);
                                resolve();
                            });
                            child.on('error', (err) => {
                                console.error(`[${profile.name}] Segment ${i + 1} spawn error:`, err.message);
                                resolve();
                            });
                        });

                        // Check if output file was created
                        if (!fs.existsSync(outputFile)) {
                            console.error(`[${profile.name}] Segment ${i + 1} output not found, skipping upload for this part.`);
                            continue;
                        }

                        console.log(`[${profile.name}] Segment ${i + 1} rendered. Uploading immediately...`);

                        // Upload this single segment immediately (opens and closes browser each time)
                        await runSingleProfile(profile, false, 0, false, outputFile);

                        console.log(`[${profile.name}] Segment ${i + 1}/${numSegments} upload done.`);
                    }

                    // Delete original downloaded video after all segments are done
                    if (fs.existsSync(downloadedFilePath)) {
                        fs.unlinkSync(downloadedFilePath);
                        console.log(`[${profile.name}] Original video deleted after all segments processed.`);
                    }
                } catch (bgErr) {
                    console.error(`[${profile.name}] Background render+upload error:`, bgErr.message);
                }
            })();

            // Skip the rest of the handler (already responded and launched background job)
            return;

        } else if (profile.render_concat_video !== 0 && profile.render_concat_video !== undefined) {
            const renderedFilePath = path.join(videoFolder, `rendered_${safeFileName}`);
            console.log(`[${profile.name}] Starting concat render: ${downloadedFilePath} -> ${renderedFilePath}`);

            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';
            const concatVideosFolder = path.join(__dirname, '..', 'concat_videos');

            if (!fs.existsSync(concatVideosFolder)) {
                fs.mkdirSync(concatVideosFolder, { recursive: true });
            }

            const concatArgs = [
                path.join(__dirname, 'concat.py'),
                '--video', downloadedFilePath,
                '--concat-dir', concatVideosFolder,
                '--output', renderedFilePath
            ];

            await new Promise((resolve, reject) => {
                const child = safeSpawn(pythonBinary, concatArgs);
                let stdoutData = '';
                let stderrData = '';
                child.stdout.on('data', (data) => stdoutData += data.toString());
                child.stderr.on('data', (data) => stderrData += data.toString());
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`concat.py exited with code ${code}. Stderr: ${stderrData}`));
                });
                child.on('error', (err) => { child.kill(); reject(err); });
            });

            console.log(`[${profile.name}] Concat render complete. Replacing original downloaded video file...`);
            if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
            fs.renameSync(renderedFilePath, downloadedFilePath);
            console.log(`[${profile.name}] Video fully replaced with concat-rendered version.`);
        } else if (profile.needs_render !== 0) {
            const renderedFilePath = path.join(videoFolder, `rendered_${safeFileName}`);
            console.log(`[${profile.name}] Starting render pipeline via render.py: ${downloadedFilePath} -> ${renderedFilePath}`);

            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';
            const renderArgs = [
                path.join(__dirname, 'render.py'),
                '--video', downloadedFilePath,
                '--backgrounds', backgroundsFolder,
                '--output', renderedFilePath
            ];

            await new Promise((resolve, reject) => {
                const child = safeSpawn(pythonBinary, renderArgs);
                let stdoutData = '';
                let stderrData = '';
                child.stdout.on('data', (data) => stdoutData += data.toString());
                child.stderr.on('data', (data) => stderrData += data.toString());
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`render.py exited with code ${code}. Stderr: ${stderrData}`));
                });
                child.on('error', (err) => { child.kill(); reject(err); });
            });

            console.log(`[${profile.name}] Render complete. Replacing original downloaded video file...`);
            if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
            fs.renameSync(renderedFilePath, downloadedFilePath);
            console.log(`[${profile.name}] Video fully replaced with bypass-rendered version.`);
        } else {
            console.log(`[${profile.name}] Bypass Render is enabled for this profile. Skipping render pipeline.`);
        }

        // Respond immediately before triggering the browser automation
        res.json({
            success: true,
            message: 'Video downloaded and processed. Upload automation starting...',
            profile: profile.name,
            profileId: profile.id,
            filePath: downloadedFilePath
        });

        // Trigger upload in background AFTER responding
        // processingProfiles lock is released only here - after download+render is fully done
        // runSingleProfile will manage runningProfiles internally
        console.log(`[${profile.name}] Triggering runSingleProfile now (forceUploadAll=${forceUploadAll})...`);
        runSingleProfile(profile, false, 0, forceUploadAll);

    } catch (error) {
        console.error('Error in /api/upload_new_video:', error.message);
        // Clean up partially downloaded file if it exists
        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            try { fs.unlinkSync(downloadedFilePath); } catch (e) {}
        }
        // Only send error response if headers not sent yet
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to process video: ${error.message}` });
        }
    } finally {
        // Always release both locks when download+render phase is done
        processingProfiles.delete(profile.id);
        processingVideoIds.delete(video_id);
        console.log(`[${profile.name}] Processing lock released for video_id=${video_id}`);
    }
});

app.post('/api/upload-profile', async (req, res) => {
    const { profile_name, video_url } = req.body;

    if (!profile_name) {
        return res.status(400).json({ error: 'profile_name is required' });
    }

    // Find profile by name
    const profile = db.prepare('SELECT * FROM profiles WHERE name = ?').get(profile_name);
    if (!profile) {
        return res.status(404).json({ error: `Profile not found: ${profile_name}` });
    }

    // Lock: Check if profile is already running automation or processing
    if (runningProfiles.has(profile.id) || processingProfiles.has(profile.id)) {
        return res.status(400).json({ error: `Profile '${profile.name}' is already running automation or processing a video` });
    }

    // Acquire lock
    processingProfiles.add(profile.id);

    let downloadedFilePath = null;
    const activeProcesses = [];

    const safeSpawn = (cmd, args, timeoutMs = 300000) => {
        const child = spawn(cmd, args);
        activeProcesses.push(child);

        let timeout = null;
        if (timeoutMs > 0) {
            timeout = setTimeout(() => {
                console.log(`[${profile.name}] Process '${cmd} ${args.join(' ')}' timed out after ${timeoutMs}ms. Killing it.`);
                try { child.kill('SIGKILL'); } catch (e) {}
            }, timeoutMs);
        }

        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            const idx = activeProcesses.indexOf(child);
            if (idx !== -1) activeProcesses.splice(idx, 1);
        };

        child.on('close', cleanup);
        child.on('error', cleanup);
        return child;
    };

    req.on('close', () => {
        if (activeProcesses.length > 0) {
            console.log(`[${profile.name}] Request closed/aborted. Killing ${activeProcesses.length} active process(es)...`);
            for (const child of activeProcesses) {
                try { child.kill('SIGKILL'); } catch (e) {}
            }
        }
    });

    try {
        // Determine destination folder
        const videoFolder = profile.video_folder || getConfig('videoFolder', UPLOADS_DIR);
        if (!fs.existsSync(videoFolder)) {
            fs.mkdirSync(videoFolder, { recursive: true });
        }

        // Ensure backgrounds folder exists (for render pipeline)
        const backgroundsFolder = path.join(__dirname, 'backgrounds');
        if (!fs.existsSync(backgroundsFolder)) {
            fs.mkdirSync(backgroundsFolder, { recursive: true });
        }

        // Detect if the URL is a YouTube link
        const isYouTube = /(?:youtube\.com\/(?:shorts\/|watch\?v=|embed\/|v\/)|youtu\.be\/)/.test(video_url);

        let baseName = 'video';
        const fileExt = '.mp4';
        let safeFileName;

        if (!video_url) {
            // --- No video_url: pick a video from the profile's upload folder ---
            const videoFiles = fs.readdirSync(videoFolder).filter(f => {
                const ext = path.extname(f).toLowerCase();
                return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
            });

            if (videoFiles.length === 0) {
                throw new Error(`No video files found in folder: ${videoFolder}`);
            }

            // Pick the first available video
            const pickedFile = videoFiles[0];
            downloadedFilePath = path.join(videoFolder, pickedFile);
            const pickedExt = path.extname(pickedFile);
            baseName = path.basename(pickedFile, pickedExt);
            safeFileName = pickedFile;
            console.log(`[${profile.name}] No video_url provided. Using local video: ${downloadedFilePath}`);

        } else if (isYouTube) {
            // --- YouTube download via yt-dlp ---
            // Extract video_id from URL
            const ytMatch = video_url.match(/(?:youtube\.com\/(?:shorts\/|watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
            const videoId = ytMatch ? ytMatch[1] : null;

            const cookiesPath = path.join(__dirname, 'cookies.txt');
            const cookieArgs = fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];

            // Try Shorts format first, then fallback to long format
            let targetUrl = videoId ? `https://youtube.com/shorts/${videoId}` : video_url;
            console.log(`[${profile.name}] YouTube detected. Checking if video is a Short: ${targetUrl}`);

            let originalTitle = await new Promise((resolve) => {
                const child = safeSpawn('yt-dlp', ['--js-runtimes', `node:${process.execPath}`, '--get-title', '--no-playlist', ...cookieArgs, targetUrl]);
                let titleData = '';
                child.stdout.on('data', (data) => { titleData += data.toString(); });
                child.on('close', (code) => {
                    if (code === 0 && titleData.trim()) resolve(titleData.trim());
                    else resolve(null);
                });
                child.on('error', () => resolve(null));
            });

            if (!originalTitle && videoId) {
                targetUrl = `https://youtube.com/watch?v=${videoId}`;
                console.log(`[${profile.name}] Short not found. Falling back to Long video format: ${targetUrl}`);
                originalTitle = await new Promise((resolve) => {
                    const child = safeSpawn('yt-dlp', ['--js-runtimes', `node:${process.execPath}`, '--get-title', '--no-playlist', ...cookieArgs, targetUrl]);
                    let titleData = '';
                    child.stdout.on('data', (data) => { titleData += data.toString(); });
                    child.on('close', (code) => {
                        if (code === 0 && titleData.trim()) resolve(titleData.trim());
                        else resolve('video');
                    });
                    child.on('error', () => resolve('video'));
                });
            }

            console.log(`[${profile.name}] Original title: "${originalTitle}"`);
            const cleanTitle = sanitizeToAscii(originalTitle || 'video').substring(0, 80);
            baseName = cleanTitle || 'video';
            safeFileName = `${baseName}_${Date.now()}_${randomUUID().slice(0, 8)}${fileExt}`;
            downloadedFilePath = path.join(videoFolder, safeFileName);

            console.log(`[${profile.name}] Starting yt-dlp download to: ${downloadedFilePath}`);

            const downloadArgs = [
                '--js-runtimes', `node:${process.execPath}`,
                targetUrl,
                '-o', downloadedFilePath,
                '-f', 'bestvideo[height<=1080]+bestaudio/best/best',
                '--merge-output-format', 'mp4',
                '--no-playlist',
                ...cookieArgs
            ];

            await new Promise((resolve, reject) => {
                const child = safeSpawn('yt-dlp', downloadArgs);
                let stderrData = '';
                child.stdout.on('data', () => {});
                child.stderr.on('data', (data) => { stderrData += data.toString(); });
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`yt-dlp exited with code ${code}. Stderr: ${stderrData}`));
                });
                child.on('error', (err) => { child.kill(); reject(err); });
            });

            console.log(`[${profile.name}] YouTube download complete via yt-dlp.`);

        } else {
            // --- Direct URL download via HTTP stream (R2, etc.) ---
            const urlBasename = path.basename(new URL(video_url).pathname) || 'video.mp4';
            const ext = path.extname(urlBasename).toLowerCase();
            baseName = path.basename(urlBasename, ext) || 'video';
            safeFileName = `${baseName}_${Date.now()}_${randomUUID().slice(0, 8)}${ext || fileExt}`;
            downloadedFilePath = path.join(videoFolder, safeFileName);

            console.log(`[${profile.name}] Direct URL detected. Downloading via HTTP from: ${video_url} to: ${downloadedFilePath}`);

            const httpResponse = await axios({
                method: 'GET',
                url: video_url,
                responseType: 'stream',
                timeout: 600000, // 10 min timeout for large files
            });

            const writer = fs.createWriteStream(downloadedFilePath);
            httpResponse.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', (err) => {
                    console.error(`[${profile.name}] Write stream error:`, err.message);
                    reject(err);
                });
                httpResponse.data.on('error', (err) => {
                    console.error(`[${profile.name}] Download stream error:`, err.message);
                    reject(err);
                });
            });

            console.log(`[${profile.name}] HTTP download complete.`);
        }

        // Check video duration - skip if less than 5 seconds
        let videoDuration = await new Promise((resolve) => {
            const ffprobe = safeSpawn('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                downloadedFilePath
            ]);
            let output = '';
            ffprobe.stdout.on('data', (data) => output += data.toString());
            ffprobe.on('close', () => {
                const dur = parseFloat(output.trim());
                resolve(isNaN(dur) ? 0 : dur);
            });
            ffprobe.on('error', () => resolve(0));
        });

        console.log(`[${profile.name}] Video duration: ${videoDuration.toFixed(2)}s`);

        if (videoDuration < 5.0) {
            console.log(`[${profile.name}] Video duration is under 5s (${videoDuration.toFixed(2)}s). Slowing down by factor 0.9.`);
            const speedFactor = 0.9;
            const slowedFilePath = downloadedFilePath.replace('.mp4', '_slowed.mp4');

            // Check if there is an audio stream
            const hasAudio = await new Promise((resolve) => {
                const ffprobe = safeSpawn('ffprobe', [
                    '-v', 'error',
                    '-select_streams', 'a',
                    '-show_entries', 'stream=codec_type',
                    '-of', 'csv=p=0',
                    downloadedFilePath
                ]);
                let output = '';
                ffprobe.stdout.on('data', (data) => output += data.toString());
                ffprobe.on('close', () => resolve(output.trim() === 'audio'));
                ffprobe.on('error', () => resolve(false));
            });

            const ffmpegArgs = [
                '-y',
                '-i', downloadedFilePath,
                '-filter_complex', hasAudio ? `[0:v]setpts=PTS/${speedFactor}[v];[0:a]atempo=${speedFactor}[a]` : `[0:v]setpts=PTS/${speedFactor}[v]`,
                '-map', '[v]'
            ];
            if (hasAudio) ffmpegArgs.push('-map', '[a]');
            ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', slowedFilePath);

            try {
                await new Promise((resolve, reject) => {
                    const ffmpegProcess = safeSpawn('ffmpeg', ffmpegArgs);
                    ffmpegProcess.on('close', (code) => {
                        if (code === 0) resolve(true);
                        else reject(new Error(`ffmpeg exited with code ${code}`));
                    });
                    ffmpegProcess.on('error', (err) => reject(err));
                });
                if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
                fs.renameSync(slowedFilePath, downloadedFilePath);
                console.log(`[${profile.name}] Successfully slowed down video.`);

                // Re-measure duration
                videoDuration = await new Promise((resolve) => {
                    const ffprobe = safeSpawn('ffprobe', [
                        '-v', 'error',
                        '-show_entries', 'format=duration',
                        '-of', 'default=noprint_wrappers=1:nokey=1',
                        downloadedFilePath
                    ]);
                    let output = '';
                    ffprobe.stdout.on('data', (data) => output += data.toString());
                    ffprobe.on('close', () => {
                        const dur = parseFloat(output.trim());
                        resolve(isNaN(dur) ? 0 : dur);
                    });
                    ffprobe.on('error', () => resolve(0));
                });
                console.log(`[${profile.name}] Duration after slowing down: ${videoDuration.toFixed(2)}s`);
            } catch (err) {
                console.error(`[${profile.name}] Failed to slow down video:`, err.message);
                if (fs.existsSync(slowedFilePath)) {
                    try { fs.unlinkSync(slowedFilePath); } catch (e) {}
                }
            }
        }

        // If still under 5 seconds, pad it by appending a random slice of itself
        if (videoDuration < 5.0 && videoDuration > 0) {
            const neededDuration = 5.1 - videoDuration;
            console.log(`[${profile.name}] Video duration still under 5s (${videoDuration.toFixed(2)}s). Appending a random chunk of ${neededDuration.toFixed(2)}s.`);

            const sliceDuration = Math.min(neededDuration, videoDuration);
            const maxStart = Math.max(0, videoDuration - sliceDuration);
            const startPos = Math.random() * maxStart;

            const slicePath = downloadedFilePath.replace('.mp4', '_slice.mp4');
            const concatFilePath = downloadedFilePath.replace('.mp4', '_concat.mp4');
            const listFilePath = downloadedFilePath.replace('.mp4', '_list.txt');

            try {
                // Extract the slice
                await new Promise((resolve, reject) => {
                    const sliceArgs = [
                        '-y',
                        '-ss', startPos.toString(),
                        '-t', sliceDuration.toString(),
                        '-i', downloadedFilePath,
                        '-c', 'copy',
                        slicePath
                    ];
                    const child = safeSpawn('ffmpeg', sliceArgs);
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Extract slice exited with code ${code}`));
                    });
                    child.on('error', reject);
                });

                // Generate concat list file
                const fileContent = `file '${downloadedFilePath.replace(/\\/g, '/')}'\nfile '${slicePath.replace(/\\/g, '/')}'\n`;
                fs.writeFileSync(listFilePath, fileContent);

                // Concatenate original and slice
                await new Promise((resolve, reject) => {
                    const concatArgs = [
                        '-y',
                        '-f', 'concat',
                        '-safe', '0',
                        '-i', listFilePath,
                        '-c', 'copy',
                        concatFilePath
                    ];
                    const child = safeSpawn('ffmpeg', concatArgs);
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Concat exited with code ${code}`));
                    });
                    child.on('error', reject);
                });

                // Clean up and swap files
                if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
                fs.renameSync(concatFilePath, downloadedFilePath);
                console.log(`[${profile.name}] Successfully padded video to over 5s.`);

                // Re-measure final duration
                videoDuration = await new Promise((resolve) => {
                    const ffprobe = safeSpawn('ffprobe', [
                        '-v', 'error',
                        '-show_entries', 'format=duration',
                        '-of', 'default=noprint_wrappers=1:nokey=1',
                        downloadedFilePath
                    ]);
                    let output = '';
                    ffprobe.stdout.on('data', (data) => output += data.toString());
                    ffprobe.on('close', () => {
                        const dur = parseFloat(output.trim());
                        resolve(isNaN(dur) ? 0 : dur);
                    });
                    ffprobe.on('error', () => resolve(0));
                });
                console.log(`[${profile.name}] Final video duration: ${videoDuration.toFixed(2)}s`);

            } catch (err) {
                console.error(`[${profile.name}] Failed to pad video:`, err.message);
                if (fs.existsSync(concatFilePath)) {
                    try { fs.unlinkSync(concatFilePath); } catch (e) {}
                }
            } finally {
                // Clean up temporary files
                if (fs.existsSync(slicePath)) {
                    try { fs.unlinkSync(slicePath); } catch (e) {}
                }
                if (fs.existsSync(listFilePath)) {
                    try { fs.unlinkSync(listFilePath); } catch (e) {}
                }
            }
        }

        // Re-fetch profile to get the latest settings
        const latestProfile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id);
        const currentProfile = latestProfile || profile;

        // Check if render is needed based on profile configuration
        if (currentProfile.render_video_long !== 0 && currentProfile.render_video_long !== undefined) {
            console.log(`[${currentProfile.name}] Starting long render pipeline (render-then-upload per segment)...`);
            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';

            // Step 1: Get video info (duration + segment count) without rendering
            const videoInfo = await new Promise((resolve) => {
                const child = safeSpawn(pythonBinary, [
                    path.join(__dirname, 'render_long.py'),
                    '--video', downloadedFilePath,
                    '--title', baseName,
                    '--info-only'
                ]);
                let out = '';
                child.stdout.on('data', d => out += d.toString());
                child.stderr.on('data', d => console.error(`[${currentProfile.name}][render_long info stderr] ${d.toString().trim()}`));
                child.on('close', () => {
                    const info = {};
                    out.split('\n').forEach(line => {
                        const [key, val] = line.trim().split(':');
                        if (key === 'DURATION') info.totalDuration = parseFloat(val);
                        if (key === 'NUM_SEGMENTS') info.numSegments = parseInt(val);
                        if (key === 'SEGMENT_DURATION') info.segmentDuration = parseFloat(val);
                    });
                    resolve(info);
                });
                child.on('error', err => {
                    console.error(`[${currentProfile.name}] render_long.py info error:`, err.message);
                    resolve({});
                });
            });

            const totalDuration = videoInfo.totalDuration || 0;
            const numSegments = videoInfo.numSegments || 1;
            const segmentDuration = videoInfo.segmentDuration || 120;

            console.log(`[${currentProfile.name}] Video: ${totalDuration.toFixed(1)}s → ${numSegments} segment(s), ${segmentDuration}s each`);

            // Respond to client BEFORE starting the long render+upload process
            res.json({
                success: true,
                message: `Video downloaded. Starting render+upload for ${numSegments} segment(s)...`,
                profile: currentProfile.name,
                profileId: currentProfile.id,
                filePath: downloadedFilePath
            });

            // Run render+upload in background
            (async () => {
                try {
                    for (let i = 0; i < numSegments; i++) {
                        const startTime = i * segmentDuration;
                        const duration = Math.min(segmentDuration, totalDuration - startTime);
                        const outputFile = path.join(videoFolder, `${baseName}_part${i + 1}.mp4`);

                        console.log(`[${currentProfile.name}] Rendering segment ${i + 1}/${numSegments}: ${outputFile}`);

                        // Render single segment
                        await new Promise((resolve) => {
                            const child = safeSpawn(pythonBinary, [
                                path.join(__dirname, 'render_long.py'),
                                '--video', downloadedFilePath,
                                '--title', baseName,
                                '--start-time', String(startTime),
                                '--duration', String(duration),
                                '--output', outputFile
                            ]);
                            child.stdout.on('data', d => console.log(`[${currentProfile.name}][render_long] ${d.toString().trim()}`));
                            child.stderr.on('data', d => console.error(`[${currentProfile.name}][render_long stderr] ${d.toString().trim()}`));
                            child.on('close', (code) => {
                                if (code !== 0) console.warn(`[${currentProfile.name}] Segment ${i + 1} render exited with code ${code}`);
                                resolve();
                            });
                            child.on('error', (err) => {
                                console.error(`[${currentProfile.name}] Segment ${i + 1} spawn error:`, err.message);
                                resolve();
                            });
                        });

                        // Check if output file was created
                        if (!fs.existsSync(outputFile)) {
                            console.error(`[${currentProfile.name}] Segment ${i + 1} output not found, skipping upload for this part.`);
                            continue;
                        }

                        console.log(`[${currentProfile.name}] Segment ${i + 1} rendered. Uploading immediately...`);

                        // Upload this single segment immediately
                        await runSingleProfile(currentProfile, false, 0, false, outputFile);

                        console.log(`[${currentProfile.name}] Segment ${i + 1}/${numSegments} upload done.`);
                    }

                    // Delete original downloaded video after all segments are done
                    if (fs.existsSync(downloadedFilePath)) {
                        fs.unlinkSync(downloadedFilePath);
                        console.log(`[${currentProfile.name}] Original video deleted after all segments processed.`);
                    }
                } catch (bgErr) {
                    console.error(`[${currentProfile.name}] Background render+upload error:`, bgErr.message);
                }
            })();

            // Skip the rest of the handler (already responded and launched background job)
            return;

        } else if (currentProfile.render_concat_video !== 0 && currentProfile.render_concat_video !== undefined) {
            const renderedFilePath = path.join(videoFolder, `rendered_${safeFileName}`);
            console.log(`[${currentProfile.name}] Starting concat render: ${downloadedFilePath} -> ${renderedFilePath}`);

            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';
            const concatVideosFolder = path.join(__dirname, '..', 'concat_videos');

            if (!fs.existsSync(concatVideosFolder)) {
                fs.mkdirSync(concatVideosFolder, { recursive: true });
            }

            const concatArgs = [
                path.join(__dirname, 'concat.py'),
                '--video', downloadedFilePath,
                '--concat-dir', concatVideosFolder,
                '--output', renderedFilePath
            ];

            await new Promise((resolve, reject) => {
                const child = safeSpawn(pythonBinary, concatArgs);
                let stdoutData = '';
                let stderrData = '';
                child.stdout.on('data', (data) => stdoutData += data.toString());
                child.stderr.on('data', (data) => stderrData += data.toString());
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`concat.py exited with code ${code}. Stderr: ${stderrData}`));
                });
                child.on('error', (err) => { child.kill(); reject(err); });
            });

            console.log(`[${currentProfile.name}] Concat render complete. Replacing original downloaded video file...`);
            if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
            fs.renameSync(renderedFilePath, downloadedFilePath);
            console.log(`[${currentProfile.name}] Video fully replaced with concat-rendered version.`);
        } else if (currentProfile.needs_render !== 0) {
            const renderedFilePath = path.join(videoFolder, `rendered_${safeFileName}`);
            console.log(`[${currentProfile.name}] Starting render pipeline via render.py: ${downloadedFilePath} -> ${renderedFilePath}`);

            const pythonBinary = process.platform === 'win32' ? 'python' : 'python3';
            const renderArgs = [
                path.join(__dirname, 'render.py'),
                '--video', downloadedFilePath,
                '--backgrounds', backgroundsFolder,
                '--output', renderedFilePath
            ];

            await new Promise((resolve, reject) => {
                const child = safeSpawn(pythonBinary, renderArgs);
                let stdoutData = '';
                let stderrData = '';
                child.stdout.on('data', (data) => stdoutData += data.toString());
                child.stderr.on('data', (data) => stderrData += data.toString());
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`render.py exited with code ${code}. Stderr: ${stderrData}`));
                });
                child.on('error', (err) => { child.kill(); reject(err); });
            });

            console.log(`[${currentProfile.name}] Render complete. Replacing original downloaded video file...`);
            if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);
            fs.renameSync(renderedFilePath, downloadedFilePath);
            console.log(`[${currentProfile.name}] Video fully replaced with bypass-rendered version.`);
        } else {
            console.log(`[${currentProfile.name}] Bypass Render is enabled for this profile. Skipping render pipeline.`);
        }

        // Respond immediately before triggering the browser automation
        res.json({
            success: true,
            message: 'Video downloaded and processed. Upload automation starting...',
            profile: currentProfile.name,
            profileId: currentProfile.id,
            filePath: downloadedFilePath
        });

        // Trigger upload in background AFTER responding
        console.log(`[${currentProfile.name}] Triggering runSingleProfile now...`);
        runSingleProfile(currentProfile, false, 0, false, downloadedFilePath);

    } catch (error) {
        console.error(`Error in /api/upload-profile:`, error.message);
        // Clean up partially downloaded file if it exists
        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            try { fs.unlinkSync(downloadedFilePath); } catch (e) {}
        }
        // Only send error response if headers not sent yet
        if (!res.headersSent) {
            res.status(500).json({ error: `Failed to process video: ${error.message}` });
        }
    } finally {
        // Always release lock
        processingProfiles.delete(profile.id);
        console.log(`[${profile.name}] Processing lock released for upload-profile`);
    }
});

// Automation Trigger (declarations moved to before /api/upload_new_video)


app.post('/api/start', async (req, res) => {
    const { profileId, profileIds, runMode, limitUploads, uploadLimitCount } = req.body;

    if (profileId) {
        const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        // Đang xếp hàng KHÔNG phải lý do từ chối ở đây -- bấm START chính là để
        // vượt hàng. Chỉ chặn khi trình duyệt của profile đó đang thật sự chạy.
        if (runningProfiles.has(profileId) || processingProfiles.has(profileId)) {
            return res.status(400).json({ error: 'Profile already running or processing a video' });
        }

        const { videos, missing } = listProfileVideos(profile);
        if (missing || videos.length === 0) {
            const reason = missing ? 'no_folder' : 'no_videos';
            return res.status(400).json({
                error: missing
                    ? `Không tìm thấy thư mục video của ${profile.name}`
                    : `${profile.name} không còn video nào trong thư mục`,
                skipped: [{ id: profile.id, name: profile.name, reason }]
            });
        }

        startProfileNow(profile, !!limitUploads, Number(uploadLimitCount) || 0);
        return res.json({ status: 'started', profile: profile.name, skipped: [] });
    } else {
        const allRows = db.prepare('SELECT * FROM profiles').all();
        let profiles = allRows;
        if (Array.isArray(profileIds) && profileIds.length > 0) {
            const byId = new Map(allRows.map((p) => [String(p.id), p]));
            profiles = profileIds.map((id) => byId.get(String(id))).filter(Boolean);
            if (profiles.length === 0) {
                return res.status(400).json({ error: 'No matching profiles for the given selection' });
            }
        }
        const { runnable, skipped } = partitionRunnable(profiles);
        if (runnable.length === 0) {
            const emptyOnes = skipped.filter((s) => s.reason === 'no_videos' || s.reason === 'no_folder');
            return res.status(400).json({
                error:
                    emptyOnes.length > 0
                        ? 'Không profile nào trong lựa chọn còn video để đăng'
                        : Array.isArray(profileIds) && profileIds.length > 0
                            ? 'No idle profiles in selection (they may already be running)'
                            : 'No idle profiles',
                skipped
            });
        }

        const mode = runMode === 'sequential' ? 'sequential' : 'parallel';
        if (mode === 'sequential') {
            runAllSequential(runnable, !!limitUploads, Number(uploadLimitCount) || 0).catch((err) => console.error('Sequential execution error:', err));
        } else {
            runAllParallel(runnable, !!limitUploads, Number(uploadLimitCount) || 0);
        }
        return res.json({ status: 'started', count: runnable.length, runMode: mode, skipped });
    }
});

app.post('/api/open-profile', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'Profile ID is required' });

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (runningProfiles.has(profileId) || processingProfiles.has(profileId) || queuedProfileIds.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently running automation or processing a video' });
    }

    if (manualBrowsers.has(profileId)) {
        return res.json({ status: 'already_open', message: 'Browser is already open' });
    }

    try {
        const userDataDir = path.join(PROFILES_DIR, profile.name);
        const browserOptions = {
            headless: false,
            args: [
                '--disable-blink-features=AutomationControlled'
            ]
        };

        if (profile.proxy) {
            const proxyConfig = parseProxy(profile.proxy);
            if (proxyConfig) {
                browserOptions.proxy = proxyConfig;
                console.log(`[${profile.name}] Using proxy: ${proxyConfig.server}${proxyConfig.username ? ' (with auth)' : ''}`);
            }
        }

        const browser = await chromium.launchPersistentContext(userDataDir, browserOptions);
        await injectProfileCookies(browser, profile);
        manualBrowsers.set(profileId, browser);

        browser.on('close', () => {
            manualBrowsers.delete(profileId);
            console.log(`[${profile.name}] Manual browser closed`);
        });

        const page = await browser.newPage();
        await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' }).catch(() => null);

        res.json({ status: 'opened', profile: profile.name });
    } catch (error) {
        console.error(`[${profile.name}] Failed to open browser:`, error);
        res.status(500).json({ error: `Failed to open browser: ${error.message}` });
    }
});

async function changeAvatar(profile, avatarImage) {
    const profileId = profile.id;
    const userDataDir = path.join(PROFILES_DIR, profile.name);

    const log = (msg) => {
        const entry = `[${new Date().toISOString()}] [${profile.name}][AVATAR] ${msg}\n`;
        console.log(entry.trim());
        try {
            fs.appendFileSync(path.join(__dirname, 'automation.log'), entry);
        } catch (e) {}
    };

    const browserOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    };
    if (profile.proxy) {
        const proxyConfig = parseProxy(profile.proxy);
        if (proxyConfig) browserOptions.proxy = proxyConfig;
    }

    const browser = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await injectProfileCookies(browser, profile);
    avatarChangingProfiles.add(profileId);
    db.prepare("UPDATE profiles SET status = ? WHERE id = ?").run('changing_avatar', profileId);

    log('Avatar change session started');

    try {
        const page = await browser.newPage();

        // Step 1: Navigate to TikTok and find the user's profile URL
        log('Navigating to TikTok...');
        await page.goto('https://www.tiktok.com', { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Try to get the profile link from the page
        let profileUrl = null;
        try {
            // Look for the profile link in the sidebar/header
            const profileLink = await page.waitForSelector('a[href*="/@"]', { timeout: 10000 });
            const href = await profileLink.getAttribute('href');
            profileUrl = href ? new URL(href, 'https://www.tiktok.com').href : null;
            log(`Found profile link: ${profileUrl}`);
        } catch (e) {
            log(`Could not find profile link: ${e.message}`);
        }

        // If no profile URL found, try clicking profile icon then View profile
        if (!profileUrl) {
            log('Trying profile menu approach...');
            try {
                const profileBtn = await page.waitForSelector('#header-profile-avatar, [data-e2e="profile-icon"]', { timeout: 5000 });
                await profileBtn.click();
                await page.waitForTimeout(2000);
                const viewLink = await page.waitForSelector(':text("View profile")', { timeout: 5000 });
                await viewLink.click();
                await page.waitForTimeout(4000);
                profileUrl = page.url();
                log(`Profile URL from menu: ${profileUrl}`);
            } catch (e) {
                log(`Profile menu approach failed: ${e.message}`);
            }
        }

        // Navigate to profile page if we have a URL and aren't already there
        if (profileUrl && !page.url().includes('/@')) {
            await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(4000);
        }

        log(`On page: ${page.url()}`);

        // Step 2: Click "Edit profile" button
        let editBtn = null;
        try {
            editBtn = await page.waitForSelector(':text("Edit profile")', { timeout: 10000 });
        } catch (e) {
            log(`Edit profile not found: ${e.message}`);
        }

        if (editBtn) {
            await editBtn.click();
            log('Clicked Edit profile');
            await page.waitForTimeout(4000);
        } else {
            const bodyText = await page.evaluate(() => (document.body.innerText || '').substring(0, 500));
            log(`Page text: ${bodyText}`);
            return;
        }

        // Step 3: Upload avatar image via file input
        // TikTok's file input is usually hidden; try visible first, then fall back to hidden
        let fileInput = null;
        try {
            fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000, state: 'visible' });
        } catch (e) {
            log(`Visible file input not found, trying hidden: ${e.message}`);
        }
        if (!fileInput) {
            try {
                fileInput = await page.waitForSelector('input[type="file"]', { timeout: 5000 });
                if (fileInput) log('Found hidden file input');
            } catch (e) {
                log(`No file input at all: ${e.message}`);
            }
        }

        if (!fileInput) {
            log('ERROR: Cannot find file input to upload avatar');
            return;
        }

        await fileInput.setInputFiles(avatarImage);
        log(`Uploaded avatar: ${avatarImage}`);
        await page.waitForTimeout(4000);

        // Step 4: Handle crop/zoom modal if it appears
        // TikTok may show a crop/zoom dialog with an "Apply" or "Confirm" button
        const applySelectors = [
            'button:has-text("Apply")',
            'div:has-text("Apply")',
            'span:has-text("Apply")',
            '[role="button"]:has-text("Apply")',
        ];
        let applyClicked = false;
        for (const sel of applySelectors) {
            try {
                const btn = await page.waitForSelector(sel, { timeout: 5000 });
                if (btn) {
                    const isVisible = await btn.isVisible();
                    if (isVisible) {
                        await btn.click({ force: true });
                        log(`Clicked Apply via selector: ${sel}`);
                        applyClicked = true;
                        await page.waitForTimeout(3000);
                        break;
                    }
                }
            } catch (e) {
                // Try next selector
            }
        }
        if (!applyClicked) {
            log('No crop/Apply modal appeared, proceeding to Save');
        }

        // Step 5: Click Save in edit profile modal
        const saveSelectors = [
            'button:has-text("Save")',
            '[role="button"]:has-text("Save")',
            'div[role="dialog"] button:has-text("Save")',
        ];
        let saveClicked = false;
        for (const sel of saveSelectors) {
            try {
                const btn = await page.waitForSelector(sel, { timeout: 8000 });
                if (btn) {
                    const isVisible = await btn.isVisible();
                    if (isVisible) {
                        await btn.click({ force: true });
                        log(`Clicked Save via selector: ${sel}`);
                        saveClicked = true;
                        await page.waitForTimeout(4000);
                        break;
                    }
                }
            } catch (e) {
                // Try next selector
            }
        }
        if (!saveClicked) {
            log('WARNING: Save button not found or not clickable');
        }

        log('Avatar change flow completed');
    } catch (err) {
        log(`Avatar change error: ${err.message}`);
        throw err;
    } finally {
        avatarChangingProfiles.delete(profileId);
        await browser.close().catch(() => null);
        db.prepare("UPDATE profiles SET status = 'idle' WHERE id = ?").run(profileId);
        log('Avatar change session ended, browser closed.');
    }
}

app.post('/api/change-avatar', async (req, res) => {
    const { profileId, avatarImage } = req.body;
    if (!profileId) return res.status(400).json({ error: 'Profile ID is required' });
    if (!avatarImage) return res.status(400).json({ error: 'No avatar image provided' });

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (runningProfiles.has(profileId) || processingProfiles.has(profileId) || queuedProfileIds.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently running automation or processing a video' });
    }

    if (avatarChangingProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is already changing avatar' });
    }

    if (!fs.existsSync(avatarImage)) {
        return res.status(400).json({ error: `Avatar image not found: ${avatarImage}` });
    }

    res.json({ status: 'started', profile: profile.name });

    // Run async
    changeAvatar(profile, avatarImage).catch((err) => {
        console.error(`[${profile.name}] Avatar change failed:`, err.message);
    });
});


/**
 * Lưu yêu thích lần lượt từng bài trong danh sách nhạc của profile.
 *
 * Cả danh sách đi chung một phiên trình duyệt: mở trang upload, đẩy một video
 * mồi lên rồi mở panel Sounds đúng một lần, sau đó với mỗi bài thì xoá ô tìm
 * kiếm, gõ tên bài mới và bấm sao ở kết quả đầu. Khâu đợi video mồi xử lý xong
 * mất tới vài phút, nên mở lại phiên cho từng bài sẽ tốn gấp nhiều lần.
 */
async function addFavoriteMusic(profile, searchTerms) {
    const profileId = profile.id;
    const userDataDir = path.join(PROFILES_DIR, profile.name);

    const log = (msg) => {
        const entry = `[${new Date().toISOString()}] [${profile.name}][FAV-MUSIC] ${msg}\n`;
        console.log(entry.trim());
        try {
            fs.appendFileSync(path.join(__dirname, 'automation.log'), entry);
        } catch (e) {}
    };

    // Find a dummy video to upload
    let videoPath = null;
    try {
        const dummyFiles = fs.readdirSync(DUMMY_VIDEOS_DIR).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext);
        });
        if (dummyFiles.length === 0) {
            log('ERROR: No video found in dummy_videos folder. Please add a video file to dummy_videos/');
            return;
        }
        videoPath = path.join(DUMMY_VIDEOS_DIR, dummyFiles[0]);
        log(`Using dummy video: ${dummyFiles[0]}`);
    } catch (e) {
        log(`ERROR reading dummy_videos folder: ${e.message}`);
        return;
    }

    const browserOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    };
    if (profile.proxy) {
        const proxyConfig = parseProxy(profile.proxy);
        if (proxyConfig) browserOptions.proxy = proxyConfig;
    }

    const browser = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await injectProfileCookies(browser, profile);
    addingFavoriteMusicProfiles.add(profileId);
    db.prepare("UPDATE profiles SET status = ? WHERE id = ?").run('adding_favorite_music', profileId);

    log(`Favoriting ${searchTerms.length} song(s): ${searchTerms.map((t) => `"${t}"`).join(', ')}`);

    try {
        const page = await browser.newPage();

        // Step 1: Navigate to upload page
        log('Navigating to upload page...');
        let initialized = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                for (let poll = 0; poll < 30; poll++) {
                    const hasInput = await page.locator('input[type="file"]').count().then(c => c > 0).catch(() => false);
                    const hasButton = await page.locator('button.upload-stage-btn, .upload-stage-btn, [data-e2e="upload-video-button"]').count().then(c => c > 0).catch(() => false);

                    if (hasButton || hasInput) {
                        log('Upload page components detected.');
                        initialized = true;
                        break;
                    }
                    await page.waitForTimeout(1000);
                }
                if (initialized) break;
            } catch (e) {
                log(`Attempt ${attempt} failed: ${e.message}`);
            }
        }

        if (!initialized) {
            log('ERROR: Upload page components not found.');
            return;
        }

        // Step 2: Upload the dummy video
        log('Uploading dummy video...');
        let uploaded = false;

        // Strategy 1: Intercept filechooser via upload button
        const uploadButtonSelectors = [
            '[data-e2e="upload-video-button"]',
            'button.upload-stage-btn',
            'button:has-text("Select videos")',
            '.upload-stage-btn',
            'button[class*="upload"]'
        ];
        for (const sel of uploadButtonSelectors) {
            try {
                const el = await page.waitForSelector(sel, { timeout: 200, state: 'visible' }).catch(() => null);
                if (el) {
                    log(`Found upload button: ${sel}. Intercepting filechooser...`);
                    const [fileChooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 20000 }),
                        el.click()
                    ]);
                    await fileChooser.setFiles(videoPath);
                    log('Video file selected via upload button.');
                    uploaded = true;
                    break;
                }
            } catch (e) {}
        }

        // Strategy 2: Unhide file input and setInputFiles
        if (!uploaded) {
            log('Strategy 2: unhide input and setInputFiles...');
            try {
                await page.evaluate(() => {
                    const input = document.querySelector('input[type="file"]');
                    if (input) {
                        input.style.display = 'block';
                        input.style.visibility = 'visible';
                        input.style.opacity = '1';
                        input.style.position = 'fixed';
                        input.style.top = '0';
                        input.style.left = '0';
                        input.style.zIndex = '99999';
                    }
                });
                await page.waitForTimeout(500);
                const [fileChooser] = await Promise.all([
                    page.waitForEvent('filechooser', { timeout: 5000 }),
                    page.click('input[type="file"]')
                ]);
                await fileChooser.setFiles(videoPath);
                log('Video file selected via Strategy 2.');
                uploaded = true;
            } catch (e) {}
        }

        if (!uploaded) {
            log('ERROR: Could not upload dummy video.');
            return;
        }

        // Step 3: Wait for upload UI to appear, then wait for processing to complete
        // TikTok now requires video processing to finish before the edit sound button is enabled
        log('Waiting for upload UI components...');
        try {
            await page.waitForSelector('button[data-button-name="sounds"], button:has-text("Post"), button:has-text("Cancel")', { timeout: 120000 });
            log('Upload UI detected. Waiting for video processing to complete...');
        } catch (e) {
            log(`Upload UI did not appear: ${e.message}`);
        }

        // Wait for upload to complete (Cancel button detaches)
        try {
            const cancelBtn = page.locator('button:has-text("Cancel")');
            await cancelBtn.waitFor({ state: 'detached', timeout: 20 * 60 * 1000 });
            log('Upload complete (Cancel button gone). Waiting for processing...');
            await page.waitForTimeout(3000);
        } catch (e) {
            log(`Wait for upload completion timed out or failed: ${e.message}`);
        }

        // Step 4: Wait for sounds button to be enabled (processing complete) then click
        log('Waiting for Sounds button to become enabled (processing complete)...');
        let soundsBtn = null;
        try {
            soundsBtn = await page.waitForSelector(
                'button[data-button-name="sounds"]:not([disabled])',
                { timeout: 300000, state: 'visible' }
            );
            log('Video processing complete — sounds button is now enabled.');
        } catch (e) {
            log(`Sounds button did not become enabled directly: ${e.message}`);
            // Try clicking Edit video first to reveal the sounds button
            try {
                const editBtn = await page.$('button:has-text("Edit video"), button:has-text("Edit")');
                if (editBtn && await editBtn.isVisible()) {
                    log('Clicking Edit Video first...');
                    await editBtn.click();
                    await page.waitForTimeout(3000);
                    soundsBtn = await page.waitForSelector(
                        'button[data-button-name="sounds"]:not([disabled])',
                        { timeout: 60000, state: 'visible' }
                    ).catch(() => null);
                }
            } catch (e2) {
                log(`Edit video approach failed: ${e2.message}`);
            }
        }

        if (!soundsBtn) {
            log('ERROR: Sounds button not found or still disabled after processing wait');
            await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_sounds.png`) }).catch(() => null);
            return;
        }

        log('Clicking enabled Sounds button...');
        await soundsBtn.click();

        // Step 5: Wait for search input to appear in Sounds panel (no hardcoded wait)
        log('Waiting for search input to appear in Sounds panel...');
        await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_sounds_panel.png`) }).catch(() => null);

        const searchInputSelectors = [
            'input[placeholder="Search sounds"]',
            'input[placeholder*="sound" i]',
            'input[placeholder*="music" i]',
        ];

        let searchInput = null;
        for (let i = 0; i < 30; i++) {
            for (const sel of searchInputSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        searchInput = el;
                        log(`Found search input via: ${sel}`);
                        break;
                    }
                } catch (err) {}
            }
            if (searchInput) break;
            await page.waitForTimeout(1000);
        }

        if (!searchInput) {
            log('ERROR: Search input not found in Sounds panel');
            await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_search.png`) }).catch(() => null);
            return;
        }

        log('Sounds panel ready. Waiting 4 seconds for UI stability before typing...');
        await page.waitForTimeout(4000);

        // Step 6: Lưu yêu thích từng bài, dùng lại panel Sounds đang mở.
        // Một bài hỏng — không ra kết quả, không bấm được sao — chỉ làm hỏng
        // bài đó; vòng lặp vẫn chạy tiếp để những bài còn lại được lưu.
        let favorited = 0;
        const notFavorited = [];
        for (let songIndex = 0; songIndex < searchTerms.length; songIndex++) {
            const searchTerm = searchTerms[songIndex];
            const label = `[${songIndex + 1}/${searchTerms.length}]`;
            log(`${label} Setting search term: "${searchTerm}"`);

            // Xoá từ khoá của bài trước. Bài đầu tiên ô vẫn trống nên bước này
            // không đổi gì, giữ chung một đường đi cho mọi bài.
            const clearBtn = await page.$('[data-icon="x-circle-fill"], svg[data-icon="x-circle-fill"]').catch(() => null);
            if (clearBtn) {
                await clearBtn.click().catch(() => null);
            } else {
                await searchInput.focus().catch(() => null);
                await searchInput.click({ clickCount: 3 }).catch(() => null);
                await page.keyboard.press('Backspace').catch(() => null);
            }
            await page.waitForTimeout(1000);

            await searchInput.focus();
            await searchInput.click();
            await page.keyboard.type(searchTerm, { delay: 30 });
            log(`${label} Search term filled, waiting for suggestions...`);
            await page.waitForTimeout(2000);

            await page.keyboard.press('Enter');
            log(`${label} Enter pressed, waiting for new search results to load...`);

            // Wait a moment for TikTok to switch to loading state
            await page.waitForTimeout(1000);

            try {
                await page.waitForSelector('div[role="listitem"][data-item-id]', { timeout: 30000 });
                log(`${label} Search results refreshed.`);
            } catch (e) {
                log(`${label} Wait for search results timed out or failed. Proceeding anyway...`);
            }
            await page.waitForTimeout(2000); // Short stabilization wait after refresh

            // Step 7: Click star/bookmark on first search result
            // The star button is hidden until real mouse hover — use Playwright's native hover() (not JS dispatchEvent)
            // which triggers React's synthetic event system properly
            log(`${label} Reading search results...`);
            await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_search_results_${songIndex + 1}.png`) }).catch(() => null);

            // Đối chiếu tên bài và tên ca sĩ trước khi bấm sao, đúng như khâu
            // chọn nhạc lúc upload. Lấy bừa kết quả đầu là favorite nhầm bài
            // của ca sĩ khác — TikTok trả về đầy bài trùng tên. Sai ở đây còn
            // độc hơn: nhánh "chọn nhạc từ Favorites" lấy theo VỊ TRÍ chứ không
            // đối chiếu gì, nên một bài nhầm nằm trong mục yêu thích sẽ được
            // dùng đi dùng lại mà không có gì chặn.
            const results = await readSoundItems(page);
            if (results.length === 0) {
                log(`${label} WARNING: no search result for "${searchTerm}". Skipping this song.`);
                await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_results_${songIndex + 1}.png`) }).catch(() => null);
                notFavorited.push(`${searchTerm} (no results)`);
                continue;
            }

            const match = results.find((it) => musicEntryMatches(searchTerm, it.title, it.desc));
            if (!match) {
                const seen = results.slice(0, 5).map((it) => `"${it.title}" — ${it.desc}`).join(' | ');
                log(`${label} WARNING: no result matches "${searchTerm}" by title and artist. Skipping rather than favoriting the wrong song. Saw: ${seen}`);
                await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_match_${songIndex + 1}.png`) }).catch(() => null);
                notFavorited.push(`${searchTerm} (no match)`);
                continue;
            }

            log(`${label} Matched result #${match.index + 1}: "${match.title}" — ${match.desc}`);

            // Nút sao chỉ hiện khi chuột thật rê lên, nên phải dùng hover() của
            // Playwright chứ không phải dispatchEvent bằng JS.
            const target = (await page.$$('div[role="listitem"][data-item-id]'))[match.index];
            if (!target) {
                log(`${label} WARNING: result #${match.index + 1} disappeared before it could be favorited.`);
                notFavorited.push(`${searchTerm} (result vanished)`);
                continue;
            }
            await target.hover();
            await page.waitForTimeout(1500);

            // Nút sao nằm trong MusicPanelMusicItem__operation, cạnh nút cộng.
            const starClicked = await page.evaluate((idx) => {
                const item = document.querySelectorAll('div[role="listitem"][data-item-id]')[idx];
                if (!item) return 'no_item';

                const opDiv = item.querySelector('[class*="operation"]');
                if (!opDiv) return 'no_operation';

                const buttons = opDiv.querySelectorAll('button');
                for (const btn of buttons) {
                    // Bỏ qua nút cộng — đó là nút gắn nhạc, không phải nút sao.
                    if (btn.querySelector('[data-icon="plus-bold"]')) continue;
                    btn.click();
                    return 'clicked';
                }

                const icons = opDiv.querySelectorAll('[data-icon]');
                for (const icon of icons) {
                    const name = icon.getAttribute('data-icon') || '';
                    if (name && name !== 'plus-bold' && name !== 'Loading' && name !== 'center') {
                        const btn = icon.closest('button');
                        if (btn) { btn.click(); return 'clicked_icon_' + name; }
                    }
                }

                const btnInfo = Array.from(buttons).map(b => ({
                    text: b.textContent?.trim() || '',
                    aria: b.getAttribute('aria-label') || '',
                    icons: Array.from(b.querySelectorAll('[data-icon]')).map(i => i.getAttribute('data-icon'))
                }));
                return 'no_star_btn_' + JSON.stringify(btnInfo);
            }, match.index);

            log(`${label} Star click result: ${starClicked}`);

            if (starClicked.startsWith('clicked')) {
                favorited++;
                log(`${label} Favorited "${match.title}" — ${match.desc}`);
            } else {
                log(`${label} WARNING: Could not click star for "${searchTerm}" — ${starClicked}`);
                await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_star_${songIndex + 1}.png`) }).catch(() => null);
                notFavorited.push(`${searchTerm} (star not clickable)`);
            }

            await page.waitForTimeout(2000);
        }

        log(`Favorite music flow completed: ${favorited}/${searchTerms.length} song(s) favorited`);
        if (notFavorited.length) {
            // Nói rõ bài nào trượt: thiếu bài nào trong mục yêu thích là điều
            // phải biết TRƯỚC khi bật "chọn nhạc từ Favorites", vì nhánh đó lấy
            // theo vị trí và sẽ lệch nếu danh sách không đủ như mong đợi.
            log(`NOT favorited (${notFavorited.length}): ${notFavorited.join(' | ')}`);
        }
    } catch (err) {
        log(`Favorite music error: ${err.message}`);
        throw err;
    } finally {
        addingFavoriteMusicProfiles.delete(profileId);
        await browser.close().catch(() => null);
        db.prepare("UPDATE profiles SET status = 'idle' WHERE id = ?").run(profileId);
        log('Favorite music session ended, browser closed.');
    }
}

app.post('/api/add-favorite-music', async (req, res) => {
    const { profileId, searchTerm } = req.body;
    if (!profileId) return res.status(400).json({ error: 'Profile ID is required' });

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Danh sách gửi lên được ưu tiên hơn cột trong DB, vì người dùng có thể vừa
    // sửa ô nhạc rồi bấm ngay, trước khi lượt lưu tự động kịp hoàn tất.
    const requested = parseMusicList(searchTerm);
    const searchTerms = requested.length > 0 ? requested : parseMusicList(profile.music_search);
    if (searchTerms.length === 0) return res.status(400).json({ error: 'Search term is required' });

    if (runningProfiles.has(profileId) || processingProfiles.has(profileId) || queuedProfileIds.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently running automation or processing a video' });
    }

    if (avatarChangingProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently changing avatar' });
    }

    if (addingFavoriteMusicProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is already adding favorite music' });
    }

    res.json({ status: 'started', profile: profile.name });

    // Run async — fire and forget
    addFavoriteMusic(profile, searchTerms).catch((err) => {
        console.error(`[${profile.name}] Add favorite music failed:`, err.message);
    });
});


const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm']);

// Đọc thư mục video của một profile. runSingleProfile và khâu kiểm tra trước khi
// xếp hàng đều đi qua hàm này, để danh sách "bị bỏ vì hết video" báo lên giao
// diện không bao giờ lệch với thứ mà lượt chạy thật sự nhìn thấy.
function listProfileVideos(profile) {
    const folder = profile.video_folder || getConfig('videoFolder', UPLOADS_DIR);
    if (!fs.existsSync(folder)) return { folder, videos: [], missing: true };
    try {
        const videos = fs.readdirSync(folder).filter((file) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()));
        return { folder, videos, missing: false };
    } catch (e) {
        console.error(`[${profile.name}] Folder error:`, e.message);
        return { folder, videos: [], missing: false, error: e.message };
    }
}

// Video đăng xong được chuyển vào kho lưu thay vì xoá hẳn. Kho nằm NGOÀI thư
// mục video, gom theo kênh rồi tới ngày: old_videos/<kênh>/<ngày>/<file>. Mở
// thư mục một kênh là thấy hôm nào kênh đó đã đăng những bài nào, và vì kho
// không nằm trong thư mục video nên lượt chạy sau không bao giờ nhặt lại chúng.
//
// Chỗ đặt kho là TẠM THỜI theo yêu cầu: hiện gửi sang dự án tiktok_receiver.
// Đổi chỗ mà không phải sửa code thì ghi khoá `archiveFolder` qua
// POST /api/config; giá trị dưới đây chỉ là mặc định khi khoá đó chưa có.
const DEFAULT_ARCHIVE_DIR = path.join(os.homedir(), 'tiktok_receiver', 'old_videos');

// Tên kênh đi thẳng vào đường dẫn nên phải chặn ký tự tách thư mục: một profile
// đặt tên có dấu "/" sẽ khiến file rơi ra ngoài kho thay vì tạo thư mục con.
function safeFolderName(name) {
    const cleaned = String(name || '').replace(/[/\\]/g, '_').trim();
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'unknown' : cleaned;
}

function archiveFolderForProfile(profileName, when = new Date()) {
    const root = getConfig('archiveFolder', DEFAULT_ARCHIVE_DIR);
    const day = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
    return path.join(root, safeFolderName(profileName), day);
}

// Trả về đường dẫn file trong kho, hoặc ném lỗi cho phía gọi ghi log. Trùng tên
// thì thêm hậu tố chứ không đè: file đang nằm trong kho cũng là video thật đã
// đăng, đè lên là mất hẳn.
function archiveUploadedVideo(videoPath, profileName) {
    const destDir = archiveFolderForProfile(profileName);
    fs.mkdirSync(destDir, { recursive: true });

    const ext = path.extname(videoPath);
    const base = path.basename(videoPath, ext);
    let dest = path.join(destDir, `${base}${ext}`);
    for (let n = 2; fs.existsSync(dest); n++) {
        dest = path.join(destDir, `${base}_${n}${ext}`);
    }

    try {
        fs.renameSync(videoPath, dest);
    } catch (err) {
        // Kho giờ nằm ngoài thư mục video nên hai bên hoàn toàn có thể khác ổ
        // đĩa, mà rename(2) không qua được ranh giới ổ; chép rồi xoá là đường
        // duy nhất còn lại.
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(videoPath, dest);
        fs.unlinkSync(videoPath);
    }
    return dest;
}

// Một hàng đợi đăng duy nhất cho MỌI đường vào: nút chạy hàng loạt lẫn nút START
// trên từng card. Trước đây mỗi lần bấm dựng một hàng đợi riêng với biến đếm
// riêng, nên bấm START vài card liên tiếp là mở vượt maxConcurrency trình duyệt
// cùng lúc -- đúng cảnh 4 Chromium chạy song song trong khi cấu hình để 3.
const uploadQueue = [];
const queuedProfileIds = new Set();
let activeUploadCount = 0;

const setProfileStatus = (id, status) => db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run(status, id);

function pumpUploadQueue() {
    const maxConcurrency = Math.max(1, Number(getConfig('maxConcurrency', 2)) || 1);
    while (activeUploadCount < maxConcurrency && uploadQueue.length > 0) {
        const job = uploadQueue.shift();
        queuedProfileIds.delete(job.profile.id);
        activeUploadCount++;
        runSingleProfile(job.profile, job.limitUploads, job.uploadLimitCount)
            .catch((err) => console.error(`[${job.profile.name}] Upload job failed:`, err))
            .finally(() => {
                activeUploadCount--;
                if (job.onDone) job.onDone();
                pumpUploadQueue();
            });
    }
}

function dequeueProfile(id) {
    const index = uploadQueue.findIndex((job) => job.profile.id === id);
    if (index === -1) return null;
    const [job] = uploadQueue.splice(index, 1);
    queuedProfileIds.delete(id);
    return job;
}

// Nút START trên từng card là quyền ưu tiên của người dùng: mở trình duyệt NGAY,
// kể cả khi hàng đợi đã kín slot. Đây đúng là việc anh ấy cần khi đang có mấy
// profile nằm chờ mà muốn đẩy một kênh lên chạy trước.
//
// Vẫn cộng vào activeUploadCount, nên hàng đợi tự chùng lại một slot: lượt chạy
// tự động không chồng thêm trình duyệt lên trên cú bấm tay, và tổng số tự về
// đúng maxConcurrency ngay khi có việc xong.
function startProfileNow(profile, limitUploads = false, uploadLimitCount = 0) {
    // Nếu profile đang nằm chờ trong hàng thì rút ra, không thì tới lượt nó lại
    // chạy lần thứ hai. onDone của lượt tuần tự phải được giữ và gọi lại đúng.
    const queuedJob = dequeueProfile(profile.id);
    const onDone = queuedJob ? queuedJob.onDone : null;
    // Lượt tuần tự giữ chỗ trong queuedProfileIds từ đầu nhưng chỉ đẩy job vào
    // uploadQueue khi tới lượt. Nhả chỗ giữ ra, không thì vòng lặp tuần tự vẫn
    // đẩy profile này lần nữa và nó chạy hai lần.
    queuedProfileIds.delete(profile.id);

    activeUploadCount++;
    return runSingleProfile(profile, limitUploads, uploadLimitCount)
        .catch((err) => console.error(`[${profile.name}] Upload job failed:`, err))
        .finally(() => {
            activeUploadCount--;
            if (onDone) onDone();
            pumpUploadQueue();
        });
}

// Trả về danh sách profile thật sự nhận vào hàng đợi.
function enqueueUploads(profilesToRun, limitUploads = false, uploadLimitCount = 0) {
    const accepted = [];
    for (const profile of profilesToRun) {
        if (runningProfiles.has(profile.id) || queuedProfileIds.has(profile.id)) continue;
        queuedProfileIds.add(profile.id);
        uploadQueue.push({ profile, limitUploads, uploadLimitCount });
        accepted.push(profile);
    }
    // Card nào chưa tới lượt vẫn phải nói ra là đang chờ, chứ đứng nguyên ở
    // "idle" thì nhìn hệt như cú bấm không ăn.
    for (const profile of accepted) setProfileStatus(profile.id, 'queued');
    pumpUploadQueue();
    return accepted;
}

function runAllParallel(profilesToRun, limitUploads = false, uploadLimitCount = 0) {
    return enqueueUploads(profilesToRun, limitUploads, uploadLimitCount);
}

async function runAllSequential(profilesToRun, limitUploads = false, uploadLimitCount = 0) {
    const pending = profilesToRun.filter((p) => !runningProfiles.has(p.id) && !queuedProfileIds.has(p.id));
    for (const profile of pending) {
        queuedProfileIds.add(profile.id);
        setProfileStatus(profile.id, 'queued');
    }
    try {
        for (const profile of pending) {
            // Đã có người bấm START vượt hàng cho profile này thì bỏ qua.
            if (!queuedProfileIds.has(profile.id)) continue;
            // Vẫn đi qua hàng đợi chung để lượt tuần tự không cộng thêm một
            // trình duyệt nữa lên trên lượt song song đang chạy.
            await new Promise((resolve) => {
                uploadQueue.push({ profile, limitUploads, uploadLimitCount, onDone: resolve });
                pumpUploadQueue();
            });
        }
    } finally {
        for (const profile of pending) queuedProfileIds.delete(profile.id);
    }
}

// Tách lựa chọn thành phần chạy được và phần bị bỏ, kèm lý do, để giao diện nói
// được vì sao số card chạy ít hơn số card đã tích.
function partitionRunnable(profiles) {
    const runnable = [];
    const skipped = [];
    for (const profile of profiles) {
        if (runningProfiles.has(profile.id) || processingProfiles.has(profile.id) || queuedProfileIds.has(profile.id)) {
            skipped.push({ id: profile.id, name: profile.name, reason: 'busy' });
            continue;
        }
        const { videos, missing } = listProfileVideos(profile);
        if (missing) {
            skipped.push({ id: profile.id, name: profile.name, reason: 'no_folder' });
            continue;
        }
        if (videos.length === 0) {
            skipped.push({ id: profile.id, name: profile.name, reason: 'no_videos' });
            continue;
        }
        runnable.push(profile);
    }
    return { runnable, skipped };
}

const describeScheduleInput = (input) => {
    const hint = getScheduleHintText(input) || 'no-hint';
    return `#${input.index} kind=${inferScheduleFieldKind(input)} hint="${hint.slice(0, 80)}"`;
};

async function resolveScheduleInputs(page, log) {
    await page.waitForFunction(() => {
        const visibleInputs = Array.from(document.querySelectorAll('input.TUXTextInputCore-input')).filter((input) => {
            const style = window.getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        });

        return visibleInputs.length >= 2;
    }, { timeout: 10000 }).catch(() => null);

    const locator = page.locator('input.TUXTextInputCore-input:visible');
    const count = await locator.count();
    const inputs = [];

    for (let index = 0; index < count; index++) {
        const meta = await locator.nth(index).evaluate((input) => {
            const rect = input.getBoundingClientRect();
            return {
                placeholder: input.getAttribute('placeholder') || '',
                ariaLabel: input.getAttribute('aria-label') || '',
                label: (input.closest('label')?.innerText || input.parentElement?.innerText || '').trim().slice(0, 120),
                name: input.getAttribute('name') || '',
                id: input.id || '',
                value: input.value || '',
                top: rect.top,
                left: rect.left
            };
        });

        inputs.push({ index, ...meta });
    }

    const orderedInputs = sortScheduleInputs(inputs);
    if (orderedInputs.length === 0) {
        throw new Error('No visible schedule inputs found');
    }

    log(`Visible schedule inputs: ${orderedInputs.map(describeScheduleInput).join(' | ')}`);

    const selected = { date: null, time: null };
    for (const input of orderedInputs) {
        const kind = inferScheduleFieldKind(input);
        if (kind === 'date' && !selected.date) selected.date = input;
        if (kind === 'time' && !selected.time) selected.time = input;
    }

    if (!selected.date) {
        selected.date = orderedInputs[0];
    }

    if (!selected.time) {
        selected.time = orderedInputs.find((input) => input.index !== selected.date?.index) || orderedInputs[1] || null;
    }

    return selected;
}

async function fillScheduleInput(page, inputMeta, value, label, log) {
    if (!inputMeta) {
        throw new Error(`${label} input not found`);
    }

    const input = page.locator('input.TUXTextInputCore-input:visible').nth(inputMeta.index);
    log(`Setting ${label} using ${describeScheduleInput(inputMeta)} => ${value}`);

    await input.scrollIntoViewIfNeeded();

    // Bypassing 'readonly' attribute to allow filling
    await input.evaluate(el => el.removeAttribute('readonly')).catch(() => null);

    await input.click({ clickCount: 3 });
    await page.waitForTimeout(500);

    // Special handling for the TikTok Time Picker
    if (label === 'Time') {
        const pickerSelector = '.tiktok-timepicker-time-picker-container';
        const picker = page.locator(pickerSelector);

        try {
            if (await picker.isVisible({ timeout: 2000 })) {
                log(`Time picker detected. Selecting items directly...`);
                const [targetHour, targetMinute] = value.split(':');

                const hourEl = picker.locator(`.tiktok-timepicker-left:has-text("${targetHour}")`).first();
                if (await hourEl.isVisible()) await hourEl.click({ force: true });

                const minuteEl = picker.locator(`.tiktok-timepicker-right:has-text("${targetMinute}")`).first();
                if (await minuteEl.isVisible()) await minuteEl.click({ force: true });

                await input.click();
                await page.waitForTimeout(500);

                // Danh sách phút của picker không chắc chứa mọi giá trị: mốc lẻ
                // như :27 có thể không có dòng nào để click, và cú click ở trên
                // im lặng không làm gì. Trả về ngay lúc đó là báo thành công cho
                // một ô giờ vẫn đang sai. Đọc lại ô rồi mới quyết định.
                const filled = await input.inputValue().catch(() => '');
                const same = (a, b) => String(a).replace(/\s+/g, '').toUpperCase()
                    === String(b).replace(/\s+/g, '').toUpperCase();
                if (same(filled, value)) return;

                log(`Time picker left "${filled || '<empty>'}" instead of "${value}". Falling back to typing.`);
            }
        } catch (e) {
            log(`Time picker interaction failed: ${e.message}. Falling back to fill.`);
        }
    }

    // Special handling for the TikTok Date Picker
    if (label === 'Date') {
        const pickerSelector = '.calendar-wrapper';
        try {
            // Click input once to open calendar if not already open
            if (!(await page.locator(pickerSelector).isVisible({ timeout: 500 }).catch(() => false))) {
                await input.click();
            }
            await page.waitForTimeout(1000);

            const picker = page.locator(pickerSelector).first();
            if (await picker.isVisible({ timeout: 3000 })) {
                log(`Calendar picker detected. Selecting day directly...`);

                // Parse the target day from value (expected YYYY-MM-DD or MM/DD/YYYY)
                const parts = value.split(/[-/.]/).map(Number);
                let targetDay = parts[2]; // Default for YYYY-MM-DD or YYYY.MM.DD
                if (value.includes('/') && parts[0] <= 12) targetDay = parts[1]; // MM/DD/YYYY
                else if (value.includes('/') && parts[0] > 12) targetDay = parts[0]; // DD/MM/YYYY

                log(`Extracted target day: ${targetDay}`);

                // Click the day span. Filter for 'valid' to stay in current month.
                // We use :text-is to match exact text and avoid "2" matching "22"
                const dayEl = picker.locator(`span.day.valid`).filter({ hasText: new RegExp(`^${targetDay}$`) }).first();

                if (await dayEl.isVisible()) {
                    await dayEl.click({ force: true });
                    log(`Successfully clicked day ${targetDay} in calendar.`);
                    await page.waitForTimeout(1000);

                    // Verify if picker closed or check if it stayed
                    if (!(await picker.isVisible({ timeout: 1000 }).catch(() => false))) {
                        return;
                    }
                } else {
                    log(`Day ${targetDay} not visible/valid in current month view.`);
                }
            }
        } catch (e) {
            log(`Date picker interaction failed: ${e.message}. Falling back to manual fill.`);
        }
    }


    await input.fill('');
    await input.type(value, { delay: 50 });
    await input.press('Enter').catch(() => null);
    await input.press('Tab').catch(() => null);
    await page.waitForTimeout(1000);

    const actualValue = await input.inputValue().catch(() => '');
    log(`${label} input value after fill: ${actualValue || '<empty>'}`);
}

async function runSingleProfile(profile, limitUploads = false, uploadLimitCount = 0, forceUploadAll = false, specificFile = null) {
    if (runningProfiles.has(profile.id)) return;
    runningProfiles.add(profile.id);

    console.log(`[${profile.name}] Starting automation...`);
    // KHÔNG xoá last_scheduled_at ở đây. Từng xoá, và hậu quả là suốt cả lượt
    // chạy mới card không hiện gì -- mốc cũ biến mất ngay lúc bấm Start, còn
    // mốc mới thì phải đợi video đầu upload xong mới có. Lượt nào đăng ngay
    // không hẹn giờ thì mất hẳn. Cứ để mốc cũ đứng đó: nó vẫn là lịch đăng gần
    // nhất đã đặt thật, và giao diện tự làm mờ khi mốc đã trôi qua.
    db.prepare('UPDATE profiles SET status = ?, last_run = ? WHERE id = ?').run('uploading', new Date().toISOString(), profile.id);

    try {
        let videoFolder = profile.video_folder || getConfig('videoFolder', UPLOADS_DIR);
        let videos = [];
        if (specificFile) {
            // Single-file mode: only upload this specific file
            if (fs.existsSync(specificFile)) {
                videos = [path.basename(specificFile)];
                console.log(`[${profile.name}] Single-file mode: uploading ${specificFile}`);
            } else {
                console.error(`[${profile.name}] Specific file not found: ${specificFile}`);
            }
        } else {
            const found = listProfileVideos(profile);
            videoFolder = found.folder;
            if (found.missing) {
                console.error(`[${profile.name}] Video folder does not exist: ${videoFolder}`);
                db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('error', profile.id);
                return;
            }
            videos = found.videos;
            console.log(`[${profile.name}] Found ${videos.length} videos in ${videoFolder}`);
        }

        // Determine the actual folder to use (specificFile may be in a different folder)
        const actualFolder = specificFile ? path.dirname(specificFile) : videoFolder;

        if (videos.length === 0) {
            // 'no_videos' chứ không phải 'idle': card phải đọc ra được là nó bị bỏ
            // qua, chứ về idle thì trông y như chưa bao giờ được bấm chạy.
            console.log(`[${profile.name}] No videos found in ${actualFolder}. Skipping browser launch.`);
            db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('no_videos', profile.id);
            return;
        }

        const uploadedCount = await uploadVideo(profile, actualFolder, videos, limitUploads, uploadLimitCount, forceUploadAll);

        if (uploadedCount > 0) {
            db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('success', profile.id);
        } else if (videos.length === 0) {
            db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('idle', profile.id);
        } else {
            db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('no_videos', profile.id);
        }
    } catch (error) {
        console.error(`[${profile.name}] Automation error:`, error);
        db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('error', profile.id);
    } finally {
        runningProfiles.delete(profile.id);
        setTimeout(() => {
            if (!runningProfiles.has(profile.id)) {
                db.prepare('UPDATE profiles SET status = ? WHERE id = ?').run('idle', profile.id);
            }
        }, 30000);
    }
}

const TELEGRAM_TOKEN = "7952619216:AAFO_cgfDyV1TRism4j7shaaTIgGdtxF6pU";
const TELEGRAM_CHAT_ID = "1370074402";

async function sendTelegramNotification(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(`[Telegram] Message sent: ${message.replace(/<[^>]*>/g, '')}`);
    } catch (err) {
        console.error('Failed to send Telegram notification:', err.message);
    }
}

async function dismissOnboardingModals(page, log) {
    // Phase 1: Instant detection via page.evaluate (no timeout waits)
    // Check if ANY known onboarding modal/tooltip exists. If nothing, return immediately.
    let modalsFound = false;

    try {
        const detection = await page.evaluate(() => {
            const found = [];

            // Check TUXModal (e.g., "Turn on automatic content checks?")
            const tuxModal = document.querySelector('div.TUXModal');
            if (tuxModal) {
                const rect = tuxModal.getBoundingClientRect();
                const style = window.getComputedStyle(tuxModal);
                if (rect.width > 50 && rect.height > 20 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const cancelBtn = tuxModal.querySelector('button');
                    const btns = Array.from(tuxModal.querySelectorAll('button')).map(b => b.textContent.trim());
                    found.push({ type: 'TUXModal', buttons: btns });
                }
            }

            // Check tutorial tooltip ("New editing features added")
            const tutorialTips = document.querySelectorAll('[class*="tutorial-tooltip"], .react-joyride__tooltip');
            for (const tip of tutorialTips) {
                const rect = tip.getBoundingClientRect();
                const style = window.getComputedStyle(tip);
                if (rect.width > 50 && rect.height > 20 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const btns = Array.from(tip.querySelectorAll('button')).map(b => b.textContent.trim());
                    found.push({ type: 'tutorial-tooltip', buttons: btns });
                    break;
                }
            }

            // Check editor guide tooltip ("Phone mode")
            const guideTips = document.querySelectorAll('[class*="editor-guide"]');
            for (const tip of guideTips) {
                const rect = tip.getBoundingClientRect();
                const style = window.getComputedStyle(tip);
                if (rect.width > 50 && rect.height > 20 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const btns = Array.from(tip.querySelectorAll('button')).map(b => b.textContent.trim());
                    found.push({ type: 'editor-guide', buttons: btns });
                    break;
                }
            }

            // Check for any joyride tooltip (not in tutorial above)
            const joyrides = document.querySelectorAll('[class*="joyride"], [data-joyride]');
            for (const jr of joyrides) {
                const rect = jr.getBoundingClientRect();
                const style = window.getComputedStyle(jr);
                if (rect.width > 50 && rect.height > 20 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    const btns = Array.from(jr.querySelectorAll('button')).map(b => b.textContent.trim());
                    found.push({ type: 'joyride', buttons: btns });
                    break;
                }
            }

            // Check for sound guide callouts ("Use these sounds to prevent your 1 Minute+...")
            const soundGuides = document.querySelectorAll('[class*="DivGuideContainer"], [class*="GuideContainer"]');
            for (const sg of soundGuides) {
                const rect = sg.getBoundingClientRect();
                const style = window.getComputedStyle(sg);
                if (rect.width > 50 && rect.height > 20 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    found.push({ type: 'sound-guide', buttons: [] });
                    break;
                }
            }

            return found;
        });

        if (detection.length === 0) {
            // No onboarding modals detected — skip all dismissal attempts
            return;
        }

        modalsFound = true;
        log(`Detected ${detection.length} onboarding modal(s): ${detection.map(d => d.type + '(' + (d.buttons ? d.buttons.join(',') : '') + ')').join('; ')}`);

    } catch (e) {
        // evaluate failed (page might be closing/navigating). Skip.
        return;
    }

    // Phase 2: Only if modals detected, dismiss them with targeted selectors

    // 1. TUXModal (e.g., "Turn on automatic content checks?" -> ALWAYS Cancel, "Allow video uploads on mobile?" -> Got it)
    try {
        const tuxModal = await page.$('div.TUXModal');
        if (tuxModal && await tuxModal.isVisible()) {
            const text = await tuxModal.innerText().catch(() => '');
            if (text.includes("automatic content checks") || text.includes("content checks")) {
                const cancelBtn = await tuxModal.$('button:has-text("Cancel")');
                if (cancelBtn) {
                    log('✅ Dismissing "Turn on automatic content checks" → Cancel');
                    await cancelBtn.click();
                    await page.waitForTimeout(800);
                }
            } else if (text.includes("Discard this post") || text.includes("discarded permanently")) {
                const notNowBtn = await tuxModal.$('button:has-text("Not now")');
                if (notNowBtn && await notNowBtn.isVisible()) {
                    log('✅ Dismissing "Discard this post?" → Not now');
                    await notNowBtn.click();
                    await page.waitForTimeout(800);
                } else {
                    const discardBtn = await tuxModal.$('button:has-text("Discard")');
                    if (discardBtn && await discardBtn.isVisible()) {
                        log('✅ Dismissing "Discard this post?" → Discard');
                        await discardBtn.click();
                        await page.waitForTimeout(800);
                    }
                }
            } else {
                const modalBtns = ['button:has-text("Got it")', 'button:has-text("Allow")', 'button:has-text("Not now")', 'button:has-text("Cancel")', 'button:has-text("Skip")'];
                for (const btnSel of modalBtns) {
                    const el = await tuxModal.$(btnSel).catch(() => null);
                    if (el && await el.isVisible()) {
                        log(`✅ Dismissing TUXModal → ${btnSel}`);
                        await el.click();
                        await page.waitForTimeout(800);
                        break;
                    }
                }
            }
        }
    } catch (e) { /* not found */ }

    // 2. Tutorial tooltip: "New editing features added" → Got it
    try {
        const el = await page.waitForSelector(
            '[class*="tutorial-tooltip"] button:has-text("Got it"), .react-joyride__tooltip button:has-text("Got it")',
            { timeout: 3000 }
        );
        if (el) {
            log('✅ Dismissing tutorial/joyride tooltip → Got it');
            await el.click();
            await page.waitForTimeout(800);

            // Joyride may have multiple steps
            try {
                const el2 = await page.waitForSelector(
                    '[class*="joyride"] button:has-text("Got it")',
                    { timeout: 2000 }
                );
                if (el2) {
                    log('✅ Dismissing joyride step 2 → Got it');
                    await el2.click();
                    await page.waitForTimeout(500);
                }
            } catch (e) { /* no second step */ }
        }
    } catch (e) { /* not found */ }

    // 3. Editor guide tooltip: "Phone mode" → Got it
    try {
        const el = await page.waitForSelector(
            '[class*="editor-guide"] button:has-text("Got it")',
            { timeout: 3000 }
        );
        if (el) {
            log('✅ Dismissing editor guide tooltip → Got it');
            await el.click();
            await page.waitForTimeout(800);
        }
    } catch (e) { /* not found */ }

    // 4. Sound guide callout ("Use these sounds...") → click or press Escape
    try {
        const sgEl = await page.waitForSelector('[class*="DivGuideContainer"], [class*="GuideContainer"]', { timeout: 1500 }).catch(() => null);
        if (sgEl && await sgEl.isVisible()) {
            log('✅ Dismissing sound guide callout ("Use these sounds...")');
            await sgEl.click().catch(() => null);
            await page.keyboard.press('Escape').catch(() => null);
            await page.waitForTimeout(500);
        }
    } catch (e) { /* not found */ }
}

// Nhãn trạng thái của mỗi dòng trên TikTok Studio Content. Dòng đang chờ đăng
// có thêm icon Alarm bên cạnh mốc thời gian.
const STUDIO_STAGE_LABEL = '[data-tt="components_PublishStageLabel_FlexCenter"]';
const STUDIO_STAGE_LABEL_TEXT = '[data-tt="components_PublishStageLabel_TUXText"]';
const STUDIO_ALARM_ICON = '[data-testid="Alarm"]';
// Khung của trang Content. Kiểm chứng trực tiếp trên TikTok Studio: trang này
// KHÔNG có <table>, không có [role="table"], cũng không có data-e2e nào — mọi
// mốc neo đều nằm ở data-tt, nên đây là tín hiệu "trang đã render" duy nhất đáng
// tin. Dùng để phân biệt kênh trống với danh sách chưa dựng xong.
const STUDIO_PAGE_RENDERED = '[data-tt^="Content_ContentPage"], [data-tt^="components_PostPage"], [data-tt^="components_PostTable"]';
// Chỉ nhận đúng nút của trạng thái kênh trống. Không dùng "Upload video" vì
// chuỗi đó khớp luôn nút Upload thường trực trên header, khiến kênh đang có lịch
// bị đọc nhầm thành kênh trống.
const STUDIO_EMPTY_STATE = 'button:has-text("Upload first video"), a:has-text("Upload first video")';
const STUDIO_ROWS_SCANNED = 20;
// Trang Content phải tải xong cả chục bundle JS của creator-center trước khi
// DOMContentLoaded nổ. Qua proxy của profile, mỗi bundle mất 4-12s (đo được
// ~39 KB/s so với ~86 KB/s đi thẳng), nên mốc 30s cũ hết giờ trước khi trang kịp
// dựng và cả lượt upload chết oan dù proxy vẫn sống.
const STUDIO_CONTENT_GOTO_TIMEOUT = 90000;
// Danh sách video được React dựng sau khi XHR trả về — cũng đi qua đúng đường
// truyền chậm đó, nên nới theo cùng lý do.
const STUDIO_CONTENT_RENDER_TIMEOUT = 45000;

/**
 * Đọc trang TikTok Studio Content để tìm mốc lịch xa nhất đang còn chờ đăng.
 *
 * Trả về Date nếu kênh còn video đã lên lịch chưa chạy tới, null nếu kênh trống
 * hoặc mọi video đã Public. Thử lại nhiều lần khi trang load chậm hoặc bị popup
 * chắn; hết lượt mà vẫn không đọc được thì ném lỗi để dừng upload, vì lên lịch
 * khi không biết loạt cũ đang nằm ở đâu sẽ đè chồng lên chúng.
 */
async function checkExistingScheduledTime(page, log, maxAttempts = 5) {
    log(`[Content Check] Reading TikTok Studio Content for pending schedules (max ${maxAttempts} attempts)...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            log(`[Content Check ${attempt}/${maxAttempts}] Navigating to TikTok Studio Content...`);
            await page.goto('https://www.tiktok.com/tiktokstudio/content', {
                waitUntil: 'domcontentloaded',
                timeout: STUDIO_CONTENT_GOTO_TIMEOUT
            });
            await page.waitForTimeout(3000);
            await dismissPopups(page).catch(() => null);

            if (page.url().includes('login') || page.url().includes('passport')) {
                throw new Error('Redirected to login page while reading the content list.');
            }

            await page.waitForSelector(
                `${STUDIO_STAGE_LABEL}, ${STUDIO_PAGE_RENDERED}, ${STUDIO_EMPTY_STATE}`,
                { timeout: STUDIO_CONTENT_RENDER_TIMEOUT, state: 'attached' }
            );

            const labels = page.locator(STUDIO_STAGE_LABEL);
            const labelCount = await labels.count().catch(() => 0);

            // Quét các dòng đầu danh sách chứ không chỉ dòng trên cùng, và lấy mốc
            // xa nhất, để lịch mới luôn nối tiếp phía sau bất kể TikTok sắp xếp
            // các video đã lên lịch theo thứ tự nào.
            let latest = null;
            // Mốc vượt trần là dấu hiệu việc đọc nhãn đang hỏng, không phải một
            // lịch thật. Bỏ riêng dòng đó không đủ: nếu đọc sai một dòng thì
            // những dòng còn lại cũng đáng ngờ, mà đoán sai chỗ loạt cũ đang nằm
            // thì lịch mới đè lên nó. Nên ghi nhận rồi ném lỗi ở cuối, để vòng
            // thử lại chạy và cuối cùng dừng hẳn upload — hỏng ồn ào, không im.
            let outOfRangeLabel = null;
            const pendingLimitMs = STUDIO_MAX_PENDING_DAYS * 24 * 60 * 60 * 1000;
            const rowsToScan = Math.min(labelCount, STUDIO_ROWS_SCANNED);
            for (let row = 0; row < rowsToScan; row++) {
                const label = labels.nth(row);
                const hasAlarm = (await label.locator(STUDIO_ALARM_ICON).count().catch(() => 0)) > 0;
                if (!hasAlarm) continue;

                const rawText = await label.locator(STUDIO_STAGE_LABEL_TEXT).first()
                    .textContent().catch(() => '');
                const timeText = (rawText || '').trim();
                if (!timeText) continue;

                const parsed = parseStudioScheduleLabel(timeText);
                if (!parsed) {
                    log(`[Content Check] Unreadable scheduled label "${timeText}". Skipping this row.`);
                    continue;
                }

                if (parsed.getTime() - Date.now() > pendingLimitMs) {
                    log(`[Content Check] Label "${timeText}" parsed to ${parsed.toISOString()}, further out than TikTok allows. Treating the read as broken.`);
                    outOfRangeLabel = timeText;
                    continue;
                }

                log(`[Content Check] Pending schedule: "${timeText}" -> ${parsed.toISOString()}`);
                if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
            }

            if (outOfRangeLabel) {
                throw new Error(`Schedule label "${outOfRangeLabel}" is further out than TikTok allows, so the content list cannot be trusted.`);
            }

            if (latest) {
                log(`[Content Check] Latest pending schedule: ${latest.toISOString()}`);
                return latest;
            }

            if (labelCount > 0) {
                log('[Content Check] Videos exist but none is scheduled. Using default upload flow.');
                return null;
            }

            // Không có dòng nào: phân biệt "kênh chưa có video" với "trang chưa
            // render xong". Chỉ trường hợp đầu mới được coi là đọc thành công.
            const pageRendered = (await page.locator(STUDIO_PAGE_RENDERED).count().catch(() => 0)) > 0;
            const isEmptyStateVisible = await page.locator(STUDIO_EMPTY_STATE).first()
                .isVisible().catch(() => false);

            if (pageRendered || isEmptyStateVisible) {
                log('[Content Check] Channel has no uploaded videos yet. Using default upload flow.');
                return null;
            }

            throw new Error('Content page did not render (no rows, no page container, no empty state).');
        } catch (e) {
            log(`[Content Check ${attempt}/${maxAttempts}] Failed: ${e.message}`);
            if (attempt >= maxAttempts) {
                throw new Error(`Failed to read TikTok Studio Content after ${maxAttempts} attempts: ${e.message}`);
            }
            log('[Content Check] Retrying in 3 seconds...');
            await page.waitForTimeout(3000);
            await dismissPopups(page).catch(() => null);
        }
    }

    return null;
}

// Số lượt thử lại khâu chọn file, mỗi lượt reload trang trước khi thử tiếp.
const FILE_PICK_ATTEMPTS = 3;
// Dò nút upload. Mốc cũ 200ms được chọn cho máy chạy một hai browser; với bốn
// profile song song thì nút chưa kịp "visible" trong ngần ấy, nên Strategy 1 bị
// bỏ qua hoàn toàn và mọi thứ dồn xuống Strategy 2.
const UPLOAD_BUTTON_PROBE_TIMEOUT = 1000;
// Chờ sự kiện filechooser. Log cho thấy dưới tải, ba profile kịp trong 5 giây
// còn một profile thì không — đúng cửa sổ này quyết định sống chết.
const FILE_CHOOSER_TIMEOUT = 10000;

/**
 * Ô tiêu đề của video trên trang upload.
 *
 * Xếp từ cụ thể tới chung: node chứa chữ thật đứng trước, mấy khung bọc ngoài
 * để sau, nên khi đọc lại để kiểm tra thì lấy đúng chỗ chứa nội dung.
 */
const CAPTION_SELECTOR = [
    '[data-e2e="caption-edit-container"] [contenteditable="true"]',
    '.public-DraftEditor-content',
    '[contenteditable="true"]',
    '.DraftEditor-root',
    '[role="textbox"]',
    'textarea'
].join(', ');

// Trần cho những khoảng "chờ giao diện ổn định". Đúng bằng 5 giây của mốc ngủ
// cứng cũ, nên trường hợp xấu nhất không đổi — khác ở chỗ giờ nó là TRẦN chứ
// không phải thời gian ngủ bắt buộc, nên lượt bình thường đi tiếp ngay.
const EDITOR_READY_TIMEOUT = 5000;

// Nút Post đã bật là dấu hiệu trình soạn thảo sẵn sàng cho mọi khâu phía sau.
const POST_BUTTON_READY = 'button[data-e2e="post_video_button"]:not([disabled]), button.common-button-post-video:not([disabled])';

// Chờ ô tiêu đề hiện ra. Mốc cũ là 200ms cho từng selector, và log cho thấy nó
// hỏng đúng như nút upload từng hỏng: chạy một profile thì trượt 0,1%, nhưng 4
// profile song song trượt 11% và từ 6 profile trở lên trượt 33% — tổng cộng 996
// trong 12.387 lượt đăng với tiêu đề còn nguyên. Chờ một lần với hạn thật thay
// vì dò sáu lần với hạn quá ngắn.
const CAPTION_WAIT_TIMEOUT = 15000;
const CAPTION_CLEAR_ATTEMPTS = 2;
// Số lần ngó lại ô tiêu đề (mỗi lần 500ms) chờ TikTok điền tên file vào.
const CAPTION_FILL_POLLS = 6;

async function readCaptionText(field) {
    return field
        .evaluate((el) => {
            if (el.value !== undefined) return el.value.trim();
            // Draft.js vẽ chữ gợi ý ("Writing a long description can help get 3x
            // more views on average") thành một node riêng nằm CÙNG khung với
            // nội dung, và nó chỉ hiện khi ô đang trống. Selector gộp bằng dấu
            // phẩy lại trả về phần tử đứng trước trong DOM, tức khung cha chứa
            // cả hai — nên đọc thẳng sẽ thấy chữ gợi ý và tưởng là chưa xoá
            // được, đúng lúc vừa xoá xong. Bỏ node gợi ý ra rồi mới đọc.
            const clone = el.cloneNode(true);
            clone.querySelectorAll('[class*="laceholder"]').forEach((node) => node.remove());
            return (clone.textContent || '').replace(/[\u200B\uFEFF]/g, '').trim();
        })
        .catch(() => '');
}

/**
 * Xoá tiêu đề mặc định mà TikTok điền sẵn theo tên file.
 *
 * Xoá xong thì đọc lại để biết chữ đã biến mất thật chưa — khâu cũ chỉ bấm rồi
 * ghi "attempt finished" bất kể kết quả, nên một video giữ nguyên tiêu đề trông
 * y hệt một video đã xoá sạch trong log. Trả về false khi bó tay; chỗ gọi chỉ
 * cảnh báo chứ không dừng lượt, vì tiêu đề thừa không hỏng bằng nhạc sai.
 */
async function clearVideoCaption(page, log, profileName) {
    const field = await page
        .waitForSelector(CAPTION_SELECTOR, { timeout: CAPTION_WAIT_TIMEOUT, state: 'visible' })
        .catch(() => null);

    if (!field) {
        log(`WARNING: caption field never appeared within ${CAPTION_WAIT_TIMEOUT}ms — TITLE WAS NOT CLEARED.`);
        await page.screenshot({ path: path.join(__dirname, `debug_${profileName}_no_caption.png`) }).catch(() => null);
        return false;
    }

    // TikTok tự điền tiêu đề theo tên file, đôi khi chậm hơn lúc ô hiện ra.
    // Khoảng ngủ cứng 5 giây trước kia vô tình che chuyện này; bỏ nó rồi thì
    // phải đợi đúng lúc chữ xuất hiện, không thì ta xoá một ô đang trống và
    // TikTok điền tên file vào ngay sau đó — tiêu đề vẫn còn nguyên.
    let before = await readCaptionText(field);
    for (let i = 0; i < CAPTION_FILL_POLLS && !before; i++) {
        await page.waitForTimeout(500);
        before = await readCaptionText(field);
    }

    if (!before) {
        log('Caption is already empty — nothing to clear.');
        return true;
    }
    log(`Caption field found. Current text: "${before.slice(0, 80)}"`);

    for (let attempt = 1; attempt <= CAPTION_CLEAR_ATTEMPTS; attempt++) {
        await field.focus().catch(() => null);
        await field.click({ clickCount: 3 }).catch(() => null);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Meta+A');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(600);

        const left = await readCaptionText(field);
        if (!left) {
            log(`Caption cleared (attempt ${attempt}/${CAPTION_CLEAR_ATTEMPTS}).`);
            return true;
        }
        log(`Caption still holds text after attempt ${attempt}/${CAPTION_CLEAR_ATTEMPTS}: "${left.slice(0, 80)}"`);
    }

    log('WARNING: caption could NOT be cleared — THE VIDEO WILL KEEP ITS TITLE.');
    await page.screenshot({ path: path.join(__dirname, `debug_${profileName}_caption_stuck.png`) }).catch(() => null);
    return false;
}

/**
 * Không xác định được bài nhạc phải dùng cho video này.
 *
 * Lớp lỗi riêng vì khâu Add Sound nằm trong một `catch` nuốt sạch lỗi để những
 * trục trặc lặt vặt của trình soạn thảo không giết cả lượt chạy. Chọn sai nhạc
 * thì khác: video đăng lên rồi không rút lại được, nên riêng lỗi này phải lọt
 * qua `catch` đó và dừng hẳn lượt chạy của profile.
 */
class MusicNotResolvedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MusicNotResolvedError';
    }
}

// Ô tìm kiếm trong panel Sounds. TikTok đổi placeholder theo ngôn ngữ nên phải
// dò vài biến thể; trả về null để chỗ gọi tự quyết định ném lỗi hay bỏ qua.
async function findSoundSearchInput(page, log) {
    const selectors = [
        'input[placeholder="Search sounds"]',
        'input[placeholder*="sound" i]',
        'input[placeholder*="music" i]',
    ];
    for (let attempt = 0; attempt < 30; attempt++) {
        for (const sel of selectors) {
            const el = await page.$(sel).catch(() => null);
            if (el && await el.isVisible().catch(() => false)) {
                log(`Found search input via: ${sel}`);
                return el;
            }
        }
        await page.waitForTimeout(1000);
    }
    return null;
}

// Đọc tên bài và phần mô tả của mọi kết quả đang hiện trong panel.
// Cấu trúc lấy từ DOM thật: tiêu đề nằm ở MusicPanelMusicItem__infoBasicTitle,
// còn ca sĩ nằm trong MusicPanelMusicItem__infoBasicDesc sau thời lượng, dạng
// "04:00 · Gilang Galang".
async function readSoundItems(page) {
    return page.evaluate(() => {
        return [...document.querySelectorAll('div[role="listitem"][data-item-id]')].map((node, index) => ({
            index,
            itemId: node.getAttribute('data-item-id'),
            title: (node.querySelector('.MusicPanelMusicItem__infoBasicTitle')?.textContent || '').trim(),
            desc: (node.querySelector('.MusicPanelMusicItem__infoBasicDesc')?.textContent || '').trim()
        }));
    });
}

/**
 * Bấm nút cộng của kết quả thứ `index` để gắn nhạc vào video, rồi chỉnh mốc
 * bắt đầu về -50 như luồng cũ vẫn làm.
 */
async function addSoundAtIndex(page, log, index) {
    const item = (await page.$$('div[role="listitem"][data-item-id]'))[index];
    if (!item) throw new MusicNotResolvedError(`Sound item #${index + 1} disappeared before it could be added.`);

    const icon = await item.$('[data-icon="plus-bold"]');
    if (!icon) throw new MusicNotResolvedError(`Sound item #${index + 1} has no add button.`);

    const button = await icon.evaluateHandle((el) => el.closest('button') || el);
    await button.scrollIntoViewIfNeeded().catch(() => null);
    await button.click({ force: true });
    log(`Sound added via item #${index + 1}.`);

    await page.waitForTimeout(800);
    const propInput = await page.waitForSelector(
        'input.PropSettingInput__input, input[class*="PropSettingInput"]',
        { timeout: PROP_INPUT_TIMEOUT, state: 'visible' }
    ).catch(() => null);

    if (!propInput) {
        // Trước đây chỗ này im lặng bỏ qua, nên video lấy nhạc từ giây 0 mà
        // không ai biết. Cửa sổ chờ cũ chỉ 3 giây: đủ khi máy rảnh, hụt khi
        // nhiều Chromium tranh CPU — đúng kiểu hỏng của khâu caption 200ms.
        log(`WARNING: PropSettingInput never appeared within ${PROP_INPUT_TIMEOUT}ms — THE -50 OFFSET WAS NOT SET.`);
        return;
    }

    // Điền xong thì đọc lại: bấm mà chữ không vào là chuyện có thật khi máy
    // nghẽn, và một lần điền không kiểm chứng trông y hệt một lần thành công.
    for (let attempt = 1; attempt <= PROP_INPUT_ATTEMPTS; attempt++) {
        await propInput.click({ clickCount: 3 }).catch(() => null);
        await propInput.fill('-50').catch(() => null);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);

        const value = await propInput.inputValue().catch(() => '');
        if (value.replace(/\s/g, '') === '-50') {
            log(`Entered -50 into PropSettingInput (attempt ${attempt}/${PROP_INPUT_ATTEMPTS}).`);
            return;
        }
        log(`PropSettingInput still reads "${value}" after attempt ${attempt}/${PROP_INPUT_ATTEMPTS}.`);
    }

    log('WARNING: could not set the -50 offset — the sound will start from its own beginning.');
}

/**
 * Chọn nhạc theo vị trí trong tab Favorites.
 *
 * Không tìm kiếm gì: mở tab, đếm số mục đang hiện rồi lấy mục thứ `cursor`
 * (quay vòng). Trả về số mục để chỗ gọi biết đường đẩy con trỏ.
 */
async function addSoundFromFavorites(page, log, cursor) {
    // Dò theo chữ trên nút thay vì :has-text, vì trong DOM thật đây là
    // <button role="tab"> chứ không phải <div> — selector cũ nhắm div nên
    // không bao giờ khớp.
    const tabs = await page.$$('button[role="tab"], [role="tab"]');
    let favTab = null;
    for (const tab of tabs) {
        const text = ((await tab.textContent().catch(() => '')) || '').trim();
        if (/^(favorites?|yêu thích|đã lưu|saved)$/i.test(text)) {
            log(`Found Favorites tab: "${text}"`);
            favTab = tab;
            break;
        }
    }
    if (!favTab) {
        throw new MusicNotResolvedError('Favorites tab not found in the Sounds panel.');
    }

    await favTab.click();
    // Trước đây ngủ cứng 3,5 giây rồi mới đếm — mạng chậm thì danh sách chưa
    // render kịp, đếm ra 0 và làm dừng lượt dù tài khoản có đầy nhạc yêu thích.
    // Chờ mục thật xuất hiện; hết hạn mà vẫn trống thì mới là tab rỗng thật.
    await page.waitForSelector('div[role="listitem"][data-item-id]', {
        timeout: FAVORITES_LOAD_TIMEOUT
    }).catch(() => log('No favorite item rendered within the load window; treating the tab as empty.'));
    await page.waitForTimeout(1000);

    const items = await readSoundItems(page);
    if (items.length === 0) {
        throw new MusicNotResolvedError('Favorites tab is empty — no sound to pick.');
    }

    const position = wrapIndex(items.length, cursor);
    const chosen = items[position];
    log(`Favorites ${position + 1}/${items.length}: "${chosen.title}" — ${chosen.desc}`);
    await addSoundAtIndex(page, log, position);
    return items.length;
}

/**
 * Chọn nhạc bằng cách tìm theo tên, rồi ĐỐI CHIẾU trước khi lấy.
 *
 * TikTok trả về cả những bài trùng tên của ca sĩ khác — tìm
 * "Siren's Song - Gilang Galang" thì kết quả thứ ba là bài cùng tên của
 * Purrple Cat. Nên phải duyệt từ trên xuống và lấy kết quả ĐẦU TIÊN khớp cả
 * tên bài lẫn tên ca sĩ, thay vì lấy bừa dòng trên cùng. Cùng một bài thường
 * có nhiều bản cắt dài ngắn khác nhau và đều khớp; bản đứng đầu được chọn.
 */
// Số lượt tìm cho mỗi bài. Lượt thứ hai để phân biệt MẠNG CHẬM với BÀI KHÔNG
// CÓ THẬT — hai thứ trước đây bị gộp làm một và cùng làm dừng lượt chạy. Nó
// không nới lỏng gì: bài lấy về vẫn phải khớp tên bài và tên ca sĩ.
// Chờ nút Save của trình soạn thảo. Mất bước này là mất nhạc, nên rộng tay.
const EDITOR_SAVE_TIMEOUT = 15000;

// Chờ ô chỉnh mốc bắt đầu của nhạc. Mốc cũ 3 giây hụt khi máy gánh nhiều
// Chromium: hai profile trượt cùng một giây, đúng lúc event loop bị nghẽn.
const PROP_INPUT_TIMEOUT = 10000;
const PROP_INPUT_ATTEMPTS = 2;

const SOUND_SEARCH_ATTEMPTS = 2;

// Chờ danh sách nhạc yêu thích render. Rộng rãi vì tab này tải qua mạng.
const FAVORITES_LOAD_TIMEOUT = 15000;

// Xoá từ khoá đang nằm trong ô tìm kiếm của panel Sounds.
async function clearSoundSearch(page, searchInput) {
    const clearBtn = await page.$('[data-icon="x-circle-fill"], svg[data-icon="x-circle-fill"]').catch(() => null);
    if (clearBtn) {
        await clearBtn.click().catch(() => null);
    } else {
        await searchInput.focus().catch(() => null);
        await searchInput.click({ clickCount: 3 }).catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
    }
    await page.waitForTimeout(1000);
}

/**
 * Chọn nhạc bằng cách tìm theo tên, rồi ĐỐI CHIẾU trước khi lấy.
 *
 * TikTok trả về cả những bài trùng tên của ca sĩ khác — tìm
 * "Siren's Song - Gilang Galang" thì kết quả thứ ba là bài cùng tên của
 * Purrple Cat. Nên phải duyệt từ trên xuống và lấy kết quả ĐẦU TIÊN khớp cả
 * tên bài lẫn tên ca sĩ, thay vì lấy bừa dòng trên cùng. Cùng một bài thường
 * có nhiều bản cắt dài ngắn khác nhau và đều khớp; bản đứng đầu được chọn.
 *
 * Tìm lại một lượt nữa khi lượt đầu không ra gì hoặc không khớp gì: danh sách
 * mới render được một phần vì mạng chậm trông y hệt như bài không tồn tại, mà
 * một cú nghẽn mạng thoáng qua không đáng để mất cả loạt video còn lại.
 */
async function addSoundBySearch(page, log, searchInput, searchTerm) {
    let lastSeen = '(no results at all)';

    for (let attempt = 1; attempt <= SOUND_SEARCH_ATTEMPTS; attempt++) {
        if (attempt > 1) {
            log(`Retrying the search for "${searchTerm}" (attempt ${attempt}/${SOUND_SEARCH_ATTEMPTS}) — the previous attempt may have been cut short by a slow network.`);
            await clearSoundSearch(page, searchInput);
        }

        await searchInput.focus();
        await searchInput.click();
        await page.keyboard.type(searchTerm, { delay: 30 });
        await page.waitForTimeout(2000);
        await page.keyboard.press('Enter');
        log(`Searching for: "${searchTerm}"`);
        await page.waitForTimeout(1000);

        await page.waitForSelector(
            'div[role="listitem"][data-item-id], .MusicPanelSearchResultList__empty',
            { timeout: 30000 }
        ).catch(() => log('Wait for search results timed out. Reading whatever is on screen...'));
        await page.waitForTimeout(2000);

        const items = await readSoundItems(page);
        const match = items.find((item) => musicEntryMatches(searchTerm, item.title, item.desc));

        if (match) {
            log(`Matched result #${match.index + 1}: "${match.title}" — ${match.desc}`);
            await addSoundAtIndex(page, log, match.index);
            return;
        }

        lastSeen = items.length === 0
            ? '(no results at all)'
            : items.slice(0, 5).map((it) => `"${it.title}" — ${it.desc}`).join(' | ');
        log(`Attempt ${attempt}/${SOUND_SEARCH_ATTEMPTS}: ${items.length} result(s), none matching. Saw: ${lastSeen}`);
    }

    throw new MusicNotResolvedError(
        `No result matches "${searchTerm}" by title and artist after ${SOUND_SEARCH_ATTEMPTS} attempts. Saw: ${lastSeen}`
    );
}

async function uploadVideo(profile, videoFolder, videos, limitUploads = false, uploadLimitCount = 0, forceUploadAll = false) {
    const userDataDir = path.join(PROFILES_DIR, profile.name);
    let uploadedCount = 0;
    let lastScheduledTime = null;
    let hasExistingSchedule = false;
    // Hẹn giờ đăng: 0 nghĩa là tắt, khi bật thì không video nào được đăng ngay,
    // kể cả video đầu của lượt chạy.
    const postDelayMinutes = getPostDelayMinutes();
    const delayedStart = postDelayMinutes > 0;

    // Danh sách nhạc chạy lần lượt: video này lấy bài kế tiếp của video trước,
    // hết danh sách thì quay về bài đầu. Con trỏ nằm trong DB nên lượt chạy này
    // nối tiếp lượt trước thay vì lặp lại mấy bài trên cùng mỗi lần chạy.
    //
    // Đọc lại từ DB chứ không dùng bản chụp trong `profile`: job có thể nằm
    // trong hàng đợi khá lâu mới tới lượt, và trong lúc chờ thì danh sách nhạc
    // hoàn toàn có thể vừa được sửa trong màn Edit.
    const musicRow = db.prepare('SELECT music_search, music_index, use_favorite_music FROM profiles WHERE id = ?').get(profile.id) || {};
    const musicList = parseMusicList(musicRow.music_search ?? profile.music_search);
    let musicCursor = Number(musicRow.music_index) > 0 ? Math.floor(Number(musicRow.music_index)) : 0;
    if (musicList.length > 0) musicCursor %= musicList.length;

    const browserOptions = {
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled'
        ]
    };

    if (profile.proxy) {
        const proxyConfig = parseProxy(profile.proxy);
        if (proxyConfig) {
            browserOptions.proxy = proxyConfig;
            console.log(`[${profile.name}] Using proxy: ${proxyConfig.server}${proxyConfig.username ? ' (with auth)' : ''}`);
        }
    }

    const browser = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await injectProfileCookies(browser, profile);

    const log = (msg) => {
        const entry = `[${new Date().toISOString()}] [${profile.name}] ${msg}\n`;
        console.log(entry.trim());
        try {
            fs.appendFileSync(path.join(__dirname, 'automation.log'), entry);
        } catch (e) {
            console.error('Failed to write to log file:', e.message);
        }
    };

    try {
        let page = await browser.newPage();
        log(`Automation started for profile: ${profile.name}`);

        if (videos.length === 0) {
            log(`No compatible videos found in ${videoFolder}. Skipping.`);
            await browser.close();
            return 0;
        }

        const maxUploads = forceUploadAll
            ? videos.length
            : (limitUploads && uploadLimitCount > 0)
                ? uploadLimitCount
                : (profile.is_scheduled === 1 && profile.upload_count > 0)
                    ? profile.upload_count
                    : videos.length;
        const uploadLimit = Math.min(videos.length, maxUploads);

        // --- Nối tiếp loạt lịch cũ còn treo trên kênh ---
        // Điều kiện phải khớp đúng nhánh lên lịch ở TASK 3 bên dưới, để không
        // tốn một lượt mở trang Content cho những chế độ chạy không dùng tới
        // mốc thời gian này. Khi bật hẹn giờ đăng thì mọi profile đều phải đọc,
        // vì lịch cũ được ưu tiên hơn mốc hẹn giờ.
        if (delayedStart || (!(limitUploads && uploadLimitCount === 1) && profile.auto_increment_schedule)) {
            const existingTime = await checkExistingScheduledTime(page, log);
            if (existingTime) {
                hasExistingSchedule = true;

                // Giữ nguyên mốc thật của loạt cũ, kể cả khi nó đã trôi qua.
                // Kéo mốc gốc về now + 20 phút là làm hỏng nhịp: loạt 9:15 /
                // 9:30 / 9:45 chạy lúc 9:16 sẽ lấy gốc 9:36 rồi cộng interval
                // thành 10:00, bỏ phí hai mốc và lệch hẳn khỏi lưới giờ cũ.
                // Việc bỏ qua những mốc không còn kịp để dành cho
                // computeAutoIncrementTime, nơi nó bỏ theo từng nhịp trọn vẹn.
                lastScheduledTime = existingTime;

                if (existingTime.getTime() < Date.now()) {
                    log(`Existing schedule ${existingTime.toISOString()} has already passed. Keeping it as the rhythm anchor; slots too close to now will be skipped a whole interval at a time.`);
                }

                log(`Existing schedule detected. ALL ${uploadLimit} video(s) will be scheduled after ${lastScheduledTime.toISOString()}.`);
            } else if (delayedStart) {
                log(`Post delay is on: no pending schedule on the channel, video 1 will be scheduled ${postDelayMinutes} minutes from now.`);
            }
        }
        // --- Hết phần đọc lịch cũ ---

        for (let i = 0; i < videos.length; i++) {
            if (uploadedCount >= maxUploads) {
                log(`Reached target upload count: ${uploadedCount}. Stopping.`);
                break;
            }
            const videoFileName = videos[i];
            const videoPath = path.join(videoFolder, videoFileName);
            // Mốc hẹn giờ đã điền được cho riêng video này. Chỉ ghi xuống DB sau
            // khi Post thành công, nên phải theo từng vòng lặp chứ không dùng
            // lastScheduledTime — biến đó là neo cho video kế tiếp, và vẫn giữ
            // giá trị ngay cả khi khâu điền lịch của vòng này hỏng.
            let scheduledThisVideo = null;

            log(`Processing video ${i + 1}/${videos.length}: ${videoFileName}`);

            // Navigate to upload page with active polling
            let initialized = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    log(`Navigating to upload page (Attempt ${attempt}/3)...`);
                    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });

                    log(`Active polling for upload components...`);
                    // Smart polling loop: check every 1s for up to 30s
                    for (let poll = 0; poll < 30; poll++) {
                        log(`[Poll #${poll}] Checking isLogin...`);
                        const isLogin = page.url().includes('login') || page.url().includes('passport');
                        if (isLogin) {
                            log(`Redirected to login page. Please log in.`);
                            initialized = true; // Still "initialized" in terms of navigation, but with warning
                            break;
                        }

                        log(`[Poll #${poll}] Checking input[type="file"]...`);
                        const hasInput = await page.locator('input[type="file"]').count().then(c => c > 0).catch(() => false);
                        
                        log(`[Poll #${poll}] Checking buttons...`);
                        const hasButton = await page.locator('button.upload-stage-btn, .upload-stage-btn, [data-e2e="upload-video-button"]').count().then(c => c > 0).catch(() => false);

                        log(`[Poll #${poll}] Check done: hasInput=${hasInput}, hasButton=${hasButton}`);
                        if (hasButton || hasInput) {
                            log(`Components detected via polling.`);
                            initialized = true;
                            break;
                        }
                        log(`[Poll #${poll}] Waiting 1s...`);
                        await page.waitForTimeout(1000);
                        log(`[Poll #${poll}] Wait done.`);
                    }

                    if (initialized) break;
                } catch (e) {
                    log(`Attempt ${attempt} failed: ${e.message}`);
                    if (attempt < 3) {
                        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
                    }
                }
            }

            if (!initialized) {
                throw new Error('Upload page components not found. Page might be too slow or blocked.');
            }

            log(`Selecting file...`);
            let uploaded = false;

            // Chọn file có thể trượt khi nhiều profile chạy song song: bốn
            // Chromium tranh CPU thì sự kiện filechooser không kịp nổ trong cửa
            // sổ chờ. Trước đây trượt một lần là ném lỗi luôn, giết cả lượt chạy
            // của profile — 18/26 lần lỗi trong log rơi vào lúc có từ 4 profile
            // trở lên, và lần gần nhất mất 3/4 video. Thử lại như vòng điều
            // hướng phía trên thay vì bỏ cuộc ngay.
            for (let pick = 1; pick <= FILE_PICK_ATTEMPTS && !uploaded; pick++) {
                if (pick > 1) {
                    log(`File selection attempt ${pick}/${FILE_PICK_ATTEMPTS}: reloading upload page...`);
                    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
                    await page.locator('input[type="file"], button.upload-stage-btn').first()
                        .waitFor({ timeout: 15000, state: 'attached' }).catch(() => null);
                }

                // Strategy 1: Intercept filechooser with fast fallback
                // Only use specific selectors that are known to work on TikTok's upload page
                // Broad selectors like button[class*="upload"] can match wrong buttons (e.g. avatar upload)
                const uploadButtonSelectors = [
                    'button.upload-stage-btn',
                    '[data-e2e="upload-video-button"]',
                ];
                for (const sel of uploadButtonSelectors) {
                    try {
                        const el = await page.waitForSelector(sel, { timeout: UPLOAD_BUTTON_PROBE_TIMEOUT, state: 'visible' }).catch(() => null);
                        if (el) {
                            log(`Found upload button: ${sel}. Intercepting filechooser...`);
                            const [fileChooser] = await Promise.all([
                                page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_TIMEOUT }),
                                el.click()
                            ]);
                            await fileChooser.setFiles(videoPath);
                            log(`Strategy 1 success via ${sel}`);
                            uploaded = true;
                            break;
                        }
                    } catch (e) {
                        log(`Strategy 1 via ${sel} failed: ${e.message.split('\n')[0]}`);
                    }
                }

                if (!uploaded) {
                    log(`Strategy 2: unhide input and click for filechooser...`);
                    try {
                        await page.evaluate(() => {
                            const input = document.querySelector('input[type="file"]');
                            if (input) {
                                input.style.display = 'block';
                                input.style.visibility = 'visible';
                                input.style.opacity = '1';
                                input.style.position = 'fixed';
                                input.style.top = '0';
                                input.style.left = '0';
                                input.style.zIndex = '99999';
                            }
                        });
                        await page.waitForTimeout(500);
                        const [fileChooser] = await Promise.all([
                            page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_TIMEOUT }),
                            page.click('input[type="file"]')
                        ]);
                        await fileChooser.setFiles(videoPath);
                        log(`Strategy 2 success`);
                        uploaded = true;
                    } catch (e) {
                        log(`Strategy 2 failed: ${e.message.split('\n')[0]}`);
                    }
                }

                // Strategy 3: gán thẳng file vào input, không qua sự kiện
                // filechooser. Hai cách trên đều phải chờ đúng một sự kiện nổ
                // trong cửa sổ vài giây — chính chỗ thua khi máy đang tải nặng.
                // setInputFiles bỏ qua cuộc đua đó và vẫn phát input/change như
                // người dùng chọn thật.
                if (!uploaded) {
                    log(`Strategy 3: setInputFiles directly on the input...`);
                    try {
                        await page.setInputFiles('input[type="file"]', videoPath, { timeout: 15000 });
                        log(`Strategy 3 success`);
                        uploaded = true;
                    } catch (e) {
                        log(`Strategy 3 failed: ${e.message.split('\n')[0]}`);
                    }
                }
            }

            if (!uploaded) throw new Error(`Could not find file input or upload button after ${FILE_PICK_ATTEMPTS} attempts`);

            log(`Video file selection complete. Waiting for UI...`);
            await page.waitForTimeout(3000);

            // Dismiss any onboarding modals that may appear after file selection
            await dismissOnboardingModals(page, log);
            await dismissPopups(page);
            await page.waitForTimeout(1000);
            // Gọi lần 2 để đảm bảo popup đã được dismiss (popup có thể xuất hiện chậm)
            await dismissPopups(page);

            // Wait for upload to complete (Cancel button detaches)
            // Chạy dismissPopups liên tục trong khi đợi để tránh popup block upload
            try {
                const uploadCompletedPromise = (async () => {
                    // Đợi Cancel button của upload progress xuất hiện trước
                    const uploadProgressCancel = page.locator('.upload-progress button:has-text("Cancel"), [class*="upload"] button:has-text("Cancel"), button[class*="cancel"]').first();
                    // Nếu không tìm thấy cancel của progress, dùng fallback: detect upload done bằng cách kiểm tra Post button available
                    let cancelDetected = false;
                    try {
                        await uploadProgressCancel.waitFor({ state: 'visible', timeout: 10000 });
                        cancelDetected = true;
                    } catch (_) { /* no specific upload cancel found */ }

                    // Loop dismiss popups mỗi 2s trong khi đợi Post button ready
                    for (let i = 0; i < 600; i++) { // max 20 phút
                        await page.waitForTimeout(2000);
                        await dismissPopups(page);
                        await dismissOnboardingModals(page, log);

                        // Kiểm tra upload xong: Post button enabled và Cancel của upload progress biến mất
                        const postBtn = await page.$('button[data-e2e="post_video_button"]:not([disabled]), button.common-button-post-video:not([disabled])');
                        if (postBtn && await postBtn.isVisible()) {
                            log('Upload complete (Post button is enabled and visible).');
                            break;
                        }
                    }
                })();

                await uploadCompletedPromise;
                await page.waitForTimeout(2000);

                // Dismiss popups & tooltips that appeared after video upload completion
                await dismissOnboardingModals(page, log);
                await dismissPopups(page);
            } catch (e) {
                log(`Wait for upload completion timed out or failed: ${e.message}`);
            }

            // --- NEW TASKS: Clear Title & Add Sound ---
            try {
                log(`Waiting for upload UI components...`);
                await page.waitForSelector('.video-info-container, textarea, .DraftEditor-root, button:has-text("Edit video"), [data-button-name="sounds"], button:has-text("Post")', { timeout: 60000 });

                // Trước đây ngủ cứng 5 giây ngay đây. Log 12.481 lượt cho thấy
                // selector trên khớp tức thì, nên cả 5 giây là chờ suông (trung
                // vị 5,01s). Giờ chờ đúng hai thứ mà hai khâu kế tiếp cần — ô
                // tiêu đề và nút Sounds — với cùng trần 5 giây.
                await page.waitForSelector(`${CAPTION_SELECTOR}, button[data-button-name="sounds"]`, {
                    timeout: EDITOR_READY_TIMEOUT,
                    state: 'visible'
                }).catch(() => log('Editor controls not visible within the settle window; continuing anyway.'));

                const shouldRemoveTitle = Number(profile.remove_title) === 1;
                if (shouldRemoveTitle) {
                    log(`Task 1: Clearing title/caption...`);
                    await clearVideoCaption(page, log, profile.name);
                } else {
                    log(`remove_title tắt: Giữ lại tiêu đề video.`);
                }
            } catch (e) {
                log(`Clear title failed: ${e.message}`);
                await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_task_fail.png`) }).catch(() => null);
            }
            // --- END CLEAR TITLE ---

            // --- TASK: Add Sound (Set Music) ---
            const useSetMusic = Number(profile.set_music) === 1;
            if (useSetMusic) {
                try {
                    log(`Task 2: Waiting for Sounds panel button to be fully enabled and ready...`);

                    // Clear any onboarding / joyride overlays that might block clicking Edit Video
                    await dismissOnboardingModals(page, log);
                    await dismissPopups(page);

                    let soundsBtn = null;
                    try {
                        soundsBtn = await page.waitForSelector(
                            'button[data-button-name="sounds"]:not([disabled])',
                            { timeout: 60000, state: 'visible' }
                        );
                        log(`Sounds button is visible and enabled.`);
                    } catch (e) {
                        log(`Sounds button not found directly or still disabled: ${e.message}`);
                        // Try clicking Edit Video first to reveal the sounds button
                        const editButton = await page.$('button:has-text("Edit video"), .edit-video-btn, [data-e2e="edit-video-button"], button:has-text("Edit")');
                        if (editButton && await editButton.isVisible()) {
                            log(`Clicking Edit Video button...`);
                            await editButton.click({ force: true }).catch(() => editButton.click());
                            soundsBtn = await page.waitForSelector(
                                'button[data-button-name="sounds"]:not([disabled])',
                                { timeout: 30000, state: 'visible' }
                            ).catch(() => null);
                        }
                    }

                    if (soundsBtn) {
                        log(`Opening Sounds panel...`);
                        await soundsBtn.click();
                        await page.waitForTimeout(1500);

                        // Dismiss guide tooltips (e.g. "Phone mode" -> Got it) and any editor popups
                        await dismissOnboardingModals(page, log);
                        await dismissPopups(page);

                        // Screenshot before search
                        await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_sounds_panel.png`) }).catch(() => null);

                        // Chọn nhạc cho video này. Hai đường: lấy theo vị trí
                        // trong tab Favorites, hoặc tìm theo tên bài rồi đối
                        // chiếu. Cả hai đều DỪNG lượt chạy khi không chắc chắn
                        // — video đăng nhầm nhạc thì không rút lại được, còn
                        // lượt chạy dừng thì chạy lại được.
                        const useFavorites = Number(musicRow.use_favorite_music ?? profile.use_favorite_music) === 1;

                        if (useFavorites) {
                            const favouriteCount = await addSoundFromFavorites(page, log, musicCursor);
                            musicCursor = wrapIndex(favouriteCount, musicCursor + 1);
                            db.prepare('UPDATE profiles SET music_index = ? WHERE id = ?')
                                .run(musicCursor, profile.id);
                        } else {
                            const searchTerm = pickMusicAt(musicList, musicCursor);
                            if (!searchTerm) {
                                throw new MusicNotResolvedError('Danh sách nhạc trống nhưng set_music đang bật.');
                            }
                            log(`Music ${musicCursor + 1}/${musicList.length} for video ${i + 1}: "${searchTerm}"`);

                            // Ghi con trỏ ngay khi bốc bài, không đợi hết lượt:
                            // lượt chạy dừng giữa chừng thì lần sau vẫn đi tiếp
                            // chứ không phát lại bài cũ.
                            musicCursor = nextMusicIndex(musicList, musicCursor);
                            db.prepare('UPDATE profiles SET music_index = ? WHERE id = ?')
                                .run(musicCursor, profile.id);

                            const searchInput = await findSoundSearchInput(page, log);
                            if (!searchInput) {
                                await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_no_search.png`) }).catch(() => null);
                                throw new MusicNotResolvedError('Search input not found in the Sounds panel.');
                            }

                            log('Sounds panel ready. Waiting 4 seconds for UI stability before typing...');
                            await page.waitForTimeout(4000);
                            await addSoundBySearch(page, log, searchInput, searchTerm);
                        }

                        await page.waitForTimeout(1000);

                        // Không bấm được Save thì nhạc vừa chọn không dính vào video,
                        // và video vẫn đăng — tức mất đúng thứ mà cả lượt chạy sinh ra
                        // để làm. Trước đây chỗ này bỏ qua im lặng với hạn 5 giây, và
                        // đã trượt thật khi máy nghẽn. Nới hạn cho lúc máy gánh nặng,
                        // rồi hỏng thì dừng lượt như mọi lỗi nhạc khác.
                        // Kèm cả chữ tiếng Việt: nút này giờ là điều kiện dừng lượt, nên
                        // một giao diện đổi ngôn ngữ sẽ làm chết đồng loạt mọi profile chứ
                        // không còn âm thầm đăng thiếu nhạc như trước. Class .save-btn là
                        // chỗ dựa chính, nhưng jsx-2503522271 là mã băm TikTok sinh lúc
                        // build và sẽ đổi khi họ deploy bản mới — đừng trông vào nó.
                        const saveBtn = 'button:has-text("Save"), button:has-text("Lưu"), .save-btn, button.jsx-2503522271.save-btn';
                        const sBtn = await page.waitForSelector(saveBtn, { timeout: EDITOR_SAVE_TIMEOUT, state: 'visible' }).catch(() => null);
                        if (!sBtn) {
                            throw new MusicNotResolvedError(`Save button never appeared within ${EDITOR_SAVE_TIMEOUT}ms, so the chosen sound would not be applied.`);
                        }
                        await sBtn.click();
                        log(`Changes saved in editor.`);
                        await page.waitForSelector('button:has-text("Post")', { timeout: 15000, state: 'visible' })
                            .catch(() => log('Post button did not reappear after saving; continuing.'));
                        await page.waitForTimeout(1000);
                    } else {
                        // set_music bật mà không mở nổi panel Sounds nghĩa là
                        // video sẽ đăng không nhạc. Im lặng bỏ qua ở đây là để
                        // lọt đúng thứ mà cả khâu này sinh ra để tránh.
                        throw new MusicNotResolvedError('Sounds button never became available, so no sound could be set.');
                    }
                } catch (e) {
                    log(`Add sound task failed: ${e.message}`);
                    await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_sound_fail.png`) }).catch(() => null);
                    // Trục trặc lặt vặt của trình soạn thảo thì nuốt như cũ, để
                    // một lỗi vặt không giết cả lượt chạy. Nhưng khi không xác
                    // định được bài nhạc thì phải ném tiếp: đăng nhầm nhạc là
                    // hỏng vĩnh viễn, còn dừng lượt thì chạy lại được.
                    if (e instanceof MusicNotResolvedError) throw e;
                }
            } else {
                log(`set_music tắt: bỏ qua Edit video và chọn nhạc.`);
            }
            // --- END ADD SOUND ---

            // --- TASK: Wait for video upload to complete ---
            try {
                log("Waiting for video upload to complete...");
                const cancelBtn = page.locator('button:has-text("Cancel")');
                await cancelBtn.waitFor({ state: 'detached', timeout: 20 * 60 * 1000 });
                // Nút Cancel hầu như luôn biến mất từ trước — vòng đợi upload phía
                // trên đã chờ tới lúc nút Post bật. Log 12.468 lượt: trung vị 0,00s
                // và 98% dưới nửa giây, nên 5 giây kế tiếp trước đây là ngủ thuần.
                // Chờ đúng thứ mọi khâu sau cần, cùng trần 5 giây.
                log("Upload complete (Cancel button is gone). Waiting for the Post button to become ready...");
                const postReady = await page.waitForSelector(POST_BUTTON_READY, {
                    timeout: EDITOR_READY_TIMEOUT,
                    state: 'visible'
                }).catch(() => null);
                log(postReady
                    ? 'Post button is ready.'
                    : 'Post button not ready within the settle window; continuing anyway.');
            } catch (uploadErr) {
                log(`Warning/Error waiting for upload completion: ${uploadErr.message}`);
            }

            // --- TASK: Content Check Lite ---
            let checkSuccess = true;
            if (profile.need_content_check !== 0) {
                try {
                    log(`Starting Content check lite validation...`);
                    // Wait for toggle/switch container to be attached
                    const headline = page.locator('.headline-wrapper', { hasText: 'Content check lite' });
                    // 10 giây chứ không phải 5: trước đây khâu này còn được hưởng thêm 5 giây
                    // ngủ cứng ngay phía trên, và bỏ giấc ngủ đó đi thì dung sai cho mạng
                    // chậm cũng mất theo. Cộng lại cho bằng mức cũ.
                    await headline.waitFor({ timeout: 10000 }).catch(() => null);

                    if (await headline.count() > 0) {
                        const switchContent = headline.locator('.Switch__content');
                        if (await switchContent.count() > 0) {
                            const isChecked = await switchContent.getAttribute('data-state') === 'checked' || await switchContent.getAttribute('aria-checked') === 'true';
                            if (!isChecked) {
                                log("Content check lite is not enabled. Enabling it...");
                                await switchContent.click({ force: true });
                            } else {
                                log("Content check lite is already enabled.");
                            }

                            log("Waiting for Content check lite to complete...");
                            let checkStartTime = Date.now();
                            const maxCheckTime = 12 * 60 * 1000; // 12 minutes max
                            let toggledRetry = false;
                            checkSuccess = false;

                            while (Date.now() - checkStartTime < maxCheckTime) {
                                const status = await page.evaluate(() => {
                                    const successEl = document.querySelector('.status-result.status-success');
                                    if (successEl && successEl.getAttribute('data-show') === 'true') {
                                        return 'success';
                                    }
                                    const warnEl = document.querySelector('.status-result.status-warn');
                                    if (warnEl && warnEl.getAttribute('data-show') === 'true') {
                                        return 'warn';
                                    }
                                    const errorEl = document.querySelector('.status-result.status-error');
                                    if (errorEl && errorEl.getAttribute('data-show') === 'true') {
                                        return 'error';
                                    }
                                    const checkingEl = document.querySelector('.status-result.status-checking');
                                    if (checkingEl && checkingEl.getAttribute('data-show') === 'true') {
                                        return 'checking';
                                    }
                                    const readyEls = Array.from(document.querySelectorAll('.status-result.status-ready'));
                                    const visibleReady = readyEls.find(el => el.getAttribute('data-show') === 'true');
                                    if (visibleReady) {
                                        const text = visibleReady.innerText || "";
                                        if (text.includes("limit")) {
                                            return 'limit_reached';
                                        }
                                        if (text.includes("government") || text.includes("politician")) {
                                            return 'restricted';
                                        }
                                        return 'ready_initial';
                                    }
                                    return 'unknown';
                                });

                                log(`Content check status: ${status}`);

                                if (status === 'success' || status === 'limit_reached') {
                                    if (status === 'limit_reached') {
                                        log("Daily content check limit reached. Proceeding to post without safety check validation.");
                                    }
                                    checkSuccess = true;
                                    break;
                                } else if (status === 'checking' || status === 'unknown' || status === 'ready_initial') {
                                    // Stuck check retry logic: If waiting for 3 minutes and retry has not been done yet, click twice
                                    if (!toggledRetry && (Date.now() - checkStartTime > 3 * 60 * 1000)) {
                                        log("Stuck in checking for 3 minutes. Toggling Content check lite off and on again...");
                                        try {
                                            await switchContent.click({ force: true });
                                            await page.waitForTimeout(1000);
                                            await switchContent.click({ force: true });
                                            await page.waitForTimeout(2000);
                                            toggledRetry = true;
                                            checkStartTime = Date.now(); // Reset timer after toggling
                                        } catch (toggleErr) {
                                            log(`Failed to toggle retry switch: ${toggleErr.message}`);
                                        }
                                    }
                                    await page.waitForTimeout(5000);
                                } else {
                                    log(`Content check failed/restricted/warned/errored with status: ${status}`);
                                    break;
                                }
                            }
                        } else {
                            log("Warning: Content check switch content selector not found.");
                        }
                    } else {
                        log("Warning: Content check lite header not found on this page.");
                    }
                } catch (checkErr) {
                    log(`Error during Content check lite: ${checkErr.message}`);
                    checkSuccess = false;
                }
            } else {
                log("Content check lite is disabled for this profile. Skipping check.");
            }

            if (!checkSuccess) {
                log(`Content check failed. Skipping posting and deleting video file.`);
                try {
                    if (fs.existsSync(videoPath)) {
                        fs.unlinkSync(videoPath);
                        log(`Deleted ${videoFileName} due to failed content check.`);
                    }
                } catch (err) {
                    log(`ERROR deleting file: ${err.message}`);
                }

                // Discard the upload by closing the page and opening a new one
                log("Resetting page to discard current upload...");
                await page.close().catch(() => null);
                page = await browser.newPage();
                continue; // Skip rest of loop and process next video
            }
            // --- END TASK: Content Check Lite ---

            // --- TASK 3: Scheduled Publishing ---
            if (delayedStart || (!(limitUploads && uploadLimitCount === 1) && profile.auto_increment_schedule)) {
                try {
                    log(`Auto-increment schedule: processing video ${i + 1}...`);
                    if (hasExistingSchedule || delayedStart) {
                        // Hai trường hợp cùng dùng nhánh này vì hành vi giống hệt nhau:
                        // kênh còn loạt lịch cũ chưa chạy tới (nối sau mốc cuối, nếu
                        // đăng ngay sẽ chen lên trước những video đang chờ), hoặc đang
                        // bật hẹn giờ đăng (video đầu lùi lại đúng số giờ đã cài).
                        // Không video nào được đăng ngay, kể cả video đầu.
                        const scheduleRadio = 'input[value="schedule"]';
                        const scheduleRadioInput = page.locator(scheduleRadio).first();
                        await scheduleRadioInput.waitFor({ timeout: 15000, state: 'attached' });
                        await scheduleRadioInput.check({ force: true }).catch(() => scheduleRadioInput.click({ force: true }));
                        const batchLabel = hasExistingSchedule
                            ? 'continuing existing batch'
                            : `delayed start +${postDelayMinutes}m`;
                        log(`Selected "Schedule" option (${batchLabel}).`);
                        await page.waitForTimeout(3000);

                        const scheduleInputs = await resolveScheduleInputs(page, log);

                        const intervalMin = profile.schedule_interval || 5;
                        // Chưa có mốc nào nghĩa là kênh sạch lịch và đang hẹn giờ:
                        // video đầu lấy now + số phút đã cài. Từ video 2 trở đi nối
                        // tiếp bình thường theo schedule_interval của profile.
                        //
                        // minLeadMinutes để loạt nối tiếp bỏ qua trọn nhịp những
                        // mốc đã trôi qua hoặc còn quá sát, giữ nguyên nhịp cũ.
                        // Dùng hàng rào kỹ thuật, không dùng sàn của ô cài đặt.
                        lastScheduledTime = lastScheduledTime
                            ? computeAutoIncrementTime({ lastScheduledTime, intervalMinutes: intervalMin, now: new Date(), minLeadMinutes: SCHEDULE_MIN_LEAD_MINUTES })
                            : computeDelayedFirstTime({ delayMinutes: postDelayMinutes });
                        const dateValue = formatScheduleValue(lastScheduledTime, 'date', scheduleInputs.date || {});
                        const timeValue = formatScheduleValue(lastScheduledTime, 'time', scheduleInputs.time || {});

                        log(`Video ${i + 1}: Scheduling at ${dateValue} ${timeValue} (${batchLabel}).`);
                        await fillScheduleInput(page, scheduleInputs.date, dateValue, 'Date', log);
                        await fillScheduleInput(page, scheduleInputs.time, timeValue, 'Time', log);
                        scheduledThisVideo = lastScheduledTime;
                        await page.waitForTimeout(2000);

                        await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_autoincrement_${i + 1}.png`) }).catch(() => null);
                    } else if (i === 0) {
                        log(`Video 1: Posting immediately (Public).`);
                        // Public is usually default, but we can ensure it if needed
                    } else {
                        // 1. Click "Schedule" radio
                        const scheduleRadio = 'input[value="schedule"]';
                        const scheduleRadioInput = page.locator(scheduleRadio).first();
                        await scheduleRadioInput.waitFor({ timeout: 15000, state: 'attached' });
                        await scheduleRadioInput.check({ force: true }).catch(() => scheduleRadioInput.click({ force: true }));
                        log(`Selected "Schedule" option.`);
                        await page.waitForTimeout(3000);

                        // 2. Resolve inputs
                        const scheduleInputs = await resolveScheduleInputs(page, log);

                        if (i === 1) {
                            // Video 2: Capture TikTok's default time
                            const defaultDate = await page.locator('input.TUXTextInputCore-input:visible').nth(scheduleInputs.date.index).inputValue();
                            const defaultTime = await page.locator('input.TUXTextInputCore-input:visible').nth(scheduleInputs.time.index).inputValue();
                            log(`TikTok default schedule: ${defaultDate} ${defaultTime}`);

                            lastScheduledTime = parseScheduleValue(defaultDate, defaultTime);
                            if (lastScheduledTime) {
                                // Mốc do TikTok tự điền, ta không sửa — vẫn là
                                // lịch thật của video này.
                                scheduledThisVideo = lastScheduledTime;
                                log(`Captured base time: ${lastScheduledTime.toISOString()}`);
                            } else {
                                log(`Warning: Failed to parse default time. Using fallback.`);
                                lastScheduledTime = computeAutoIncrementTime({ lastScheduledTime: null, intervalMinutes: profile.schedule_interval || 5, now: new Date() });
                            }
                        } else {
                            // Video 3+: Increment by intervalMinutes (5 or 10 mins)
                            const intervalMin = profile.schedule_interval || 5;
                            lastScheduledTime = computeAutoIncrementTime({ lastScheduledTime, intervalMinutes: intervalMin });
                            const dateValue = formatScheduleValue(lastScheduledTime, 'date', scheduleInputs.date || {});
                            const timeValue = formatScheduleValue(lastScheduledTime, 'time', scheduleInputs.time || {});

                            log(`Setting incremented schedule: ${dateValue} ${timeValue}`);
                            await fillScheduleInput(page, scheduleInputs.date, dateValue, 'Date', log);
                            await fillScheduleInput(page, scheduleInputs.time, timeValue, 'Time', log);
                            scheduledThisVideo = lastScheduledTime;
                            await page.waitForTimeout(2000);
                        }

                        await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_autoincrement_${i + 1}.png`) }).catch(() => null);
                    }
                } catch (e) {
                    log(`Auto-increment scheduling failed: ${e.message}`);
                    if (hasExistingSchedule || delayedStart) {
                        log(`WARNING: video ${i + 1} will be posted immediately instead of being scheduled.`);
                    }
                }
            } else if (!(limitUploads && uploadLimitCount === 1) && profile.is_scheduled && i >= 3) {
                try {
                    log(`Task 3: Scheduling video ${i + 1}...`);

                    // 1. Calculate schedule time
                    lastScheduledTime = computeNextScheduledTime({
                        index: i,
                        lastScheduledTime,
                        intervalMinutes: profile.schedule_interval || 5,
                        now: new Date()
                    });

                    if (lastScheduledTime) {
                        const dateStr = formatScheduleValue(lastScheduledTime, 'date');
                        const timeStr = formatScheduleValue(lastScheduledTime, 'time');
                        log(`Target schedule (Local): ${dateStr} ${timeStr}`);

                        // 2. Click "Schedule" radio
                        const scheduleRadio = 'input[value="schedule"]';
                        log(`Waiting for schedule radio: ${scheduleRadio}`);
                        const scheduleRadioInput = page.locator(scheduleRadio).first();
                        await scheduleRadioInput.waitFor({ timeout: 15000, state: 'attached' });
                        await scheduleRadioInput.scrollIntoViewIfNeeded().catch(() => null);
                        await scheduleRadioInput.check({ force: true }).catch(async () => {
                            await scheduleRadioInput.click({ force: true });
                        });

                        log(`Selected "Schedule" option.`);
                        await page.waitForTimeout(3000);

                        // 3. Resolve visible date/time inputs and fill them via Playwright
                        const scheduleInputs = await resolveScheduleInputs(page, log);
                        const resolvedDateValue = formatScheduleValue(lastScheduledTime, 'date', scheduleInputs.date || {});
                        const resolvedTimeValue = formatScheduleValue(lastScheduledTime, 'time', scheduleInputs.time || {});

                        await fillScheduleInput(page, scheduleInputs.date, resolvedDateValue, 'Date', log);
                        await fillScheduleInput(page, scheduleInputs.time, resolvedTimeValue, 'Time', log);
                        scheduledThisVideo = lastScheduledTime;

                        await page.waitForTimeout(3000); // Increased wait for UI to settle

                        // Verification screenshot
                        await page.screenshot({ path: path.join(__dirname, `debug_${profile.name}_scheduled_${i + 1}.png`) }).catch(() => null);
                    }
                } catch (e) {
                    log(`Scheduling task failed: ${e.message}`);
                }
            }
            // --- END TASK 3 ---

            log(`Starting Post click sequence...`);
            let clickedPost = false;
            let capturedVideoId = null;

            // Intercept TikTok API responses to capture the video ID
            const responseHandler = async (response) => {
                try {
                    const url = response.url();
                    const status = response.status();
                    if (status >= 200 && status < 300 &&
                        (url.includes('/publish') || url.includes('/create') || url.includes('/post') ||
                         url.includes('/upload') || url.includes('/item'))) {
                        const contentType = response.headers()['content-type'] || '';
                        if (contentType.includes('json')) {
                            const text = await response.text().catch(() => '');
                            if (text) {
                                // Search for video/item ID patterns in the response body
                                const idPatterns = [
                                    /"publish_id"\s*:\s*"(\d+)"/,
                                    /"video_id"\s*:\s*"(\d+)"/,
                                    /"item_id"\s*:\s*"(\d+)"/,
                                    /"aweme_id"\s*:\s*"(\d+)"/,
                                    /"id"\s*:\s*"(\d{15,})"/,
                                ];
                                for (const pattern of idPatterns) {
                                    const match = text.match(pattern);
                                    if (match && match[1]) {
                                        capturedVideoId = match[1];
                                        log(`Captured video ID from API: ${capturedVideoId} (via ${url.split('?')[0]})`);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) { /* silently ignore */ }
            };
            page.on('response', responseHandler);

            for (let clickAttempt = 0; clickAttempt < 10; clickAttempt++) {
                await dismissPopups(page);

                const postSelectors = [
                    'button.common-button-post-video',
                    '[data-e2e="post_video_button"]',
                    'button:has-text("Post"):not(:has-text("draft"))',
                ];

                let targetBtn = null;
                for (const sel of postSelectors) {
                    const btn = await page.$(sel);
                    if (btn && await btn.isVisible() && !await btn.isDisabled()) {
                        targetBtn = btn;
                        break;
                    }
                }

                if (targetBtn) {
                    log(`Clicking Post button (Attempt ${clickAttempt + 1})...`);
                    try {
                        // Strategy A: Real browser click
                        await targetBtn.click({ force: true, timeout: 5000 });
                    } catch (e) {
                        // Strategy B: Evaluate click fallback
                        await targetBtn.evaluate(node => node.click()).catch(() => null);
                    }
                    await dismissPopups(page);
                }

                // Success detection polling (Wait up to 15s per attempt)
                for (let poll = 0; poll < 3; poll++) {
                    await page.waitForTimeout(5000);

                    const postBtnGone = !await page.$('button:has-text("Post")');
                    const successMsg = await page.$('text="Uploaded", text="Success", text="View video", text="Manage your posts", text="Share video"');
                    const redirected = !page.url().includes('upload') || page.url().includes('manage') || page.url().includes('content');

                    if (postBtnGone || successMsg || redirected) {
                        log(`Post confirmed! (btnGone: ${postBtnGone}, msg: ${!!successMsg}, redirected: ${redirected})`);
                        clickedPost = true;
                        break;
                    }

                    // Check if button text changed to "Posting..."
                    const btnText = await targetBtn?.innerText().catch(() => "");
                    if (btnText?.includes("Posting")) {
                        log("Status: Posting in progress...");
                    }

                    await dismissPopups(page);
                }

                if (clickedPost) break;
            }

            // Remove the response listener
            page.removeListener('response', responseHandler);

            if (clickedPost) {
                log(`Finalizing upload for ${videoFileName}...`);

                // Ghi mốc hẹn giờ sau khi TikTok đã nhận bài: điền được vào form
                // mà Post hỏng thì chẳng có lịch nào tồn tại để mà báo.
                if (scheduledThisVideo) {
                    try {
                        db.prepare('UPDATE profiles SET last_scheduled_at = ? WHERE id = ?')
                            .run(scheduledThisVideo.toISOString(), profile.id);
                        log(`Latest scheduled slot for this run: ${scheduledThisVideo.toISOString()}`);
                    } catch (err) {
                        log(`ERROR recording last_scheduled_at: ${err.message}`);
                    }
                }

                let videoLink = null;

                // Build the video link from the captured video ID
                if (capturedVideoId) {
                    videoLink = `https://www.tiktok.com/@${profile.name}/video/${capturedVideoId}`;
                    log(`Built video link from captured ID: ${videoLink}`);
                } else {
                    // Fallback: try to find a video ID from the current page URL
                    try {
                        const currentUrl = page.url();
                        const urlMatch = currentUrl.match(/\/video\/(\d+)/);
                        if (urlMatch) {
                            videoLink = `https://www.tiktok.com/@${profile.name}/video/${urlMatch[1]}`;
                            log(`Built video link from current URL: ${videoLink}`);
                        } else {
                            log(`No video ID captured from API or URL.`);
                        }
                    } catch (e) {
                        log(`Error checking URL for video ID: ${e.message}`);
                    }
                }

                // Đếm trước khi dọn file: bài đã lên TikTok rồi, kho lưu hỏng
                // cũng không làm nó chưa được đăng. Trước đây uploadedCount nằm
                // sau bước xoá nên một lỗi file lẻ là lượt chạy đăng lố quá số
                // video đã giới hạn.
                uploadedCount++;

                try {
                    if (fs.existsSync(videoPath)) {
                        const archivedPath = archiveUploadedVideo(videoPath, profile.name);
                        log(`SUCCESS: Moved ${videoFileName} to ${archivedPath} after upload.`);
                    }
                } catch (err) {
                    // Không xoá bù khi chuyển hỏng: mất video nặng hơn đăng
                    // trùng. Nhưng phải nói rõ file còn nằm nguyên chỗ cũ, vì
                    // lượt chạy sau sẽ nhặt lại đúng nó.
                    log(`ERROR archiving file: ${err.message}. ${videoFileName} vẫn nằm trong ${videoFolder} và sẽ được đăng lại ở lượt sau.`);
                }

                try {
                    let message = `🎉 <b>Upload TikTok thành công!</b>\n` +
                                  `👤 <b>Profile:</b> <code>${profile.name}</code>\n` +
                                  `📹 <b>Video:</b> <code>${videoFileName}</code>\n` +
                                  `📅 <b>Thời gian:</b> <code>${new Date().toLocaleString('vi-VN')}</code>`;
                    if (videoLink) {
                        message += `\n🔗 <b>Link video:</b> <a href="${videoLink}">${videoLink}</a>`;
                    }
                    await sendTelegramNotification(message);
                } catch (telegramErr) {
                    log(`ERROR sending Telegram notification: ${telegramErr.message}`);
                }

                // Wait before next loop iteration to let things settle
                if (i < videos.length - 1) {
                    log(`Preparing for next video...`);
                    await page.waitForTimeout(5000);
                }
            }
        }
        return uploadedCount;
    } catch (error) {
        fs.appendFileSync(path.join(__dirname, 'automation.log'), `[${new Date().toISOString()}] CRITICAL ERROR: ${error.message}\n${error.stack}\n`);
        throw error;
    } finally {
        log(`Automation session ended.`);
        await browser.close().catch(() => null);
    }
}

// =============================================
// AUTO ENGAGE FEATURE
// =============================================

// Comment templates để khen video (mix Anh-Việt tự nhiên)
const ENGAGE_COMMENTS = [
    '🔥🔥🔥',
    'This is so good!',
    'Love this content! 💯',
    'Amazing! Keep it up! 👏',
    'Bro really said no days off 💪',
    'This made my day fr fr',
    'Goated content right here 🐐',
    'W video no cap',
    'You never miss 🎯',
    'So underrated omg',
    'POV: quality content',
    'Nailed it! 🙌',
    'Literally obsessed with this 😍',
    'Bro ate that up 🔥',
    'Not me watching this 10 times',
    'Câu này hay quá 🤩',
    'Video hay vl 😭❤️',
    'Content creator xịn sò 👑',
    'Ủa hay v trời 🔥',
    'Xem đi xem lại không chán',
];

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// POST /api/engage — Bắt đầu auto engage session
app.post('/api/engage', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (runningProfiles.has(profileId) || processingProfiles.has(profileId) || queuedProfileIds.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently running upload automation or processing a video' });
    }
    if (engagingProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is already engaging' });
    }

    // Start engage session in background
    runEngageSession(profile).catch(err =>
        console.error(`[${profile.name}] Engage session error:`, err)
    );

    res.json({ status: 'started', profile: profile.name });
});

// POST /api/engage/stop — Dừng auto engage session
app.post('/api/engage/stop', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const session = engagingProfiles.get(profileId);
    if (!session) {
        return res.status(400).json({ error: 'Profile is not currently engaging' });
    }

    // Signal stop
    session.stop = true;
    res.json({ status: 'stopping', message: 'Engage session will stop shortly' });
});

// GET /api/engage/status/:profileId — Kiểm tra trạng thái engage
app.get('/api/engage/status/:profileId', (req, res) => {
    const profileId = req.params.profileId;
    const session = engagingProfiles.get(profileId);
    res.json({
        engaging: !!session,
        stats: session ? session.stats : null
    });
});

// =============================================
// LOGIN TIKTOK FEATURE
// =============================================

// POST /api/login-tiktok — Start TikTok login session
app.post('/api/login-tiktok', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    if (runningProfiles.has(profileId) || processingProfiles.has(profileId) || queuedProfileIds.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently running upload automation or processing a video' });
    }
    if (engagingProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is currently engaging' });
    }
    if (loggingInProfiles.has(profileId)) {
        return res.status(400).json({ error: 'Profile is already in login process' });
    }
    if (!profile.cookies && (!profile.email || !profile.pass)) {
        return res.status(400).json({ error: 'Profile has no cookies or email/password. Import CSV first.' });
    }

    // Start login session in background
    runTikTokLogin(profile).catch(err =>
        console.error(`[${profile.name}] Login session error:`, err)
    );

    res.json({ status: 'started', profile: profile.name });
});

// POST /api/login-tiktok/stop — Stop login session
app.post('/api/login-tiktok/stop', async (req, res) => {
    const { profileId } = req.body;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const session = loggingInProfiles.get(profileId);
    if (!session) {
        return res.status(400).json({ error: 'Profile is not in login process' });
    }

    session.stop = true;
    res.json({ status: 'stopping', message: 'Login session will stop shortly' });
});

// GET /api/login-tiktok/status/:profileId — Get login session status
app.get('/api/login-tiktok/status/:profileId', (req, res) => {
    const profileId = req.params.profileId;
    const session = loggingInProfiles.get(profileId);
    res.json({
        loggingIn: !!session,
        stats: session ? session.stats : null
    });
});

async function runEngageSession(profile) {
    const profileId = profile.id;
    const userDataDir = path.join(PROFILES_DIR, profile.name);

    const log = (msg) => {
        const entry = `[${new Date().toISOString()}] [${profile.name}][ENGAGE] ${msg}\n`;
        console.log(entry.trim());
        try {
            fs.appendFileSync(path.join(__dirname, 'automation.log'), entry);
        } catch (e) { }
    };

    const browserOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    };

    if (profile.proxy) {
        const proxyConfig = parseProxy(profile.proxy);
        if (proxyConfig) {
            browserOptions.proxy = proxyConfig;
            log(`Using proxy: ${proxyConfig.server}`);
        }
    }

    const browser = await chromium.launchPersistentContext(userDataDir, browserOptions);
    await injectProfileCookies(browser, profile);

    const session = { browser, stop: false, stats: { videosWatched: 0, likes: 0, comments: 0, channelVisits: 0 } };
    engagingProfiles.set(profileId, session);
    db.prepare("UPDATE profiles SET status = ? WHERE id = ?").run('engaging', profileId);

    log('Engage session started');

    try {
        const page = await browser.newPage();

        // Điều hướng đến trang For You
        await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        await page.waitForTimeout(3000);

        // Dismiss any initial popups/login prompts
        await engageDismissPopups(page, log);

        let videosSinceLastChannelVisit = 0;
        let nextChannelVisitAt = randomInt(10, 15);

        while (!session.stop) {
            try {
                // === BƯỚC 1: Xem video hiện tại ===
                const watchTime = randomInt(10000, 30000); // 10–30 giây (ms)
                log(`Watching video for ${(watchTime / 1000).toFixed(1)}s...`);

                // Chia watch time thành nhiều đoạn nhỏ để check stop signal
                const checkInterval = 2000;
                let elapsed = 0;
                while (elapsed < watchTime && !session.stop) {
                    await page.waitForTimeout(Math.min(checkInterval, watchTime - elapsed));
                    elapsed += checkInterval;
                }

                if (session.stop) break;

                session.stats.videosWatched++;
                videosSinceLastChannelVisit++;

                // === BƯỚC 2: Like (xác suất ~15%) ===
                if (Math.random() < 0.15) {
                    try {
                        await engageLike(page, log);
                        session.stats.likes++;
                    } catch (e) {
                        log(`Like failed: ${e.message}`);
                    }
                    await page.waitForTimeout(randomInt(800, 1500));
                }

                // === BƯỚC 3: Comment (xác suất ~5%) ===
                if (!session.stop && Math.random() < 0.05) {
                    try {
                        await engageComment(page, log);
                        session.stats.comments++;
                    } catch (e) {
                        log(`Comment failed: ${e.message}`);
                    }
                    await page.waitForTimeout(randomInt(1000, 2000));
                }

                if (session.stop) break;

                // === BƯỚC 4: Visit channel sau mỗi 10–15 video ===
                if (videosSinceLastChannelVisit >= nextChannelVisitAt) {
                    try {
                        log(`Visiting creator channel (after ${videosSinceLastChannelVisit} videos)...`);
                        const visited = await engageVisitChannel(page, session, log);
                        if (visited) {
                            session.stats.channelVisits++;
                        }
                    } catch (e) {
                        log(`Channel visit failed: ${e.message}`);
                    }

                    // Reset counter
                    videosSinceLastChannelVisit = 0;
                    nextChannelVisitAt = randomInt(10, 15);

                    if (session.stop) break;

                    // Quay lại trang chủ
                    log('Returning to For You page...');
                    await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
                    await page.waitForTimeout(randomInt(2000, 4000));
                    await engageDismissPopups(page, log);
                } else {
                    // === BƯỚC 5: Scroll xuống video tiếp theo ===
                    if (!session.stop) {
                        await engageScrollToNext(page, log);
                        await page.waitForTimeout(randomInt(1000, 2000));
                    }
                }

                log(`Stats: watched=${session.stats.videosWatched}, likes=${session.stats.likes}, comments=${session.stats.comments}, channels=${session.stats.channelVisits}`);

            } catch (loopErr) {
                log(`Loop error (continuing): ${loopErr.message}`);
                await page.waitForTimeout(3000);
                // Cố gắng quay về For You nếu bị lạc
                await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
                await page.waitForTimeout(2000);
            }
        }

        log(`Engage session stopped. Final stats: ${JSON.stringify(session.stats)}`);

    } catch (err) {
        log(`Session critical error: ${err.message}`);
    } finally {
        engagingProfiles.delete(profileId);
        await browser.close().catch(() => null);
        db.prepare("UPDATE profiles SET status = 'idle' WHERE id = ?").run(profileId);
        log('Engage session ended, browser closed.');
    }
}

// Like video hiện tại
async function engageLike(page, log) {
    const likeSelectors = [
        '[data-e2e="like-icon"]',
        'button[aria-label*="like" i]:not([aria-label*="comment" i])',
        '[class*="LikeIcon"]',
        'span[class*="like"] svg',
    ];

    for (const sel of likeSelectors) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
                // Kiểm tra xem đã like chưa (tránh unlike)
                const isLiked = await el.evaluate(node => {
                    const btn = node.closest('button') || node;
                    return btn.getAttribute('aria-pressed') === 'true'
                        || btn.classList.toString().includes('active')
                        || btn.classList.toString().includes('liked');
                }).catch(() => false);

                if (!isLiked) {
                    await el.click({ force: true });
                    log(`Liked video via ${sel}`);
                    return true;
                } else {
                    log(`Video already liked, skipping`);
                    return false;
                }
            }
        } catch (e) { }
    }
    log(`Like button not found`);
    return false;
}

// Comment vào video hiện tại
async function engageComment(page, log) {
    const comment = randomItem(ENGAGE_COMMENTS);

    // Mở comment box
    const commentBtnSelectors = [
        '[data-e2e="comment-icon"]',
        'button[aria-label*="comment" i]',
        '[class*="CommentIcon"]',
    ];

    let opened = false;
    for (const sel of commentBtnSelectors) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
                await el.click({ force: true });
                opened = true;
                log(`Opened comment box via ${sel}`);
                break;
            }
        } catch (e) { }
    }

    if (!opened) {
        log('Could not open comment box');
        return false;
    }

    await page.waitForTimeout(1500);

    // Tìm input box comment
    const inputSelectors = [
        '[data-e2e="comment-input"]',
        'div[contenteditable="true"][placeholder*="comment" i]',
        'div[contenteditable="true"]',
        'textarea[placeholder*="comment" i]',
    ];

    for (const sel of inputSelectors) {
        try {
            const input = await page.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
            if (input) {
                await input.click();
                await page.waitForTimeout(500);
                await page.keyboard.type(comment, { delay: randomInt(50, 120) });
                await page.waitForTimeout(randomInt(500, 1000));

                // Submit comment
                await page.keyboard.press('Enter');
                log(`Commented: "${comment}"`);
                await page.waitForTimeout(1000);

                // Đóng comment panel bằng ESC hoặc click ngoài
                await page.keyboard.press('Escape');
                return true;
            }
        } catch (e) { }
    }

    log('Comment input not found, pressing Escape to close');
    await page.keyboard.press('Escape');
    return false;
}

// Visit kênh của creator video hiện tại, xem 1–3 video rồi quay về
async function engageVisitChannel(page, session, log) {
    // Click vào tên/avatar creator
    const creatorSelectors = [
        '[data-e2e="video-author-uniqueid"]',
        'a[href*="/@"]',
        '[class*="AuthorTitle"] a',
        '[class*="author-uniqueId"] a',
        'h3[class*="AuthorUniqueId"] a',
    ];

    let channelUrl = null;
    for (const sel of creatorSelectors) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
                const href = await el.getAttribute('href').catch(() => null);
                if (href && href.includes('/@')) {
                    channelUrl = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
                    log(`Found creator link: ${channelUrl}`);
                    break;
                }
            }
        } catch (e) { }
    }

    if (!channelUrl) {
        log('Creator link not found, skipping channel visit');
        return false;
    }

    // Điều hướng đến kênh
    await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(randomInt(2000, 3500));
    await engageDismissPopups(page, log);

    if (session.stop) return true;

    // Tìm danh sách video trên kênh và click vào 1–3 video ngẫu nhiên
    const numVideosToWatch = randomInt(1, 3);
    log(`Will watch ${numVideosToWatch} video(s) on this channel`);

    const videoLinkSelectors = [
        '[data-e2e="user-post-item"] a',
        'div[class*="DivWrapper"] a[href*="/video/"]',
        'a[href*="/video/"]',
    ];

    let videoLinks = [];
    for (const sel of videoLinkSelectors) {
        try {
            const els = await page.$$(sel);
            if (els.length > 0) {
                // Lấy href của từng video
                const hrefs = [];
                for (const el of els.slice(0, 12)) {
                    const href = await el.getAttribute('href').catch(() => null);
                    if (href && href.includes('/video/')) {
                        const fullUrl = href.startsWith('http') ? href : `https://www.tiktok.com${href}`;
                        if (!hrefs.includes(fullUrl)) hrefs.push(fullUrl);
                    }
                }
                if (hrefs.length > 0) {
                    videoLinks = hrefs;
                    break;
                }
            }
        } catch (e) { }
    }

    if (videoLinks.length === 0) {
        log('No video links found on channel, returning');
        return true;
    }

    // Chọn ngẫu nhiên các video để xem
    const shuffled = videoLinks.sort(() => Math.random() - 0.5);
    const toWatch = shuffled.slice(0, Math.min(numVideosToWatch, shuffled.length));

    for (const videoUrl of toWatch) {
        if (session.stop) break;

        try {
            log(`Watching channel video: ${videoUrl}`);
            await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
            await page.waitForTimeout(randomInt(2000, 3000));
            await engageDismissPopups(page, log);

            // Xem video 10–25 giây
            const watchTime = randomInt(10000, 25000);
            log(`Watching for ${(watchTime / 1000).toFixed(1)}s...`);

            let elapsed = 0;
            const checkInterval = 2000;
            while (elapsed < watchTime && !session.stop) {
                await page.waitForTimeout(Math.min(checkInterval, watchTime - elapsed));
                elapsed += checkInterval;
            }

            session.stats.videosWatched++;

            // Like với xác suất 20% (cao hơn khi đang trong kênh)
            if (!session.stop && Math.random() < 0.20) {
                try {
                    await engageLike(page, log);
                    session.stats.likes++;
                } catch (e) { }
            }

        } catch (e) {
            log(`Error watching channel video: ${e.message}`);
        }

        await page.waitForTimeout(randomInt(1000, 2000));
    }

    return true;
}

// Scroll xuống video tiếp theo trên For You page
async function engageScrollToNext(page, log) {
    try {
        // Phương án 1: Nhấn phím mũi tên xuống
        await page.keyboard.press('ArrowDown');
        log('Scrolled to next video (ArrowDown)');
        return;
    } catch (e) { }

    try {
        // Phương án 2: Scroll chuột
        await page.mouse.wheel(0, 800);
        log('Scrolled to next video (wheel)');
    } catch (e) {
        log(`Scroll failed: ${e.message}`);
    }
}

// Dismiss popup nhẹ nhàng (phiên bản cho engage — không dùng lại dismissPopups upload)
async function engageDismissPopups(page, log) {
    const dismissSelectors = [
        'button:has-text("Log in later")',
        'button:has-text("Not now")',
        'button:has-text("Skip")',
        'button:has-text("Got it")',
        'button:has-text("Allow")',
        '[aria-label="Close"]',
        'button[class*="close" i]',
    ];
    for (const sel of dismissSelectors) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) {
                await el.click();
                log(`Dismissed popup: ${sel}`);
                await page.waitForTimeout(500);
            }
        } catch (e) { }
    }
}

// =============================================
// END AUTO ENGAGE FEATURE
// =============================================

// =============================================
// LOGIN TIKTOK SESSION
// =============================================

async function retrieveVerificationCode(browser, profile, log, triedCodes = new Set()) {
    const emailPage = await browser.newPage();
    try {
        // Navigate to Outlook Web Access — will redirect to Microsoft login if needed
        await emailPage.goto('https://outlook.office.com/mail/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await emailPage.waitForTimeout(5000);

        const currentUrl = emailPage.url();
        log(`Hotmail tab URL: ${currentUrl}`);

        // Check if already logged into Hotmail
        const isLoggedIn = await emailPage.evaluate(() => {
            const body = (document.body.innerText || '');
            return body.includes('Inbox') || body.includes('Hộp thư đến')
                || !!document.querySelector('[aria-label="Inbox"], [title="Inbox"], [data-app-section="MailModule"]');
        }).catch(() => false);

        if (!isLoggedIn) {
            log('Hotmail not logged in. Signing in...');

            // Find email input
            const emailSelectors = [
                'input[type="email"]',
                'input[name="loginfmt"]',
                'input[placeholder*="email" i]',
                'input[placeholder*="Email"]',
                'input#i0116',
            ];

            let emailField = null;
            for (const sel of emailSelectors) {
                emailField = await emailPage.waitForSelector(sel, { timeout: 8000, state: 'visible' }).catch(() => null);
                if (emailField) break;
            }

            if (!emailField) {
                const allInputs = await emailPage.$$('input:visible');
                for (const input of allInputs) {
                    const type = await input.getAttribute('type').catch(() => 'text');
                    if (type !== 'password' && type !== 'hidden' && type !== 'submit' && type !== 'checkbox') {
                        emailField = input;
                        break;
                    }
                }
            }

            if (!emailField) throw new Error('Could not find Hotmail email input');
            await emailField.click();
            await emailField.fill(profile.email);
            log('Hotmail: email entered');

            // Click Next
            await emailPage.waitForTimeout(500);
            const nextBtn = await emailPage.waitForSelector(
                'input[type="submit"], button[type="submit"], #idSIButton9',
                { timeout: 5000 }
            ).catch(() => null);
            if (nextBtn) {
                await nextBtn.click();
                log('Hotmail: clicked Next');
            }

            // Wait for page transition — MS redirects after email
            // After email, Microsoft may show different UIs depending on the account:
            //   Variant A: "Use your password" link is visible directly
            //   Variant B: "Verify your email" screen with "Use your password" link
            //   Variant C: "Other ways to sign in" must be clicked first, then "Use your password" appears
            //   Variant D: "Other ways to sign in" then "Password" option then password field
            await emailPage.waitForTimeout(4000);
            const afterNextUrl = emailPage.url();
            log(`Hotmail: after Next URL = ${afterNextUrl}`);

            // Check if already redirected to inbox (auto-login via session cookie)
            if (afterNextUrl.includes('/mail') && afterNextUrl.includes('outlook.live.com')) {
                log('Hotmail: auto-login detected, already on inbox. Skipping password...');
            } else {

            // --- STEP A: Handle "Other ways to sign in" if present ---
            // Some MS login variants hide the password option behind this link
            const otherWaysSelectors = [
                ':text("Other ways to sign in")',
                ':text-matches("other ways to sign", "i")',
                ':text-matches("other ways to sign in", "i")',
                'a:has-text("Other ways to sign")',
                'span:has-text("Other ways to sign")',
                'button:has-text("Other ways to sign")',
            ];
            for (const sel of otherWaysSelectors) {
                const otherWaysBtn = await emailPage.$(sel);
                if (otherWaysBtn && await otherWaysBtn.isVisible().catch(() => false)) {
                    await otherWaysBtn.click();
                    log(`Hotmail: clicked "Other ways to sign in" via ${sel}`);
                    await emailPage.waitForTimeout(3000);
                    break;
                }
            }

            // --- STEP B: Click "Use your password" or "Password" option ---
            // After "Other ways to sign in" (or directly), find and click the password option
            const usePwSelectors = [
                ':text("Use your password")',
                ':text("use your password")',
                ':text("Password")',
                'a:has-text("password"), button:has-text("password")',
                'span:has-text("Use your password")',
                'span:has-text("Password")',
                '#aadTile, #aadTileTitle',
            ];
            for (const sel of usePwSelectors) {
                const usePwBtn = await emailPage.$(sel);
                if (usePwBtn && await usePwBtn.isVisible().catch(() => false)) {
                    await usePwBtn.click();
                    log(`Hotmail: clicked "Use your password" via ${sel}`);
                    await emailPage.waitForTimeout(3000);
                    break;
                }
            }

            // --- STEP C: Handle password entry ---
            // But first check if auto-login redirected us away from login page
            const afterPwWaitUrl = emailPage.url();
            if (!afterPwWaitUrl.includes('login') && !afterPwWaitUrl.includes('live.com')) {
                log('Hotmail: auto-login detected (already on inbox). Skipping password...');
            } else {
                // Wait for password field — MS Fluent UI may use #passwordEntry or #i0118
                let passField = await emailPage.waitForSelector(
                    'input[type="password"]:visible, input#passwordEntry:visible, input#i0118:visible',
                    { timeout: 20000 }
                ).catch(() => null);

                if (passField && profile.pass_email) {
                    await passField.click();
                    await passField.fill(profile.pass_email);
                    log('Hotmail: password entered');

                    await emailPage.waitForTimeout(500);
                    // Submit button — Fluent UI <button>Next</button> may not have type="submit"
                    const signInBtn = await emailPage.waitForSelector(
                        'input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9, button:has-text("Next"):visible, button:has-text("Sign in"):visible',
                        { timeout: 8000 }
                    ).catch(() => null);
                    if (signInBtn) {
                        await signInBtn.click();
                        log('Hotmail: clicked Sign in');
                    }

                    await emailPage.waitForTimeout(5000);
                    log(`Hotmail: after sign-in URL = ${emailPage.url()}`);

                    // Dismiss "Stay signed in?" if present
                    const stayBtn = await emailPage.waitForSelector(
                        'input[type="submit"]:visible, button[type="submit"]:visible, #idSIButton9, button:has-text("Yes"):visible',
                        { timeout: 5000 }
                    ).catch(() => null);
                    if (stayBtn) {
                        await stayBtn.click();
                        log('Hotmail: dismissed "Stay signed in?" prompt');
                        await emailPage.waitForTimeout(3000);
                    }
                } else if (passField && !profile.pass_email) {
                    log('Hotmail: password field found but no pass_email set. Waiting 60s for manual login...');
                    await emailPage.waitForTimeout(60000);
                } else {
                    // Check if we're already redirected to inbox (auto-login via session cookie)
                    const currentPwUrl = emailPage.url();
                    if (!currentPwUrl.includes('login') && !currentPwUrl.includes('live.com')) {
                        log('Hotmail: password field not needed, already on inbox.');
                    } else {
                        // Debug: log all input elements on the page
                        const debugInfo = await emailPage.evaluate(() => {
                            const inputs = document.querySelectorAll('input');
                            const info = [];
                            for (const inp of inputs) {
                                if (inp.type === 'hidden' || inp.type === 'submit') continue;
                                info.push({
                                    type: inp.type,
                                    name: inp.getAttribute('name') || '',
                                    id: inp.id || '',
                                    placeholder: inp.getAttribute('placeholder') || '',
                                    visible: inp.offsetParent !== null
                                });
                            }
                            return info;
                        }).catch(() => []);
                        log(`Hotmail: debug inputs found: ${JSON.stringify(debugInfo)}`);

                        // Also log visible buttons to help debug
                        const debugBtns = await emailPage.evaluate(() => {
                            const buttons = document.querySelectorAll('button, input[type="submit"]');
                            const info = [];
                            for (const b of buttons) {
                                if (b.offsetParent !== null) {
                                    info.push({ tag: b.tagName, id: b.id || '', text: (b.innerText || b.value || '').substring(0, 60).trim() });
                                }
                            }
                            return info;
                        }).catch(() => []);
                        log(`Hotmail: debug visible buttons: ${JSON.stringify(debugBtns)}`);

                        log('Hotmail: password field not found. Waiting 60s for manual login...');
                        await emailPage.waitForTimeout(60000);
                    }
                }
            }

            } // end else (not auto-login)

            log('Hotmail: sign-in step completed');
        } else {
            log('Hotmail: already logged in');
        }

        // Ensure we're on the inbox page after login
        const finalUrl = emailPage.url();
        if (!finalUrl.includes('/mail') && !finalUrl.includes('outlook.live.com')) {
            log(`Redirecting to inbox from: ${finalUrl}`);
            await emailPage.goto('https://outlook.live.com/mail/', {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            }).catch(() => null);
            await emailPage.waitForTimeout(5000);
        }

        // Poll inbox for TikTok verification email
        log('Polling Hotmail inbox for TikTok verification email...');
        const maxPollTime = 2 * 60 * 1000;
        const pollStart = Date.now();
        const processedEmails = new Set();  // email text fingerprints already checked

        while (Date.now() - pollStart < maxPollTime) {
            // Reload inbox to get latest emails
            await emailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
            await emailPage.waitForTimeout(3000);

            // Collect text fingerprints of all TikTok emails currently in inbox
            const emailIds = await emailPage.evaluate(() => {
                const results = [];
                const allElements = document.querySelectorAll(
                    'div[role="option"], div[role="link"], div[class*="row"], ' +
                    'div[class*="message"], div[class*="item"], span[class*="subject"]'
                );
                for (const el of allElements) {
                    const text = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
                    if (text.includes('tiktok') || text.includes('tik tok')
                        || text.includes('verification code') || text.includes('security code')
                        || text.includes('login code') || text.includes('sign-in code')
                        || text.includes('mã xác minh')) {
                        // Use first 100 chars as fingerprint (subject + sender, skip relative timestamps)
                        results.push(text.substring(0, 100).replace(/\d+m(?:in)?\s*ago|just now|\d+:\d+\s*[ap]m/gi, ''));
                    }
                }
                return results;
            }).catch(() => []);

            if (emailIds.length > 0) {
                log(`Found ${emailIds.length} TikTok email(s) in inbox`);

                // Try each unprocessed email, newest first
                for (let i = 0; i < emailIds.length; i++) {
                    const emailFingerprint = emailIds[i];
                    if (processedEmails.has(emailFingerprint)) {
                        log(`Email #${i + 1} already processed, skipping...`);
                        continue;
                    }
                    processedEmails.add(emailFingerprint);

                    // Click this specific email by index
                    const clicked = await emailPage.evaluate((index) => {
                        const allElements = document.querySelectorAll(
                            'div[role="option"], div[role="link"], div[class*="row"], ' +
                            'div[class*="message"], div[class*="item"], span[class*="subject"]'
                        );
                        const matches = [];
                        for (const el of allElements) {
                            const text = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
                            if (text.includes('tiktok') || text.includes('tik tok')
                                || text.includes('verification code') || text.includes('security code')
                                || text.includes('login code') || text.includes('sign-in code')
                                || text.includes('mã xác minh')) {
                                matches.push(el);
                            }
                        }
                        if (index < matches.length) {
                            const clickTarget = matches[index].closest('[role="option"], [role="link"], div[class*="row"], div[class*="message"]') || matches[index];
                            clickTarget.click();
                            return true;
                        }
                        return false;
                    }, i).catch(() => false);

                    if (!clicked) continue;

                    log(`Opened TikTok email #${i + 1}, extracting code...`);
                    await emailPage.waitForTimeout(5000);

                    const code = await emailPage.evaluate(() => {
                        const body = (document.body.innerText || '').replace(/\s+/g, ' ');
                        const patterns = [
                            /\b(\d{6})\b/,
                            /\b(\d{5})\b/,
                            /\b(\d{4})\b/,
                            /code[:\s]*(\d{4,6})/i,
                            /(\d{4,6})\s*(?:is|your|security|verification)/i,
                            /verif[yi].{0,20}?(\d{4,6})/i,
                        ];
                        for (const pattern of patterns) {
                            const match = body.match(pattern);
                            if (match && match[1]) {
                                const code = match[1];
                                const blocked = ['2022', '2023', '2024', '2025', '2026', '2027', '2028'];
                                if (!blocked.includes(code) && code.length >= 4 && code.length <= 6) {
                                    return code;
                                }
                            }
                        }
                        return null;
                    });

                    if (code && !triedCodes.has(code)) {
                        triedCodes.add(code);
                        log(`Verification code extracted from email #${i + 1}: ${code}`);
                        return code;
                    } else if (code) {
                        log(`Email #${i + 1} code ${code} already tried, checking next email...`);
                        // Go back to inbox to try next email
                        await emailPage.goto('https://outlook.live.com/mail/', {
                            waitUntil: 'domcontentloaded', timeout: 15000
                        }).catch(() => null);
                        await emailPage.waitForTimeout(3000);
                    } else {
                        log(`Email #${i + 1}: could not extract code, checking next...`);
                        await emailPage.goto('https://outlook.live.com/mail/', {
                            waitUntil: 'domcontentloaded', timeout: 15000
                        }).catch(() => null);
                        await emailPage.waitForTimeout(3000);
                    }
                }

                log('All visible TikTok emails processed, waiting for new email...');
            } else {
                log('No TikTok emails in inbox yet, waiting 10s...');
            }

            await emailPage.waitForTimeout(10000);
        }

        log('Timed out waiting for verification email');
        return null;
    } finally {
        await emailPage.close().catch(() => null);
    }
}

async function runTikTokLogin(profile) {
    const profileId = profile.id;
    const userDataDir = path.join(PROFILES_DIR, profile.name);

    const log = (msg) => {
        const entry = `[${new Date().toISOString()}] [${profile.name}][LOGIN] ${msg}\n`;
        console.log(entry.trim());
        try {
            fs.appendFileSync(path.join(__dirname, 'automation.log'), entry);
        } catch (e) {}
    };

    const browserOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled']
    };
    if (profile.proxy) {
        const proxyConfig = parseProxy(profile.proxy);
        if (proxyConfig) browserOptions.proxy = proxyConfig;
    }

    const browser = await launchBrowser(userDataDir, browserOptions);
    const session = {
        browser,
        stop: false,
        stats: { step: 'initializing', startedAt: Date.now() }
    };
    loggingInProfiles.set(profileId, session);
    db.prepare("UPDATE profiles SET status = ? WHERE id = ?").run('logging_in', profileId);

    log('Login session started');

    try {
        const tiktokPage = await browser.newPage();

        // --- STEP 0: Try cookie-based login first ---
        const hasCookies = profile.cookies && profile.cookies.trim();
        if (hasCookies) {
            try {
                let cookies;
                try {
                    cookies = JSON.parse(profile.cookies);
                } catch (jsonErr) {
                    // Try parsing raw cookie string format (name1=value1; name2=value2)
                    cookies = profile.cookies.split(';').map(part => {
                        const equalIdx = part.indexOf('=');
                        if (equalIdx === -1) return null;
                        const name = part.substring(0, equalIdx).trim();
                        const value = part.substring(equalIdx + 1).trim();
                        if (!name) return null;
                        return {
                            name,
                            value,
                            domain: '.tiktok.com',
                            path: '/'
                        };
                    }).filter(Boolean);
                }

                if (Array.isArray(cookies) && cookies.length > 0) {
                    log(`Injecting ${cookies.length} cookies from stored profile...`);
                    await browser.addCookies(cookies);

                    // Navigate to TikTok to check login state
                    await tiktokPage.goto('https://www.tiktok.com/', {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    });
                    await tiktokPage.waitForTimeout(3000);

                    const currentUrl = tiktokPage.url();
                    log('Checking login state via profile elements...');
                    const isLoggedIn = await tiktokPage.waitForSelector('#header-profile-avatar, [data-e2e="profile-icon"], [data-e2e="avatar-icon"]', { timeout: 6000, state: 'visible' })
                        .then(() => true)
                        .catch(() => false);

                    if (isLoggedIn) {
                        log('Login via cookies successful! Current URL: ' + currentUrl);
                        session.stats.step = 'cookie_login_complete';
                        // Refresh cookies from browser for future use
                        const freshCookies = await browser.cookies();
                        db.prepare('UPDATE profiles SET cookies = ? WHERE id = ?')
                            .run(JSON.stringify(freshCookies), profileId);
                        return;
                    }
                    log('Cookie login failed (profile avatar not found), falling back to email/password...');
                }
            } catch (e) {
                log(`Cookie injection failed: ${e.message}, falling back to email/password...`);
            }
        }

        // --- STEP 1: Navigate to TikTok login ---
        log('Navigating to TikTok login page...');
        await tiktokPage.goto('https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2Ftiktokstudio&enter_method=redirect&enter_from=tiktokstudio', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        await tiktokPage.waitForTimeout(3000);
        session.stats.step = 'tiktok_login_page';

        // --- STEP 2: Detect if already logged in ---
        let currentUrl = tiktokPage.url();
        if (!currentUrl.includes('/login') && !currentUrl.includes('/passport')) {
            log('Already logged in - current URL: ' + currentUrl);
            session.stats.step = 'already_logged_in';
            return;
        }

        // --- STEP 3: Choose email login ---
        await engageDismissPopups(tiktokPage, log);

        const phoneEmailSelectors = [
            'a:has-text("Use phone"), button:has-text("phone"), :text("Use phone / email")',
            ':text-matches("phone.*email", "i")',
            ':text-matches("email.*username", "i")',
        ];
        let phoneEmailBtn = null;
        for (const sel of phoneEmailSelectors) {
            phoneEmailBtn = await tiktokPage.$(sel);
            if (phoneEmailBtn && await phoneEmailBtn.isVisible().catch(() => false)) break;
            phoneEmailBtn = null;
        }
        if (phoneEmailBtn) {
            await phoneEmailBtn.click();
            await tiktokPage.waitForTimeout(2000);
            log('Clicked "Use phone / email / username"');
        }

        const emailLoginSelectors = [
            ':text-matches("Log in with email", "i")',
            'a:has-text("email"), :text-matches("email or username", "i")',
        ];
        let emailLoginLink = null;
        for (const sel of emailLoginSelectors) {
            emailLoginLink = await tiktokPage.$(sel);
            if (emailLoginLink && await emailLoginLink.isVisible().catch(() => false)) break;
            emailLoginLink = null;
        }
        if (emailLoginLink) {
            await emailLoginLink.click();
            await tiktokPage.waitForTimeout(2000);
            log('Clicked "Log in with email"');
        }

        session.stats.step = 'entering_credentials';

        // --- STEP 4: Enter email ---
        const emailSelectors = [
            'input[placeholder*="email" i]',
            'input[placeholder*="username" i]',
            'input[name="email"]',
            'input[name="username"]',
        ];
        let emailInput = null;
        for (const sel of emailSelectors) {
            emailInput = await tiktokPage.waitForSelector(sel, { timeout: 5000, state: 'visible' }).catch(() => null);
            if (emailInput) break;
        }
        if (!emailInput) {
            // Fallback: first visible text input
            const textInputs = await tiktokPage.$$('input[type="text"]:visible, input:not([type="password"]):not([type="hidden"]):visible');
            if (textInputs.length > 0) emailInput = textInputs[0];
        }
        if (!emailInput) throw new Error('Could not find email input on TikTok login page');

        await emailInput.click();
        await emailInput.fill('');
        await emailInput.type(profile.email, { delay: 80 });
        log('Email entered');
        session.stats.step = 'email_entered';

        // --- STEP 5: Enter password ---
        const passwordInput = await tiktokPage.waitForSelector(
            'input[type="password"]',
            { timeout: 5000, state: 'visible' }
        ).catch(() => null);
        if (!passwordInput) throw new Error('Could not find password input');

        await passwordInput.click();
        await passwordInput.fill('');
        await passwordInput.type(profile.pass, { delay: 80 });
        log('Password entered');
        session.stats.step = 'password_entered';

        // --- STEP 6: Click login button ---
        const loginButtonSelectors = [
            'button:has-text("Log in"):not(:has-text("Log in with"))',
            'button[type="submit"]:has-text("Log")',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
        ];
        let loginButton = null;
        for (const sel of loginButtonSelectors) {
            loginButton = await tiktokPage.$(sel);
            if (loginButton && await loginButton.isVisible().catch(() => false)
                && !await loginButton.isDisabled().catch(() => false)) break;
            loginButton = null;
        }
        if (!loginButton) throw new Error('Could not find active login button');

        await loginButton.click();
        log('Login button clicked');
        session.stats.step = 'submitted_credentials';
        await tiktokPage.waitForTimeout(3000);

        // --- STEP 7: Handle captcha & verification code ---
        const captchaMaxWait = 5 * 60 * 1000;
        const captchaStart = Date.now();
        let captchaDetected = false;

        while (Date.now() - captchaStart < captchaMaxWait) {
            if (session.stop) throw new Error('Login stopped by user');

            const currentUrl = tiktokPage.url();
            if (!currentUrl.includes('/login') && !currentUrl.includes('/passport')) {
                log('Redirected away from login page: ' + currentUrl);
                break;
            }

            // Also check if we're on a verification code screen — break immediately
            const pageState = await tiktokPage.evaluate(() => {
                const bodyText = (document.body.innerText || '').toLowerCase();
                const captchaKeywords = ['captcha', 'slide to verify', 'puzzle', 'slider',
                    'security check', 'robot', '验证', 'tsec', 'are you a human',
                    'drag the slider', 'rotate the image'];
                const codeKeywords = ['verification code', 'security code', 'verify your',
                    'confirm your identity', 'enter the code', 'enter code',
                    'mã xác minh', 'nhập mã', '6-digit code', '6 digit code',
                    'authentication code', 'login code', 'sign-in code',
                    'send code', 'sent a code', 'we sent', 'enter confirmation code'];

                const hasCaptcha = captchaKeywords.some(t => bodyText.includes(t));
                const hasCodeScreen = codeKeywords.some(t => bodyText.includes(t));

                // Also check for code input fields
                const codeInputs = document.querySelectorAll(
                    'input[placeholder*="code" i], input[placeholder*="verification" i], ' +
                    'input[placeholder*="6-digit" i], input[name*="code" i], input[name*="verify" i]'
                );

                return {
                    hasCaptcha,
                    hasCodeScreen: hasCodeScreen || codeInputs.length > 0,
                    bodyText: bodyText.substring(0, 500)
                };
            }).catch(() => ({ hasCaptcha: false, hasCodeScreen: false, bodyText: '' }));

            if (pageState.hasCodeScreen) {
                log('Verification code screen detected. Proceeding to retrieve code...');
                session.stats.step = 'code_screen_detected';
                break;
            }

            if (pageState.hasCaptcha && !captchaDetected) {
                captchaDetected = true;
                log('CAPTCHA detected! Waiting for user to solve it manually...');
                session.stats.step = 'waiting_captcha';
            }

            if (captchaDetected && !pageState.hasCaptcha) {
                log('CAPTCHA appears solved. Checking login state...');
                session.stats.step = 'captcha_solved';
                await tiktokPage.waitForTimeout(3000);
                break;
            }

            // Check for errors
            const errorTexts = [
                'incorrect password', 'wrong password', 'too many attempts',
                'does not exist', 'account not found', 'suspended', 'banned'
            ];
            const bodyText = pageState.bodyText;
            for (const errText of errorTexts) {
                if (bodyText.includes(errText)) {
                    throw new Error(`Login rejected: ${errText}`);
                }
            }

            await tiktokPage.waitForTimeout(2000);
        }

        // --- STEP 8: Check login result ---
        currentUrl = tiktokPage.url();
        if (!currentUrl.includes('/login') && !currentUrl.includes('/passport')) {
            log('Login successful! Redirected to: ' + currentUrl);
            session.stats.step = 'complete';
            return;
        }

        // --- STEP 9: Handle verification flow ---
        // STEP 9a: TikTok may show "Verify it's really you" screen — click email option first
        const verifyIdentityIndicators = [
            'verify it\'s really you',
            'verify your identity',
            'choose a verification method',
            'select a verification method',
            'xác minh danh tính',
        ];
        const bodyTextLower = (await tiktokPage.evaluate(() =>
            (document.body.innerText || '').toLowerCase()
        ).catch(() => '')) || '';

        const isVerifyIdentityScreen = verifyIdentityIndicators.some(ind =>
            bodyTextLower.includes(ind)
        );

        if (isVerifyIdentityScreen) {
            log('"Verify identity" screen detected. Clicking email option...');
            const emailOptionSelectors = [
                'div[class*="pc-home-item"]',               // TikTok email option container
                'div[class*="home-item"]',                  // fallback
                ':text("Email")',                           // "Email" text in the option
                ':text-matches("email", "i")',              // case-insensitive email text
                'div[class*="item"]:has-text("Email")',     // item containing Email text
                'div[class*="item"]:has-text("hotmail")',  // item containing hotmail
                'div[class*="item"]:has-text("gmail")',    // item containing gmail
            ];
            for (const sel of emailOptionSelectors) {
                const opt = await tiktokPage.$(sel);
                if (opt && await opt.isVisible().catch(() => false)) {
                    await opt.click();
                    log(`Clicked email option via ${sel}`);
                    await tiktokPage.waitForTimeout(5000);
                    break;
                }
            }
            // After clicking email option, look for "Send code" or similar confirmation button
            // The button may take a moment to become enabled
            await tiktokPage.waitForTimeout(2000);
            const sendBtnSelectors = [
                'button:has-text("Send code"):not([disabled])',
                'button:has-text("Send")',
                'button:has-text("Verify")',
                'button:has-text("Next")',
                'button:has-text("Continue")',
                'button:has-text("Confirm")',
                ':text("Send code")',
                'div[role="button"]:has-text("Send")',
            ];
            for (const sel of sendBtnSelectors) {
                try {
                    const btn = await tiktokPage.waitForSelector(sel, { timeout: 5000, state: 'visible' });
                    if (btn) {
                        const disabled = await btn.isDisabled().catch(() => false);
                        if (!disabled) {
                            await btn.click({ force: true });
                            log(`Clicked "${(await btn.innerText().catch(() => sel))}" via ${sel}`);
                            session.stats.step = 'code_sent';
                            await tiktokPage.waitForTimeout(45000);
                            break;
                        }
                    }
                } catch (e) { /* selector not found or not enabled, try next */ }
            }
        }

        // STEP 9b: Look for and click any button that triggers sending the verification code
        const sendCodeSelectors = [
            'button:has-text("Send code")',
            'button:has-text("send code")',
            ':text("Send code")',
            'button:has-text("Verify")',
            'button:has-text("Send")',
            'button:has-text("Next")',
            'button:has-text("Continue")',
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            ':text-matches("send.*code", "i")',
            ':text-matches("gửi.*mã", "i")',
            ':text-matches("use.*email", "i")',
            ':text-matches("confirm.*email", "i")',
            ':text-matches("select.*email", "i")',
            'div[role="button"]:has-text("Send")',
            'div[role="button"]:has-text("Continue")',
        ];

        let sendBtnClicked = false;
        for (const sel of sendCodeSelectors) {
            const sendBtn = await tiktokPage.$(sel);
            if (sendBtn && await sendBtn.isVisible().catch(() => false)
                && !await sendBtn.isDisabled().catch(() => true)) {
                await sendBtn.click();
                log(`Clicked "Send code" button via ${sel}`);
                session.stats.step = 'code_sent';
                sendBtnClicked = true;
                // Wait for TikTok to send the email — new email needs time to arrive in inbox
                await tiktokPage.waitForTimeout(45000);
                break;
            }
        }

        if (!sendBtnClicked) {
            // Debug: log visible buttons on page
            const btns = await tiktokPage.evaluate(() => {
                const buttons = document.querySelectorAll('button, div[role="button"], a[role="button"], span[role="button"]');
                const info = [];
                for (const b of buttons) {
                    if (b.offsetParent !== null) {
                        info.push((b.innerText || b.textContent || '').substring(0, 60).trim());
                    }
                }
                return info.filter(t => t.length > 0);
            }).catch(() => []);
            log(`Debug: visible buttons on page: ${JSON.stringify(btns)}`);
        }

        // Now look for the code input field
        const codeInputSelectors = [
            'input[placeholder*="code" i]',
            'input[placeholder*="verification" i]',
            'input[placeholder*="6-digit" i]',
            'input[placeholder*="6 digit" i]',
            'input[name*="code" i]',
            'input[name*="verify" i]',
            'input[aria-label*="code" i]',
            'input[aria-label*="verification" i]',
            'input[type="text"]:not([placeholder*="email" i]):not([placeholder*="phone" i]):not([placeholder*="password" i])',
            'input:not([type="hidden"]):not([type="password"]):not([type="email"]):not([type="submit"])',
        ];

        let codeInput = null;
        for (const sel of codeInputSelectors) {
            codeInput = await tiktokPage.$(sel);
            if (codeInput && await codeInput.isVisible().catch(() => false)) break;
            codeInput = null;
        }

        // Also check for verification text on page
        const hasVerificationText = await tiktokPage.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();
            return text.includes('verification code') || text.includes('security code')
                || text.includes('confirm your identity') || text.includes('enter the code')
                || text.includes('mã xác minh') || text.includes('nhập mã');
        }).catch(() => false);

        if (hasVerificationText || codeInput) {
            log('Verification code required. Opening Hotmail to retrieve code...');
            session.stats.step = 'retrieving_code';

            const triedCodes = new Set();
            let verified = false;

            for (let retry = 0; retry < 3 && !verified; retry++) {
                if (session.stop) break;
                if (retry > 0) log(`Retry attempt ${retry + 1}/3 for verification code...`);

                let code = null;
                try {
                    code = await retrieveVerificationCode(browser, profile, log, triedCodes);
                } catch (err) {
                    log(`Error retrieving verification code: ${err.message}`);
                    if (retry < 2) {
                        log('Will retry...');
                        continue;
                    }
                    break;
                }

                if (!code) {
                    log('Could not retrieve verification code from email');
                    break;
                }

                log(`Retrieved verification code (${code}). Hotmail tab closed. Waiting 2s before entering code...`);
                await tiktokPage.waitForTimeout(2000);

                // Always re-find code input — page may have changed during Hotmail retrieval
                codeInput = null;
                for (const sel of codeInputSelectors) {
                    codeInput = await tiktokPage.$(sel);
                    if (codeInput && await codeInput.isVisible().catch(() => false)) break;
                    codeInput = null;
                }
                if (!codeInput) {
                    log('Could not find code input field after retrieving code');
                    break;
                }

                // Focus and type code character by character, plus set native value as fallback
                try {
                    await codeInput.focus().catch(() => {});
                    await codeInput.click().catch(() => {});
                    await tiktokPage.keyboard.press('Control+A').catch(() => {});
                    await tiktokPage.keyboard.press('Backspace').catch(() => {});
                    await codeInput.type(code, { delay: 100 }).catch(() => {});
                } catch (e) {}

                await codeInput.evaluate((el, val) => {
                    if (el.value !== val) {
                        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        nativeInputValueSetter.call(el, val);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, code);

                log(`Verification code ${code} entered.`);
                await tiktokPage.waitForTimeout(1000);

                // Press Enter & Click submit button
                await tiktokPage.keyboard.press('Enter').catch(() => {});
                const verifyBtn = await tiktokPage.$('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm"), button:has-text("Next"), button[type="submit"]');
                if (verifyBtn && await verifyBtn.isVisible().catch(() => false)) {
                    await verifyBtn.click({ force: true }).catch(() => {});
                    log('Clicked verify/submit button');
                }

                // Poll for login success or explicit error for up to 15 seconds
                log('Waiting for TikTok login verification response...');
                let isSuccess = false;
                let hasExplicitError = false;

                for (let poll = 0; poll < 15; poll++) {
                    await tiktokPage.waitForTimeout(1000);
                    const currentUrl = tiktokPage.url();

                    // Check URL redirection
                    if (!currentUrl.includes('/login') && !currentUrl.includes('/passport')) {
                        isSuccess = true;
                        break;
                    }

                    // Check session cookies
                    try {
                        const cookies = await browser.cookies();
                        const hasSessionCookie = cookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt');
                        if (hasSessionCookie) {
                            isSuccess = true;
                            break;
                        }
                    } catch (e) {}

                    // Check avatar / logged in elements
                    const avatarFound = await tiktokPage.$('[data-e2e="user-avatar"], [data-e2e="profile-icon"], header img, a[href*="/@"]').catch(() => null);
                    if (avatarFound && await avatarFound.isVisible().catch(() => false)) {
                        isSuccess = true;
                        break;
                    }

                    // Check for explicit error message on page
                    const pageText = await tiktokPage.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
                    if (pageText.includes('incorrect code') || pageText.includes('invalid code') || pageText.includes('mã không đúng') || pageText.includes('expired') || pageText.includes('too many attempts')) {
                        hasExplicitError = true;
                        log('TikTok reported incorrect/invalid verification code.');
                        break;
                    }
                }

                if (isSuccess) {
                    log('Login successful after verification!');
                    verified = true;
                    session.stats.step = 'complete';
                    return;
                }

                if (!hasExplicitError) {
                    log('Verification submitted. Waiting additional 10s for page transition...');
                    await tiktokPage.waitForTimeout(10000);
                    const checkUrl = tiktokPage.url();
                    if (!checkUrl.includes('/login') && !checkUrl.includes('/passport')) {
                        log('Login successful after verification!');
                        verified = true;
                        session.stats.step = 'complete';
                        return;
                    }
                }

                log(`Verification code ${code} rejected or expired. Will retry...`);
                session.stats.step = 'verification_retrying';
            }

            if (!verified) {
                log('Verification code attempts exhausted or failed. Waiting for manual verification...');
                session.stats.step = 'awaiting_manual_verification';
                // Wait for user to handle manually
                for (let i = 0; i < 60; i++) {
                    if (session.stop) break;
                    await tiktokPage.waitForTimeout(5000);
                    const url = tiktokPage.url();
                    if (!url.includes('/login') && !url.includes('/passport')) {
                        log('Login completed (manually)!');
                        session.stats.step = 'complete';
                        return;
                    }
                }
            }
        } else {
            log('After login: on page but no clear success/error. URL: ' + currentUrl);
            session.stats.step = 'unclear_state';
        }

    } catch (err) {
        log(`Login error: ${err.message}`);
        session.stats.step = 'error';
        session.stats.error = err.message;
    } finally {
        // Save cookies for future logins if login was successful
        const successSteps = ['complete', 'already_logged_in'];
        if (successSteps.includes(session.stats.step)) {
            try {
                const cookies = await browser.cookies();
                if (cookies && cookies.length > 0) {
                    db.prepare('UPDATE profiles SET cookies = ? WHERE id = ?')
                        .run(JSON.stringify(cookies), profileId);
                    log(`Saved ${cookies.length} cookies to profile`);
                }
            } catch (e) {
                log(`Failed to save cookies: ${e.message}`);
            }
            log('Login successful! Keeping browser open for 10 seconds before closing...');
            await tiktokPage.waitForTimeout(10000).catch(() => new Promise(r => setTimeout(r, 10000)));
        }
        loggingInProfiles.delete(profileId);
        await browser.close().catch(() => null);
        db.prepare("UPDATE profiles SET status = 'idle' WHERE id = ?").run(profileId);
        log('Login session ended, browser closed.');
    }
}

// =============================================
// END LOGIN TIKTOK SESSION
// =============================================

const dismissPopups = async (page) => {
    if (!page) return false;

    // --- Xử lý banner "A video you were editing wasn't saved" (không phải modal) ---
    // Banner này xuất hiện ở TOP trang, không phải role="dialog"
    try {
        const draftBanner = await page.$('div:has-text("wasn\'t saved"):has(button:has-text("Discard")), div:has-text("Continue editing?"):has(button:has-text("Discard"))');
        if (draftBanner && await draftBanner.isVisible()) {
            const discardBtn = await page.$('button:has-text("Discard")');
            if (discardBtn && await discardBtn.isVisible()) {
                await discardBtn.click();
                console.log('[dismissPopups] Dismissed draft banner "wasn\'t saved" → Discard');
                await page.waitForTimeout(500);
                return true;
            }
        }
    } catch (e) { /* ignore */ }

    // Các selector để tìm modal/popup - theo thứ tự ưu tiên (cụ thể nhất trước)
    const modalSelectors = [
        'div[role="dialog"]',
        'div.TUXModal:not(.TUXModal-overlay)',   // TikTok modal chính (không phải overlay)
        'div[class*="common-modal"]:not([class*="overlay"])',
        'div[class*="modal"]:not([class*="overlay"])',
        'div[class*="Modal"]:not([class*="overlay"])',
        'div[class*="portal"]',
        'div[class*="dialog"]',
    ];

    for (const modalSel of modalSelectors) {
        try {
            // Dùng $$ để lấy TẤT CẢ elements match, không chỉ phần tử đầu tiên
            const modals = await page.$$(modalSel);
            for (const modal of modals) {
                try {
                    if (!await modal.isVisible()) continue;

                    const text = await modal.innerText().catch(() => '');
                    if (!text.trim()) continue;

                    // --- Popup "Turn on automatic content checks?" ---
                    // → Click Cancel để từ chối (không muốn bật)
                    if (text.includes("automatic content checks") || text.includes("content checks") || text.includes("Turn on automatic")) {
                        const cancelBtn = await modal.$('button:has-text("Cancel")');
                        if (cancelBtn && await cancelBtn.isVisible()) {
                            await cancelBtn.click();
                            console.log('[dismissPopups] Dismissed "Turn on automatic content checks" popup → Cancel');
                            return true;
                        }
                    }

                    // --- Popup "Are you sure you want to exit?" ---
                    // → Click Cancel để ở lại trang upload
                    if (text.includes("Are you sure you want to exit") || text.includes("want to leave") || text.includes("Leave page")) {
                        const cancelBtn = await modal.$('button:has-text("Cancel"), button:has-text("Stay"), button:has-text("No")');
                        if (cancelBtn && await cancelBtn.isVisible()) {
                            await cancelBtn.click();
                            console.log('[dismissPopups] Dismissed "exit/leave" confirmation popup → Cancel/Stay');
                            return true;
                        }
                    }

                    // --- Popup "Discard this post?" ---
                    if (text.includes("Discard this post") || text.includes("discarded permanently")) {
                        const notNowBtn = await modal.$('button:has-text("Not now")');
                        if (notNowBtn && await notNowBtn.isVisible()) {
                            await notNowBtn.click();
                            console.log('[dismissPopups] Dismissed "Discard this post?" popup → Not now');
                            return true;
                        }
                        const discardBtn = await modal.$('button:has-text("Discard")');
                        if (discardBtn && await discardBtn.isVisible()) {
                            await discardBtn.click();
                            console.log('[dismissPopups] Dismissed "Discard this post?" popup → Discard');
                            return true;
                        }
                    }

                    // --- Các popup chung: Got it, Allow, Skip, OK ---
                    const genericBtnSelectors = [
                        'button:has-text("Got it")',
                        'button:has-text("Allow")',
                        'button:has-text("Not now")',
                        'button:has-text("Skip")',
                        'button:has-text("OK")',
                        'button:has-text("Okay")',
                        'button:has-text("Close")',
                    ];
                    for (const btnSel of genericBtnSelectors) {
                        const btn = await modal.$(btnSel);
                        if (btn && await btn.isVisible()) {
                            await btn.click();
                            console.log(`[dismissPopups] Dismissed generic popup → ${btnSel}`);
                            return true;
                        }
                    }
                } catch (innerE) { /* ignore per-modal errors */ }
            }
        } catch (e) { /* ignore selector errors */ }
    }
    return false;
};



// Background Scheduler
function checkAndRunSchedules() {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    try {
        // Find all profiles that have a schedule matching the current time
        const scheduledProfiles = db.prepare(`
            SELECT DISTINCT p.* 
            FROM profiles p
            JOIN profile_schedules ps ON p.id = ps.profile_id
            WHERE ps.time = ?
        `).all(currentTime);

        if (scheduledProfiles.length > 0) {
            console.log(`[Scheduler] Found ${scheduledProfiles.length} profiles to run at ${currentTime}`);
            const ready = scheduledProfiles.filter((profile) => {
                if (runningProfiles.has(profile.id) || processingProfiles.has(profile.id) || queuedProfileIds.has(profile.id)) {
                    console.log(`[Scheduler] Profile ${profile.name} is already running, queued or processing a video, skipping scheduled trigger.`);
                    return false;
                }
                return true;
            });
            // Đi qua hàng đợi chung. Trước đây lịch bắn thẳng runSingleProfile,
            // nên một mốc giờ trùng nhiều kênh là mở bằng đó trình duyệt cùng lúc.
            for (const profile of enqueueUploads(ready)) {
                console.log(`[Scheduler] Triggering automation for: ${profile.name}`);
            }
        }
    } catch (err) {
        console.error('[Scheduler] Database error:', err);
    }
}

// Run every minute (offset by a few seconds to avoid missing the boundary if execution is slow)
setInterval(checkAndRunSchedules, 60000);

// ─── STATS FEATURE ───────────────────────────────────────────────────────────

// Trần kích thước một file avatar. TikTok trả ảnh vuông cỡ 1080, nặng nhất vài
// trăm KB; thứ gì lớn hơn nhiều lần thế là dấu hiệu tải nhầm (trang lỗi, URL
// trỏ chỗ khác), không đáng ghi xuống đĩa.
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_FETCH_TIMEOUT_MS = 15000;
const AVATAR_EXT_BY_TYPE = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/**
 * Tải avatar kênh về data/avatars rồi ghi đường dẫn vào profile.
 *
 * Lưu file thay vì lưu URL: link CDN của TikTok có chữ ký hết hạn, để nguyên
 * thì vài ngày sau toàn bộ card trắng ảnh cùng lúc.
 *
 * Không bao giờ ném lỗi ra ngoài — hỏng ở đây chỉ là thiếu một cái ảnh, không
 * được phép làm gãy lượt quét thống kê đang chạy cùng.
 */
async function saveChannelAvatar(profile, url) {
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!contentType.startsWith('image/')) throw new Error(`không phải ảnh (content-type: ${contentType || 'trống'})`);

        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) throw new Error('body rỗng');
        if (buffer.length > AVATAR_MAX_BYTES) throw new Error(`file quá lớn (${buffer.length} bytes)`);

        const fileName = `${profile.id}.${AVATAR_EXT_BY_TYPE[contentType] || 'jpg'}`;
        fs.writeFileSync(path.join(AVATARS_DIR, fileName), buffer);

        // Đuôi file đổi (jpg -> webp) thì file cũ thành rác không ai dọn.
        const previous = db.prepare('SELECT channel_avatar FROM profiles WHERE id = ?').get(profile.id)?.channel_avatar;
        if (previous && previous !== fileName) {
            const stale = path.join(AVATARS_DIR, path.basename(previous));
            if (fs.existsSync(stale)) fs.unlinkSync(stale);
        }

        db.prepare('UPDATE profiles SET channel_avatar = ?, channel_avatar_at = ? WHERE id = ?')
            .run(fileName, new Date().toISOString(), profile.id);
        console.log(`[${profile.name}] Saved channel avatar (${buffer.length} bytes)`);
        return true;
    } catch (err) {
        console.error(`[${profile.name}] Failed to save channel avatar: ${err.message}`);
        return false;
    }
}

// POST /api/stats/start
app.post('/api/stats/start', async (req, res) => {
  const { profileIds } = req.body;
  if (!Array.isArray(profileIds) || profileIds.length === 0) {
    return res.status(400).json({ error: 'profileIds required' });
  }

  // Thiếu cờ nghĩa là quét đầy đủ, để chỗ gọi cũ không đổi hành vi. Riêng
  // scanDayCount là việc mới nên mặc định tắt khi không được gửi lên.
  const scanStats = req.body.scanStats !== false;
  const scanAvatar = req.body.scanAvatar !== false;
  const scanDayCount = req.body.scanDayCount === true;
  const countDate = typeof req.body.countDate === 'string' ? req.body.countDate : null;
  if (!scanStats && !scanAvatar && !scanDayCount) {
    return res.status(400).json({ error: 'Chọn ít nhất một loại quét' });
  }

  const profiles = profileIds
    .map(id => db.prepare('SELECT * FROM profiles WHERE id = ?').get(id))
    .filter(Boolean);

  if (profiles.length === 0) {
    return res.status(400).json({ error: 'No valid profiles found' });
  }

  const jobId = createJob(profileIds);
  res.json({ jobId });

  // Run in background — 2 profiles at a time
  (async () => {
    const BATCH = 2;
    const ctx = {
      PROFILES_DIR,
      pushEvent,
      appendResult,
      setProfileMeta,
      markProfileDone,
      markError,
      isAborted,
      applyProfileFingerprint: null, // not available in this branch; stats-automation guards typeof === 'function'
      injectProfileCookies,
      parseProxy,
      statsLimitDate: getConfig('statsLimitDate', null) || null,
      scanStats,
      scanAvatar,
      scanDayCount,
      countDate,
      saveChannelAvatar,
    };
    for (let i = 0; i < profiles.length; i += BATCH) {
      if (isAborted(jobId)) break;
      const batch = profiles.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(profile => runStatsForProfile(profile, jobId, ctx))
      );
    }
    markAllDone(jobId);
  })().catch(err => console.error('[Stats] runAll error:', err));
});

// GET /api/stats/stream/:jobId — SSE
app.get('/api/stats/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (job.status === 'done' || job.status === 'cancelled') {
    res.write(`data: ${JSON.stringify({ type: 'all_done' })}\n\n`);
    res.end();
    return;
  }

  addClient(jobId, res);

  // Heartbeat every 20s to keep SSE connection alive through proxies/timeouts
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(jobId, res);
  });
});

// GET /api/stats/status/:jobId — simple status check for polling fallback
app.get('/api/stats/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, resultCount: [...job.results.values()].reduce((s, v) => s + v.length, 0) });
});

// GET /api/stats/download/:jobId
app.get('/api/stats/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const profileNames = new Map();
    for (const pid of job.profileIds) {
      const p = db.prepare('SELECT name FROM profiles WHERE id = ?').get(pid);
      if (p) profileNames.set(pid, p.name);
    }
    const buffer = await getExcelBuffer(jobId, profileNames);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tiktok_stats_${date}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stats/cancel/:jobId
app.delete('/api/stats/cancel/:jobId', (req, res) => {
  cancelJob(req.params.jobId);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
