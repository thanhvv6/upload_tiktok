// The analytics XHR payloads are the primary source for likes / new followers;
// the DOM is only a fallback. These cover the payload mining.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMetric, collectMetricKeys, LIKE_KEYS, NEW_FOLLOWER_KEYS,
  pickAccountMetric, FOLLOWER_TOTAL_KEYS,
} from '../stats-automation.mjs';

test('finds a metric nested deep inside a payload', () => {
  const payload = { data: { video: { stats: { play_count: 900, like_count: 412 } } } };
  assert.equal(pickMetric([payload], LIKE_KEYS), 412);
});

test('accepts numeric strings, which TikTok uses for large ids and counts', () => {
  assert.equal(pickMetric([{ d: { digg_count: '1503' } }], LIKE_KEYS), 1503);
});

test('reads new followers under any of the known field spellings', () => {
  assert.equal(pickMetric([{ overview: { new_follower_num: 27 } }], NEW_FOLLOWER_KEYS), 27);
  assert.equal(pickMetric([{ overview: { new_followers: 5 } }], NEW_FOLLOWER_KEYS), 5);
});

test('does not confuse total followers with new followers', () => {
  assert.equal(pickMetric([{ user: { follower_num: 98000 } }], NEW_FOLLOWER_KEYS), null);
});

test('returns null instead of guessing when nothing matches', () => {
  assert.equal(pickMetric([{ a: { b: 1 } }, { c: 2 }], LIKE_KEYS), null);
  assert.equal(pickMetric([], LIKE_KEYS), null);
});

test('falls through to a later payload that carries the metric', () => {
  const payloads = [{ config: { ttl: 300 } }, { stats: { like_count: 77 } }];
  assert.equal(pickMetric(payloads, LIKE_KEYS), 77);
});

test('survives cycles and non-object leaves without throwing', () => {
  const cyclic = { stats: { like_count: 3 } };
  cyclic.self = cyclic;
  assert.equal(pickMetric([cyclic], LIKE_KEYS), 3);
  assert.equal(pickMetric([null, 'x', 5, { ok: true }], LIKE_KEYS), null);
});

test('reports the like/follow field names it saw, for diagnosing TikTok renames', () => {
  const keys = collectMetricKeys([{ stats: { like_count: 1, follower_num: 2, share_count: 3 } }]);
  assert.deepEqual(keys.sort(), ['follower_num', 'like_count']);
});

// Số follower cấp kênh đến từ /aweme/v2/data/insight/ trên trang Studio
// analytics. TikTok bọc mỗi chỉ số trong {status, value}: status 0 là số thật,
// status 2 nghĩa là không có dữ liệu cho khoảng đó và không kèm value.
// pickMetric không dùng được ở đây vì deepScan chỉ nhìn thấy lá số — tức key
// "value" — nên đã mất tên "follower_num" của cha.
test('reads a follower total out of TikTok\'s {status, value} wrapper', () => {
  const payload = { follower_num: { status: 0, value: 1349 }, vv_history: null };
  assert.equal(pickAccountMetric([payload], FOLLOWER_TOTAL_KEYS), 1349);
});

test('keeps a legitimate zero rather than treating it as missing', () => {
  assert.equal(pickAccountMetric([{ follower_num: { status: 0, value: 0 } }], FOLLOWER_TOTAL_KEYS), 0);
});

test('skips a no-data wrapper and takes the next payload that has the number', () => {
  const nothing = { follower_num: { status: 2 } };
  const real = { follower_num: { status: 0, value: 42 } };
  assert.equal(pickAccountMetric([nothing, real], FOLLOWER_TOTAL_KEYS), 42);
});

test('finds the total nested below the payload root', () => {
  assert.equal(pickAccountMetric([{ data: { overview: { follower_count: 77 } } }], FOLLOWER_TOTAL_KEYS), 77);
});

test('accepts a bare number, which some insight responses still use', () => {
  assert.equal(pickAccountMetric([{ follower_num: 8 }], FOLLOWER_TOTAL_KEYS), 8);
});

test('returns null when no payload carries a follower total', () => {
  assert.equal(pickAccountMetric([{ vv_history: null }, {}], FOLLOWER_TOTAL_KEYS), null);
});

test('does not mistake a per-video new-follower series for the channel total', () => {
  const payload = { video_new_followers_history_7d: [{ status: 0, value: 3 }] };
  assert.equal(pickAccountMetric([payload], FOLLOWER_TOTAL_KEYS), null);
});
