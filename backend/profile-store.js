import { assertGroupExists } from './group-store.js';

const normalizeGroupId = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
};

const normalizeOptionalText = (value) => {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
};

const createStoreError = (message, status) => {
    const error = new Error(message);
    error.status = status;
    return error;
};

export function createProfileRecord(db, { id, name, group_id, video_folder, channel_ids, needs_render, remove_title, need_content_check, render_video_long, set_music, render_concat_video }) {
    if (name === undefined || name === null) {
        throw createStoreError('Name is required', 400);
    }
    if (typeof name !== 'string') {
        throw createStoreError('Name must be a string', 400);
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
        throw createStoreError('Name is required', 400);
    }

    const normalizedGroupId = normalizeGroupId(group_id);
    if (normalizedGroupId) {
        assertGroupExists(db, normalizedGroupId);
    }

    const normalizedVideoFolder = normalizeOptionalText(video_folder);
    const normalizedChannelIds = normalizeOptionalText(channel_ids);
    const normalizedNeedsRender = needs_render !== undefined ? (needs_render ? 1 : 0) : 1;
    const normalizedRemoveTitle = remove_title !== undefined ? (remove_title ? 1 : 0) : 1;
    const normalizedNeedContentCheck = need_content_check !== undefined ? (need_content_check ? 1 : 0) : 1;
    const normalizedRenderVideoLong = render_video_long !== undefined ? (render_video_long ? 1 : 0) : 0;
    const normalizedSetMusic = set_music !== undefined ? (set_music ? 1 : 0) : 1;
    const normalizedRenderConcatVideo = render_concat_video !== undefined ? (render_concat_video ? 1 : 0) : 0;

    try {
        db.prepare(
            `
            INSERT INTO profiles (id, name, status, is_scheduled, auto_increment_schedule, group_id, video_folder, set_music, upload_count, channel_ids, needs_render, remove_title, need_content_check, render_video_long, render_concat_video)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            id,
            trimmedName,
            'idle',
            0,
            0,
            normalizedGroupId ?? null,
            normalizedVideoFolder,
            normalizedSetMusic,
            1,
            normalizedChannelIds,
            normalizedNeedsRender,
            normalizedRemoveTitle,
            normalizedNeedContentCheck,
            normalizedRenderVideoLong,
            normalizedRenderConcatVideo
        );
    } catch (e) {
        if (e && e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            throw createStoreError(
                'A profile with this id already exists',
                400
            );
        }
        if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            const msg = String(e.message ?? '');
            if (msg.includes('profiles.name')) {
                throw createStoreError(
                    'A profile with this name already exists',
                    400
                );
            }
            if (msg.includes('profiles.id')) {
                throw createStoreError(
                    'A profile with this id already exists',
                    400
                );
            }
            throw createStoreError(
                'Profile violates a unique constraint',
                409
            );
        }
        throw createStoreError('Could not create profile', 500);
    }

    return db
        .prepare(
            `
            SELECT
                p.*,
                g.name AS group_name
            FROM profiles p
            LEFT JOIN groups g ON g.id = p.group_id
            WHERE p.id = ?
        `
        )
        .get(id);
}
