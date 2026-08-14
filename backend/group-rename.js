/**
 * Renaming a group touches two places that can disagree: the `groups` row plus
 * every profile's `video_folder`, and the group's folder under uploads/.
 * This module keeps them in step -- the DB half runs in one transaction, and
 * the folder rename is undone by hand if that transaction fails.
 */

import fs from 'fs';
import path from 'path';
import {
    getGroupById,
    renameGroup,
    normalizeGroupName,
    assertGroupNameAvailable
} from './group-store.js';

const createRenameError = (message, status) => {
    const error = new Error(message);
    error.status = status;
    return error;
};

/**
 * @returns {{unchanged: boolean, name: string, folderRenamed: boolean, updatedProfiles: number}}
 */
export function renameGroupWithFolder(db, { id, name, uploadsDir }) {
    const current = getGroupById(db, id);
    if (!current) {
        throw createRenameError('Group not found', 404);
    }

    const newName = normalizeGroupName(name);
    if (newName === current.name) {
        return {
            unchanged: true,
            name: newName,
            folderRenamed: false,
            updatedProfiles: 0
        };
    }
    assertGroupNameAvailable(db, newName, id);

    const oldFolder = path.join(uploadsDir, current.name);
    const newFolder = path.join(uploadsDir, newName);
    if (fs.existsSync(newFolder)) {
        throw createRenameError('Target folder already exists', 400);
    }

    // A group with no imported profiles has no folder yet -- renaming it is a
    // DB-only operation, not an error.
    let folderRenamed = false;
    if (fs.existsSync(oldFolder)) {
        try {
            fs.renameSync(oldFolder, newFolder);
            folderRenamed = true;
            console.log(
                `Renamed group folder from ${current.name} to ${newName}`
            );
        } catch (err) {
            console.error('Rename group folder error:', err);
            throw createRenameError('Failed to rename group folder', 500);
        }
    }

    const oldPrefix = oldFolder + path.sep;
    const newPrefix = newFolder + path.sep;

    // One transaction: without it, a failure partway through the profile loop
    // would leave the group renamed and some profiles pointing at a folder the
    // rollback below has just moved back to its old name.
    const applyDbRename = db.transaction(() => {
        renameGroup(db, { id, name: newName });

        const profiles = db
            .prepare('SELECT id, video_folder FROM profiles WHERE group_id = ?')
            .all(id);
        const updateFolder = db.prepare(
            'UPDATE profiles SET video_folder = ? WHERE id = ?'
        );
        let updatedCount = 0;
        for (const row of profiles) {
            if (row.video_folder && row.video_folder.startsWith(oldPrefix)) {
                updateFolder.run(
                    newPrefix + row.video_folder.slice(oldPrefix.length),
                    row.id
                );
                updatedCount++;
            }
        }
        return updatedCount;
    });

    let updatedProfiles = 0;
    try {
        updatedProfiles = applyDbRename();
    } catch (err) {
        if (folderRenamed) {
            try {
                fs.renameSync(newFolder, oldFolder);
            } catch (rollbackErr) {
                console.error(
                    'Rollback group folder rename failed:',
                    rollbackErr
                );
            }
        }
        console.error('Rename group DB error:', err);
        if (!err.status) err.status = 500;
        throw err;
    }

    console.log(
        `Updated video_folder for ${updatedProfiles} profiles of group ${newName}`
    );

    return {
        unchanged: false,
        name: newName,
        folderRenamed,
        updatedProfiles
    };
}
