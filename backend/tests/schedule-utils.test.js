import test from 'node:test';
import assert from 'node:assert/strict';

import {
    POST_DELAY_MAX_MINUTES,
    STUDIO_MAX_PENDING_DAYS,
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

test('STUDIO_MAX_PENDING_DAYS leaves room for every schedule TikTok accepts', () => {
    // Trần dùng để phát hiện đọc nhãn hỏng. Nó phải nằm ngoài mọi mốc hợp lệ,
    // nếu không một lịch thật hẹn sát 10 ngày sẽ bị coi là rác và chặn upload.
    const maxLegitDays = POST_DELAY_MAX_MINUTES / (24 * 60);

    assert.equal(maxLegitDays, 10);
    assert.ok(
        STUDIO_MAX_PENDING_DAYS > maxLegitDays,
        `trần ${STUDIO_MAX_PENDING_DAYS} ngày không được nhỏ hơn mốc hợp lệ xa nhất ${maxLegitDays} ngày`
    );
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

test('parseStudioScheduleLabel rolls back a year for a December label read in January', () => {
    // Chiều ngược của mốc giao thừa: đứng đầu tháng 1 nhìn lại lịch tháng 12 vừa
    // rồi, phải ra năm trước chứ không phải tháng 12 gần một năm nữa.
    const now = new Date(2027, 0, 2, 9, 0);

    assert.equal(localIso(parseStudioScheduleLabel('Dec 27, 9:00 AM', now)), '2026-12-27 09:00');
});

test('parseStudioScheduleLabel keeps a long-overdue label in the current year', () => {
    // Lịch trễ vẫn là lịch của năm nay. Trước đây nhãn lùi quá 7 ngày bị đọc
    // thành năm sau, kéo cả loạt đăng nhảy đi gần 365 ngày.
    const now = new Date(2026, 7, 28, 10, 0);

    assert.equal(localIso(parseStudioScheduleLabel('Aug 27, 7:30 AM', now)), '2026-08-27 07:30');
    assert.equal(localIso(parseStudioScheduleLabel('Aug 20, 7:30 AM', now)), '2026-08-20 07:30');
    assert.equal(localIso(parseStudioScheduleLabel('Aug 10, 7:30 AM', now)), '2026-08-10 07:30');
    assert.equal(localIso(parseStudioScheduleLabel('Jul 13, 3:30 PM', now)), '2026-07-13 15:30');
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

test('computeDelayedFirstTime delays by the configured minutes and rounds up to the interval', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    const scheduled = computeDelayedFirstTime({
        delayMinutes: 60,
        intervalMinutes: 5,
        now
    });

    assert.equal(scheduled.toISOString(), '2026-04-12T10:20:00.000Z');
});

test('computeDelayedFirstTime accepts a delay as short as 10 minutes', () => {
    // Mốc 15 phút là sàn của setting: phải đi thẳng qua, không bị kéo lên 20
    // phút như hai hàm lên lịch còn lại.
    const now = new Date('2026-04-12T09:16:33.336Z');

    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 10, now }).toISOString(),
        '2026-04-12T09:30:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 30, intervalMinutes: 10, now }).toISOString(),
        '2026-04-12T09:50:00.000Z'
    );
    // 09:16:33 + 90 phút là 10:46:33, làm tròn lên mốc 5 phút thành 10:50.
    // Interval của profile không còn ảnh hưởng tới mốc đầu.
    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 90, now }).toISOString(),
        '2026-04-12T10:50:00.000Z'
    );
});

test('computeDelayedFirstTime keeps the +10 minute floor TikTok needs', () => {
    // Delay nhỏ hơn mốc TikTok chấp nhận vẫn phải rơi về sàn +10 phút, rồi làm
    // tròn lên mốc 5 phút: 09:16:33 + 10 phút là 09:26:33 -> 09:30.
    const now = new Date('2026-04-12T09:16:33.336Z');

    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 5, now }).toISOString(),
        '2026-04-12T09:30:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 0, now }).toISOString(),
        '2026-04-12T09:30:00.000Z'
    );
    assert.equal(
        computeDelayedFirstTime({ delayMinutes: 'x', now }).toISOString(),
        '2026-04-12T09:30:00.000Z'
    );
});

test('computeDelayedFirstTime always lands on a 5 minute mark', () => {
    // Ô giờ của TikTok là time picker và chỉ có bằng chứng nó nhận bội số 5,
    // nên mọi mốc -- kể cả khi hẹn số phút lẻ -- phải rơi vào bội số 5.
    const now = new Date('2026-04-12T09:16:33.336Z');

    for (const delay of [15, 17, 30, 130, 131, 137]) {
        const slot = computeDelayedFirstTime({ delayMinutes: delay, now });
        assert.equal(slot.getMinutes() % 5, 0, `hẹn ${delay} phút ra phút lẻ ${slot.toISOString()}`);
        assert.equal(slot.getSeconds(), 0);
        assert.ok(slot.getTime() >= now.getTime() + delay * 60 * 1000);
    }
});

test('computeDelayedFirstTime never schedules earlier than asked when rounding to the minute', () => {
    // 09:16:33 + 130 phút là 11:26:33. Làm tròn xuống thành 11:26 sẽ đặt lịch
    // sớm hơn mốc đã hẹn, nên phải lên 11:27.
    const now = new Date('2026-04-12T09:16:33.336Z');
    const scheduled = computeDelayedFirstTime({ delayMinutes: 130, now });

    assert.ok(scheduled.getTime() - now.getTime() >= 130 * 60 * 1000);
    assert.equal(scheduled.getSeconds(), 0);
});

test('computeAutoIncrementTime chains by exactly one interval from the first slot', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');
    const first = computeDelayedFirstTime({ delayMinutes: 130, now });

    const second = computeAutoIncrementTime({ lastScheduledTime: first, intervalMinutes: 5, now });
    const third = computeAutoIncrementTime({ lastScheduledTime: second, intervalMinutes: 5, now });

    assert.equal(first.toISOString(), '2026-04-12T11:30:00.000Z');
    assert.equal(second.toISOString(), '2026-04-12T11:35:00.000Z');
    assert.equal(third.toISOString(), '2026-04-12T11:40:00.000Z');
});

test('computeDelayedFirstTime caps the delay at the 10 days TikTok allows', () => {
    const now = new Date('2026-04-12T09:16:33.336Z');

    const scheduled = computeDelayedFirstTime({
        delayMinutes: 500 * 60,
        intervalMinutes: 5,
        now
    });

    assert.equal(scheduled.toISOString(), '2026-04-22T09:20:00.000Z');
});

test('computeAutoIncrementTime skips whole intervals instead of leaving the rhythm', () => {
    // Loạt cũ 9:15 / 9:30 / 9:45. Chạy lúc 9:16 thì 9:30 chỉ còn 14 phút nữa,
    // không kịp mốc tối thiểu, nên phải bỏ đúng một nhịp sang 9:45 -- chứ không
    // lấy now + 20 phút làm gốc mới rồi ra 10:00 như trước.
    const existing = new Date(2026, 7, 28, 9, 15);
    const opts = { lastScheduledTime: existing, intervalMinutes: 15, minLeadMinutes: 15 };

    const at = (h, m) => computeAutoIncrementTime({ ...opts, now: new Date(2026, 7, 28, h, m) });

    assert.equal(localIso(at(9, 5)), '2026-08-28 09:30');
    assert.equal(localIso(at(9, 10)), '2026-08-28 09:30');
    assert.equal(localIso(at(9, 16)), '2026-08-28 09:45');
    assert.equal(localIso(at(9, 31)), '2026-08-28 10:00');
});

test('computeAutoIncrementTime keeps a long-overdue batch on its original rhythm', () => {
    // Mốc trễ hai ngày vẫn phải rơi vào đúng phút của nhịp cũ, và phải nhảy
    // thẳng chứ không cộng dồn từng nhịp một.
    const existing = new Date(2026, 7, 26, 9, 15);
    const now = new Date(2026, 7, 28, 9, 16);

    const next = computeAutoIncrementTime({
        lastScheduledTime: existing, intervalMinutes: 15, now, minLeadMinutes: 15
    });

    assert.equal(localIso(next), '2026-08-28 09:45');
});

test('computeAutoIncrementTime leaves past slots alone when no minimum lead is asked for', () => {
    // Mặc định minLeadMinutes = 0, để nhánh auto-increment cũ giữ nguyên hành vi.
    const existing = new Date(2026, 7, 28, 9, 15);
    const now = new Date(2026, 7, 28, 9, 16);

    assert.equal(
        localIso(computeAutoIncrementTime({ lastScheduledTime: existing, intervalMinutes: 15, now })),
        '2026-08-28 09:30'
    );
});

test('computeAutoIncrementTime chains from a delayed first slot', () => {
    // Video 2 trở đi nối tiếp từ giờ đã hẹn của video 1, không quay về now+20p.
    const now = new Date('2026-04-12T09:16:33.336Z');
    const first = computeDelayedFirstTime({ delayMinutes: 120, intervalMinutes: 10, now });

    const second = computeAutoIncrementTime({ lastScheduledTime: first, intervalMinutes: 10, now });
    const third = computeAutoIncrementTime({ lastScheduledTime: second, intervalMinutes: 10, now });

    assert.equal(first.toISOString(), '2026-04-12T11:20:00.000Z');
    assert.equal(second.toISOString(), '2026-04-12T11:30:00.000Z');
    assert.equal(third.toISOString(), '2026-04-12T11:40:00.000Z');
});
