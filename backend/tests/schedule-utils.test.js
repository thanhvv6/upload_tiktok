import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeNextScheduledTime,
    computeAutoIncrementTime,
    computeDelayedFirstTime,
    inferScheduleFieldKind,
    formatScheduleValue,
    sortScheduleInputs,
    parseScheduleValue,
    parseStudioScheduleLabel
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

test('computeNextScheduledTime steps by whatever interval it is given', () => {
    // Locks the plumbing: the scheduled-upload path used to call this without
    // intervalMinutes, so a profile set to 5 or 15 silently stepped by 10.
    const previous = new Date('2026-04-12T09:00:00.000Z');
    const step = (intervalMinutes) =>
        computeNextScheduledTime({
            index: 4,
            lastScheduledTime: previous,
            intervalMinutes,
            now: new Date('2026-04-12T08:30:00.000Z')
        }).toISOString();

    assert.equal(step(5), '2026-04-12T09:05:00.000Z');
    assert.equal(step(10), '2026-04-12T09:10:00.000Z');
    assert.equal(step(15), '2026-04-12T09:15:00.000Z');
});

test('computeNextScheduledTime falls back to 10 minutes when no interval is given', () => {
    const previous = new Date('2026-04-12T09:00:00.000Z');

    const scheduled = computeNextScheduledTime({
        index: 4,
        lastScheduledTime: previous,
        now: new Date('2026-04-12T08:30:00.000Z')
    });

    assert.equal(scheduled.toISOString(), '2026-04-12T09:10:00.000Z');
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

// --- parseScheduleValue -----------------------------------------------------

const localIso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('parseScheduleValue keeps the month when today is a day that month lacks', () => {
    // Running just before midnight on the 31st: TikTok proposes the 1st of the
    // next month. Building the date by mutating today overflowed -- Aug 31 with
    // the month set to September is Oct 1 -- pushing every schedule a month out.
    const endOfAugust = new Date(2026, 7, 31, 23, 50, 0, 0);

    assert.equal(
        localIso(parseScheduleValue('2026-09-01', '00:10', endOfAugust)),
        '2026-09-01 00:10'
    );
    assert.equal(
        localIso(parseScheduleValue('2026-02-01', '00:10', new Date(2026, 0, 31, 23, 50))),
        '2026-02-01 00:10'
    );
    assert.equal(
        localIso(parseScheduleValue('2026-04-01', '00:05', new Date(2026, 2, 31, 23, 45))),
        '2026-04-01 00:05'
    );
});

test('parseScheduleValue reads the usual formats', () => {
    const now = new Date(2026, 7, 18, 12, 0, 0, 0);

    assert.equal(localIso(parseScheduleValue('2026-08-19', '00:10', now)), '2026-08-19 00:10');
    assert.equal(localIso(parseScheduleValue('2026.08.19', '23:05', now)), '2026-08-19 23:05');
    assert.equal(localIso(parseScheduleValue('08/19/2026', '9:30', now)), '2026-08-19 09:30');
    assert.equal(localIso(parseScheduleValue('19/08/2026', '9:30', now)), '2026-08-19 09:30');
});

test('parseScheduleValue handles AM/PM', () => {
    const now = new Date(2026, 7, 18, 12, 0, 0, 0);

    assert.equal(localIso(parseScheduleValue('2026-08-18', '4:45 PM', now)), '2026-08-18 16:45');
    assert.equal(localIso(parseScheduleValue('2026-08-18', '12:05 AM', now)), '2026-08-18 00:05');
    assert.equal(localIso(parseScheduleValue('2026-08-18', '12:05 PM', now)), '2026-08-18 12:05');
});

test('parseScheduleValue falls back to today when the date has no separator', () => {
    const now = new Date(2026, 7, 18, 12, 0, 0, 0);

    assert.equal(localIso(parseScheduleValue('hom nay', '07:20', now)), '2026-08-18 07:20');
});

test('parseScheduleValue returns null on missing or unreadable input', () => {
    assert.equal(parseScheduleValue('', '00:10'), null);
    assert.equal(parseScheduleValue('2026-08-18', ''), null);
    assert.equal(parseScheduleValue('2026-08-18', 'khong co gio'), null);
});

// --- parseStudioScheduleLabel -----------------------------------------------

test('parseStudioScheduleLabel fills in the current year when the label omits it', () => {
    const now = new Date(2026, 6, 10, 9, 0);

    // new Date("Jul 13, 3:30 PM") tự cho ra năm 2001 — mốc phải là năm hiện tại.
    assert.equal(localIso(parseStudioScheduleLabel('Jul 13, 3:30 PM', now)), '2026-07-13 15:30');
    assert.equal(localIso(parseStudioScheduleLabel('Jul 13, 15:30', now)), '2026-07-13 15:30');
    assert.equal(localIso(parseStudioScheduleLabel('13 Jul, 15:30', now)), '2026-07-13 15:30');
});

test('parseStudioScheduleLabel rolls to next year for a label read across new year', () => {
    const now = new Date(2026, 11, 29, 23, 40);

    assert.equal(localIso(parseStudioScheduleLabel('Jan 2, 9:00 AM', now)), '2027-01-02 09:00');
    // Lịch vừa chạy xong vài ngày trước vẫn thuộc năm hiện tại, không đẩy sang năm sau.
    assert.equal(localIso(parseStudioScheduleLabel('Dec 27, 9:00 AM', now)), '2026-12-27 09:00');
});

test('parseStudioScheduleLabel honours an explicit year in the label', () => {
    const now = new Date(2026, 6, 10, 9, 0);

    assert.equal(localIso(parseStudioScheduleLabel('Dec 25, 2027 3:30 PM', now)), '2027-12-25 15:30');
    assert.equal(localIso(parseStudioScheduleLabel('12/25/2027 3:30 PM', now)), '2027-12-25 15:30');
    assert.equal(localIso(parseStudioScheduleLabel('25/12/2027 15:30', now)), '2027-12-25 15:30');
});

test('parseStudioScheduleLabel strips the "Scheduled" prefix TikTok puts on the label', () => {
    const now = new Date(2026, 6, 10, 9, 0);

    assert.equal(localIso(parseStudioScheduleLabel('Scheduled for Jul 13, 3:30 PM', now)), '2026-07-13 15:30');
    assert.equal(localIso(parseStudioScheduleLabel('Scheduled Jul 13, 3:30 PM', now)), '2026-07-13 15:30');
});

test('parseStudioScheduleLabel reads midnight and noon correctly', () => {
    const now = new Date(2026, 6, 10, 9, 0);

    assert.equal(localIso(parseStudioScheduleLabel('Jul 13, 12:05 AM', now)), '2026-07-13 00:05');
    assert.equal(localIso(parseStudioScheduleLabel('Jul 13, 12:05 PM', now)), '2026-07-13 12:05');
});

test('parseStudioScheduleLabel returns null on empty or unreadable labels', () => {
    const now = new Date(2026, 6, 10, 9, 0);

    assert.equal(parseStudioScheduleLabel('', now), null);
    assert.equal(parseStudioScheduleLabel(null, now), null);
    assert.equal(parseStudioScheduleLabel('Public', now), null);
    assert.equal(parseStudioScheduleLabel('Jul 13', now), null);
    assert.equal(parseStudioScheduleLabel('3:30 PM', now), null);
    assert.equal(parseStudioScheduleLabel('Feb 31, 3:30 PM', now), null);
});

test('computeDelayedFirstTime delays by the configured hours and rounds up to the interval', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    const scheduled = computeDelayedFirstTime({
        delayHours: 1,
        intervalMinutes: 5,
        now
    });

    assert.equal(scheduled.toISOString(), '2026-04-12T10:20:00.000Z');
});

test('computeDelayedFirstTime accepts fractional hours down to half an hour', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    assert.equal(
        computeDelayedFirstTime({ delayHours: 0.5, intervalMinutes: 10, now }).toISOString(),
        '2026-04-12T09:50:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayHours: 1.5, intervalMinutes: 15, now }).toISOString(),
        '2026-04-12T11:00:00.000Z'
    );
});

test('computeDelayedFirstTime keeps the +20 minute floor TikTok needs', () => {
    // Delay nhỏ hơn mốc TikTok chấp nhận vẫn phải rơi về sàn +20 phút, giống
    // hai hàm lên lịch còn lại.
    const now = new Date('2026-04-12T09:16:33.336Z');

    assert.equal(
        computeDelayedFirstTime({ delayHours: 0.1, intervalMinutes: 5, now }).toISOString(),
        '2026-04-12T09:40:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayHours: 0, intervalMinutes: 5, now }).toISOString(),
        '2026-04-12T09:40:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayHours: 'x', intervalMinutes: 5, now }).toISOString(),
        '2026-04-12T09:40:00.000Z'
    );
});

test('computeDelayedFirstTime caps the delay at the 10 days TikTok allows', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    const scheduled = computeDelayedFirstTime({
        delayHours: 500,
        intervalMinutes: 5,
        now
    });

    assert.equal(scheduled.toISOString(), '2026-04-22T09:20:00.000Z');
});

test('computeAutoIncrementTime chains from a delayed first slot', () => {
    // Video 2 trở đi nối tiếp từ giờ đã hẹn của video 1, không quay về now+20p.
    const now = new Date('2026-04-12T09:16:33.336Z');
    const first = computeDelayedFirstTime({ delayHours: 2, intervalMinutes: 10, now });

    const second = computeAutoIncrementTime({ lastScheduledTime: first, intervalMinutes: 10, now });
    const third = computeAutoIncrementTime({ lastScheduledTime: second, intervalMinutes: 10, now });

    assert.equal(first.toISOString(), '2026-04-12T11:20:00.000Z');
    assert.equal(second.toISOString(), '2026-04-12T11:30:00.000Z');
    assert.equal(third.toISOString(), '2026-04-12T11:40:00.000Z');
});
