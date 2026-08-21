// Cookie dán dạng chuỗi không mang hạn dùng. Tiêm nguyên như vậy thì Playwright
// tạo cookie phiên và ghi đè mất cookie persistent trong user-data-dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookieHeader, IMPORTED_COOKIE_TTL_DAYS } from '../cookie-utils.js';

const NOW = Date.UTC(2026, 7, 21, 3, 46);

test('gives imported cookies an expiry so they do not become session cookies', () => {
    const parsed = parseCookieHeader('sessionid=abc; tt-target-idc=useast2a', NOW);

    assert.equal(parsed.length, 2);
    for (const cookie of parsed) {
        assert.ok(typeof cookie.expires === 'number' && cookie.expires > 0,
            `${cookie.name} phải có hạn, nếu không nó thành cookie phiên`);
    }
    assert.equal(parsed[0].expires, Math.floor((NOW + IMPORTED_COOKIE_TTL_DAYS * 86400_000) / 1000));
});

test('parses names and values, keeping values that contain "="', () => {
    const parsed = parseCookieHeader('tt_chain_token=rDmIQ/lvSfHw47A==; ttwid=1%7CWhtN', NOW);

    assert.deepEqual(parsed.map(c => c.name), ['tt_chain_token', 'ttwid']);
    assert.equal(parsed[0].value, 'rDmIQ/lvSfHw47A==');
    assert.equal(parsed[1].value, '1%7CWhtN');
});

test('scopes imported cookies to tiktok', () => {
    const [cookie] = parseCookieHeader('sessionid=abc', NOW);

    assert.equal(cookie.domain, '.tiktok.com');
    assert.equal(cookie.path, '/');
});

test('skips malformed fragments instead of producing junk cookies', () => {
    const parsed = parseCookieHeader('sessionid=abc; khong-co-dau-bang; =rong; ttwid=1', NOW);

    assert.deepEqual(parsed.map(c => c.name), ['sessionid', 'ttwid']);
});

test('returns an empty list for empty or non-string input', () => {
    assert.deepEqual(parseCookieHeader('', NOW), []);
    assert.deepEqual(parseCookieHeader(null, NOW), []);
    assert.deepEqual(parseCookieHeader(undefined, NOW), []);
});

test('honours a custom lifetime', () => {
    const parsed = parseCookieHeader('sessionid=abc', NOW, 1);

    assert.equal(parsed[0].expires, Math.floor((NOW + 86400_000) / 1000));
});

// --- hasLiveTikTokSession ---------------------------------------------------
// Điều kiện chặn việc tiêm cookie. Sai ở đây thì hoặc phiên đăng nhập tay bị
// bộ cookie cũ trong DB đè mất, hoặc profile chưa đăng nhập không được mồi gì.

import { hasLiveTikTokSession, SESSION_COOKIE } from '../cookie-utils.js';

const secAt = (ms) => Math.floor(ms / 1000);
const ck = (name, extra = {}) => ({ name, value: 'v', domain: '.tiktok.com', expires: -1, ...extra });

test('sees a live session that still has time on it', () => {
    const cookies = [ck(SESSION_COOKIE, { expires: secAt(NOW + 86400_000) })];

    assert.equal(hasLiveTikTokSession(cookies, NOW), true);
});

test('treats a session cookie as live, since it works for this run', () => {
    assert.equal(hasLiveTikTokSession([ck(SESSION_COOKIE)], NOW), true);
});

test('does not count an expired session', () => {
    const cookies = [ck(SESSION_COOKIE, { expires: secAt(NOW - 1000) })];

    assert.equal(hasLiveTikTokSession(cookies, NOW), false);
});

test('does not count an empty session value', () => {
    const cookies = [ck(SESSION_COOKIE, { value: '', expires: secAt(NOW + 86400_000) })];

    assert.equal(hasLiveTikTokSession(cookies, NOW), false);
});

test('ignores a session cookie belonging to another site', () => {
    const cookies = [{ name: SESSION_COOKIE, value: 'v', domain: '.example.com', expires: secAt(NOW + 86400_000) }];

    assert.equal(hasLiveTikTokSession(cookies, NOW), false);
});

test('says no for a profile that has never logged in', () => {
    assert.equal(hasLiveTikTokSession([], NOW), false);
    assert.equal(hasLiveTikTokSession([ck('ttwid')], NOW), false);
});

test('pins the imported-cookie lifetime to TikTok\'s own ~6 month session', () => {
    // Ngắn hơn thì phần tiêm rút ngắn chính phiên TikTok còn chấp nhận; đo được
    // sessionid thật sống tới 2027-02-17, tức khoảng 6 tháng.
    assert.equal(IMPORTED_COOKIE_TTL_DAYS, 180);
});
