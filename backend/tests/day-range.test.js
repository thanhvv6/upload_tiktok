// Khoảng thời gian dùng để đếm "video đã up trong ngày". Mốc phải theo giờ máy,
// vì con số trả lời câu hỏi của người đang nhìn đồng hồ, không phải của UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRangeSeconds } from '../stats-automation.mjs';

const secondsOf = (d) => Math.floor(d.getTime() / 1000);

test('spans exactly the chosen local day', () => {
  const { start, end } = dayRangeSeconds('2026-08-31');
  assert.equal(start, secondsOf(new Date(2026, 7, 31, 0, 0, 0, 0)));
  assert.equal(end, secondsOf(new Date(2026, 8, 1, 0, 0, 0, 0)));
});

test('a video posted at either edge lands on the right side', () => {
  const { start, end } = dayRangeSeconds('2026-08-31');
  // Nửa đêm đầu ngày thuộc về ngày đó; nửa đêm cuối thuộc về ngày sau.
  assert.ok(start >= start && start < end);
  assert.equal(end - start, 24 * 60 * 60);
});

test('falls back to today when the date is missing or malformed', () => {
  const now = new Date(2026, 7, 31, 13, 45, 0, 0);
  const expected = secondsOf(new Date(2026, 7, 31, 0, 0, 0, 0));
  for (const bad of [undefined, null, '', 'hôm nay', '2026-08']) {
    assert.equal(dayRangeSeconds(bad, now).start, expected, `bad input: ${bad}`);
  }
});

test('handles a single-digit month and day', () => {
  const { start } = dayRangeSeconds('2026-1-5');
  assert.equal(start, secondsOf(new Date(2026, 0, 5, 0, 0, 0, 0)));
});
