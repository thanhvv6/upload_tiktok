// Ước lượng loạt lịch của lượt chạy kế tiếp — con số hiện trên card profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRunSchedule } from '../schedule-utils.js';

const at = (h, m, day = 3) => new Date(2026, 8, day, h, m, 0, 0);
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Đúng ví dụ người dùng đưa ra: mốc cuối đã đặt là 7:30, folder có 10 video,
// mỗi video cách 15 phút. Loạt mới chạy 7:45 → 10:00.
test('projects the run from an anchor that is still in the future', () => {
  const r = projectRunSchedule({
    lastScheduledAt: at(7, 30),
    videoCount: 10,
    intervalMinutes: 15,
    autoIncrement: true,
    now: at(7, 0),
  });
  assert.equal(r.count, 10);
  assert.equal(hhmm(r.first), '07:45');
  assert.equal(hhmm(r.last), '10:00');
});

// Mốc cũ đã trôi qua: mốc đầu phải nhảy tới nhịp hợp lệ đầu tiên còn cách hiện
// tại đủ xa, chứ không được đẻ ra một giờ trong quá khứ.
test('skips past slots instead of scheduling in the past', () => {
  const r = projectRunSchedule({
    lastScheduledAt: at(7, 30),
    videoCount: 4,
    intervalMinutes: 15,
    autoIncrement: true,
    now: at(9, 0),
  });
  assert.ok(r.first.getTime() >= at(9, 15).getTime(), `mốc đầu ${hhmm(r.first)} phải từ 09:15 trở đi`);
  // Nhịp cũ được giữ: mọi mốc vẫn rơi vào lưới 15 phút tính từ 7:30.
  assert.equal((r.first.getTime() - at(7, 30).getTime()) % (15 * 60 * 1000), 0);
  assert.equal(r.last.getTime() - r.first.getTime(), 3 * 15 * 60 * 1000);
});

// Chưa từng chạy lượt nào: mốc đầu lấy theo số phút hẹn giờ đang cài.
test('falls back to the post-delay setting when there is no anchor', () => {
  const r = projectRunSchedule({
    lastScheduledAt: null,
    videoCount: 3,
    intervalMinutes: 10,
    postDelayMinutes: 60,
    now: at(8, 0),
  });
  assert.equal(hhmm(r.first), '09:00');
  assert.equal(hhmm(r.last), '09:20');
});

// Profile bật lịch cố định chỉ đăng upload_count video mỗi lượt; đếm cả folder
// là ước lượng vống lên nhiều giờ.
test('caps the count at upload_count for scheduled profiles', () => {
  const r = projectRunSchedule({
    lastScheduledAt: at(7, 30),
    videoCount: 40,
    intervalMinutes: 15,
    autoIncrement: true,
    isScheduled: true,
    uploadCount: 3,
    now: at(7, 0),
  });
  assert.equal(r.count, 3);
  assert.equal(hhmm(r.last), '08:15');
});

test('uses the folder count when upload_count is not in play', () => {
  const r = projectRunSchedule({
    lastScheduledAt: at(7, 30),
    videoCount: 2,
    intervalMinutes: 15,
    autoIncrement: true,
    isScheduled: true,
    uploadCount: 0,
    now: at(7, 0),
  });
  assert.equal(r.count, 2);
});

test('returns null when the profile does not schedule at all', () => {
  assert.equal(projectRunSchedule({
    lastScheduledAt: at(7, 30), videoCount: 10, autoIncrement: false, postDelayMinutes: 0, now: at(7, 0),
  }), null);
});

test('returns null when the folder is empty', () => {
  assert.equal(projectRunSchedule({
    lastScheduledAt: at(7, 30), videoCount: 0, autoIncrement: true, now: at(7, 0),
  }), null);
});

test('survives a malformed anchor by falling back to the delay path', () => {
  const r = projectRunSchedule({
    lastScheduledAt: 'không phải ngày tháng',
    videoCount: 2,
    intervalMinutes: 10,
    postDelayMinutes: 30,
    now: at(8, 0),
  });
  assert.equal(hhmm(r.first), '08:30');
});
