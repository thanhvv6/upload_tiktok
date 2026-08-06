import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeNextScheduledTime,
    inferScheduleFieldKind,
    formatScheduleValue,
    sortScheduleInputs
} from '../schedule-utils.js';

test('computeNextScheduledTime starts at +20 minutes and rounds up to 5-minute mark', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    const scheduled = computeNextScheduledTime({
        index: 3,
        lastScheduledTime: null,
        now
    });

    assert.equal(scheduled.toISOString(), '2026-04-12T09:40:00.000Z');
});

test('computeNextScheduledTime increments from previous scheduled slot by 5 minutes', () => {
    const previous = new Date('2026-04-12T09:40:00.000Z');

    const scheduled = computeNextScheduledTime({
        index: 4,
        lastScheduledTime: previous,
        intervalMinutes: 5,
        now: new Date('2026-04-12T09:18:25.755Z')
    });

    assert.equal(scheduled.toISOString(), '2026-04-12T09:45:00.000Z');
});

test('inferScheduleFieldKind detects date and time from input hints', () => {
    assert.equal(inferScheduleFieldKind({ placeholder: 'Select date' }), 'date');
    assert.equal(inferScheduleFieldKind({ ariaLabel: 'Time' }), 'time');
    assert.equal(inferScheduleFieldKind({ value: '04/12/2026' }), 'date');
    assert.equal(inferScheduleFieldKind({ value: '4:45 PM' }), 'time');
});

test('formatScheduleValue adapts to date and time field hints', () => {
    const date = new Date('2026-04-12T16:45:00');

    assert.equal(formatScheduleValue(date, 'date', { placeholder: 'YYYY-MM-DD' }), '2026-04-12');
    assert.equal(formatScheduleValue(date, 'date', { placeholder: 'MM/DD/YYYY' }), '04/12/2026');
    assert.equal(formatScheduleValue(date, 'time', { placeholder: 'HH:mm' }), '16:45');
    assert.equal(formatScheduleValue(date, 'time', { placeholder: 'hh:mm AM/PM' }), '4:45 PM');
});

test('sortScheduleInputs keeps fields ordered top-to-bottom then left-to-right', () => {
    const inputs = [
        { index: 2, top: 100, left: 300 },
        { index: 1, top: 80, left: 500 },
        { index: 0, top: 80, left: 200 }
    ];

    assert.deepEqual(
        sortScheduleInputs(inputs).map((input) => input.index),
        [0, 1, 2]
    );
});
