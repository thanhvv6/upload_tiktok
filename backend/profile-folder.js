/**
 * Where a profile's videos live on disk, and how that folder follows the
 * profile when its group changes.
 *
 * Layout: uploads/<group>/<profile>, or uploads/<profile> with no group.
 */

import fs from 'fs';
import path from 'path';
import { assertGroupExists, getGroupById } from './group-store.js';

const createFolderError = (message, status) => {
    const error = new Error(message);
    error.status = status;
    return error;
};

export function resolveProfileFolder(uploadsDir, groupName, profileName) {
    return groupName
        ? path.join(uploadsDir, groupName, profileName)
        : path.join(uploadsDir, profileName);
}

function moveEntry(from, to, renameSync) {
    try {
        renameSync(from, to);
    } catch (err) {
        // A profile folder picked by hand can sit on another volume, where
        // rename(2) fails outright -- copy then delete is the only way across.
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
    }
}

function mergeInto(src, dest, renameSync) {
    let overwritten = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            overwritten += mergeInto(from, to, renameSync);
        } else {
            if (fs.existsSync(to)) {
                fs.rmSync(to, { force: true });
                overwritten++;
            }
            moveEntry(from, to, renameSync);
        }
    }
    return overwritten;
}

/**
 * Move `src` onto `dest`, merging rather than replacing: same-named files are
 * overwritten by the incoming ones, same-named folders are merged recursively,
 * and anything only present in `dest` survives.
 *
 * @returns {{moved: boolean, overwritten: number}}
 */
export function mergeMoveFolder(src, dest, { renameSync = fs.renameSync } = {}) {
    if (src === dest) {
        return { moved: false, overwritten: 0 };
    }
    if (!fs.existsSync(src)) {
        fs.mkdirSync(dest, { recursive: true });
        return { moved: false, overwritten: 0 };
    }

    if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
            renameSync(src, dest);
            return { moved: true, overwritten: 0 };
        } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            // Fall through to the entry-by-entry path, which copies instead.
        }
    }

    const overwritten = mergeInto(src, dest, renameSync);
    fs.rmSync(src, { recursive: true, force: true });
    return { moved: true, overwritten };
}

/**
 * The video folders it is safe to delete along with a profile.
 *
 * Deleting a profile used to remove uploads/<profile name> on a bare name match,
 * which wipes the group folder whenever a group and a profile share a name --
 * taking every sibling profile's videos with it. A candidate is only returned
 * once nothing else is known to depend on it.
 *
 * @returns {string[]}
 */
export function resolveDeletableVideoFolders(db, { profile, uploadsDir }) {
    const name = typeof profile.name === 'string' ? profile.name : '';
    const legacyName = name.toLowerCase().replace(/\s+/g, '');

    const candidates = [
        profile.video_folder,
        name ? path.join(uploadsDir, name) : null,
        legacyName ? path.join(uploadsDir, legacyName) : null
    ];

    const groupFolders = new Set(
        db
            .prepare('SELECT name FROM groups')
            .all()
            .map((row) => path.join(uploadsDir, row.name))
    );
    const otherProfileFolders = db
        .prepare(
            'SELECT video_folder FROM profiles WHERE id != ? AND video_folder IS NOT NULL'
        )
        .all(profile.id)
        .map((row) => row.video_folder);

    const seen = new Set();
    const deletable = [];
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);

        if (candidate === uploadsDir) continue;
        if (!fs.existsSync(candidate)) continue;
        if (groupFolders.has(candidate)) continue;

        const holdsAnotherProfile = otherProfileFolders.some(
            (folder) =>
                folder === candidate || folder.startsWith(candidate + path.sep)
        );
        if (holdsAnotherProfile) continue;

        deletable.push(candidate);
    }
    return deletable;
}

/**
 * Point a profile at a new group and bring its video folder along.
 *
 * @returns {{moved: boolean, overwritten: number, videoFolder: string, groupId: string|null}}
 */
export function syncProfileFolderOnGroupChange(
    db,
    { profileId, groupId, uploadsDir }
) {
    const profile = db
        .prepare('SELECT id, name, group_id, video_folder FROM profiles WHERE id = ?')
        .get(profileId);
    if (!profile) {
        throw createFolderError('Profile not found', 404);
    }

    const normalizedGroupId = groupId ?? null;

    // The group is not actually changing, so there is nothing to follow. Bail
    // out before resolving a canonical path -- otherwise a folder the user
    // picked by hand would be dragged under uploads/ by an unrelated PATCH.
    if (profile.group_id === normalizedGroupId && profile.video_folder) {
        return {
            moved: false,
            overwritten: 0,
            videoFolder: profile.video_folder,
            groupId: normalizedGroupId
        };
    }
    let groupName = null;
    if (normalizedGroupId !== null) {
        assertGroupExists(db, normalizedGroupId);
        groupName = getGroupById(db, normalizedGroupId).name;
    }

    const dest = resolveProfileFolder(uploadsDir, groupName, profile.name);
    const src = profile.video_folder;

    let moved = false;
    let overwritten = 0;
    if (src && src !== dest) {
        // No reverse move if the UPDATE below fails: the merge has already
        // overwritten same-named files, so moving back would drag the
        // destination's own files out with it and make things worse. The DB is
        // left untouched instead, which keeps the profile pointing at a folder
        // that still exists.
        ({ moved, overwritten } = mergeMoveFolder(src, dest));
    } else {
        fs.mkdirSync(dest, { recursive: true });
    }

    db.transaction(() => {
        db.prepare(
            'UPDATE profiles SET group_id = ?, video_folder = ? WHERE id = ?'
        ).run(normalizedGroupId, dest, profileId);
    })();

    return { moved, overwritten, videoFolder: dest, groupId: normalizedGroupId };
}
