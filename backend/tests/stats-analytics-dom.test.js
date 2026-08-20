// Exercises the analytics-page DOM heuristics in a real browser against a
// fixture shaped like TikTok Studio's video overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readVideoAnalytics, readRestriction, AWAITING_PUBLISH_PATTERNS } from '../stats-automation.mjs';

const LABELS = {
  likeLabels: ['Likes', 'Like', 'Lượt thích', 'Thích'],
  followLabels: ['New followers', 'New follower', 'Người theo dõi mới', 'Lượt theo dõi mới', 'Follower mới'],
  awaitingPublishPatterns: AWAITING_PUBLISH_PATTERNS,
};

const tile = (value, label) =>
  `<div class="tile"><div class="v"><span>${value}</span></div><div class="l"><span>${label}</span></div></div>`;

const fixture = ({ views = '12.5K', likes = '1,204', follows = '37', lang = 'en', extra = '' } = {}) => `
  <div class="head">
    <div data-tt="VideoOverviewPage_VideoInfoCard_TUXText">My video caption 2026</div>
    <div data-tt="VideoOverviewPage_VideoInfoCard_TUXText">Posted on 08/14/2026</div>
    <div data-tt="VideoOverviewPage_VideoInfoCard_TUXText">${views}</div>
  </div>
  <div class="grid">
    ${tile(views, lang === 'vi' ? 'Lượt xem video' : 'Video views')}
    ${tile('98.2%', lang === 'vi' ? 'Tỉ lệ giữ chân' : 'Retention rate')}
    ${tile(likes, lang === 'vi' ? 'Lượt thích' : 'Likes')}
    ${tile('88', lang === 'vi' ? 'Bình luận' : 'Comments')}
    ${tile(follows, lang === 'vi' ? 'Người theo dõi mới' : 'New followers')}
  </div>
  ${extra}
`;

let browser, page;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
test.after(async () => { await browser?.close(); });

const read = async (html) => {
  await page.setContent(`<body>${html}</body>`);
  return page.evaluate(readVideoAnalytics, LABELS);
};

const readRestricted = async (html) => {
  await page.setContent(`<body>${html}</body>`);
  return page.evaluate(readRestriction, { awaitingPublishPatterns: AWAITING_PUBLISH_PATTERNS });
};

const bannerHtml = (text) =>
  `<div data-tt="components_AnalyticsPageBanner_TUXText">${text}</div>`;

test('reads views, likes and new followers from an English analytics page', async () => {
  const r = await read(fixture());
  assert.equal(r.date, '08/14/2026');
  assert.equal(r.views, 12500);
  assert.equal(r.likes, 1204);
  assert.equal(r.newFollowers, 37);
});

test('reads the same metrics when the UI is in Vietnamese', async () => {
  const r = await read(fixture({ lang: 'vi', likes: '2,500', follows: '9' }));
  assert.equal(r.likes, 2500);
  assert.equal(r.newFollowers, 9);
});

test('keeps zero distinct from "not found"', async () => {
  const r = await read(fixture({ likes: '0', follows: '0' }));
  assert.equal(r.likes, 0);
  assert.equal(r.newFollowers, 0);
});

test('returns null when a metric tile is absent', async () => {
  const html = `
    <div data-tt="VideoOverviewPage_VideoInfoCard_TUXText">Posted on 08/14/2026</div>
    <div data-tt="VideoOverviewPage_VideoInfoCard_TUXText">500</div>`;
  const r = await read(html);
  assert.equal(r.views, 500);
  assert.equal(r.likes, null);
  assert.equal(r.newFollowers, null);
});

test('never mistakes a percentage or a date for a metric', async () => {
  const html = `
    <div class="tile"><div><span>12.3%</span></div><div><span>Likes</span></div></div>
    <div class="tile"><div><span>Posted on 08/14/2026</span></div><div><span>New followers</span></div></div>`;
  const r = await read(html);
  assert.equal(r.likes, null);
  assert.equal(r.newFollowers, null);
});

test('handles abbreviated counts and non-breaking spaces', async () => {
  const r = await read(fixture({ likes: '1.2M', follows: '3.4 K' }));
  assert.equal(r.likes, 1200000);
  assert.equal(r.newFollowers, 3400);
});

// --- video đang chờ lịch --------------------------------------------------
// TikTok không dựng trang analytics cho video chưa công khai; nó chỉ hiện lời
// nhắc đổi trạng thái bài đăng. Đó là dấu hiệu để loại video khỏi thống kê.

test('flags a scheduled video that has no analytics yet', async () => {
    const r = await read('<div><p>To see analytics, switch your post status to public.</p></div>');

    assert.equal(r.awaitingPublish, true);
});

test('flags the same page when the UI is in Vietnamese', async () => {
    const r = await read('<div><p>Để xem phân tích, hãy chuyển trạng thái bài đăng của bạn sang công khai.</p></div>');

    assert.equal(r.awaitingPublish, true);
});

test('does not flag a normal published analytics page', async () => {
    const r = await read(fixture());

    assert.equal(r.awaitingPublish, false);
    assert.equal(r.views, 12500);
});

test('does not flag a Vietnamese published analytics page', async () => {
    const r = await read(fixture({ lang: 'vi' }));

    assert.equal(r.awaitingPublish, false);
});

// --- hạn chế vs chờ lịch ---------------------------------------------------
// Cả hai trạng thái dùng CHUNG một banner. Phân biệt sai thì hoặc video chờ lịch
// bị đếm là hạn chế, hoặc video hạn chế thật bị bỏ qua khỏi thống kê.

test('does not call a scheduled video restricted, though it uses the same banner', async () => {
    const r = await readRestricted(bannerHtml('To see analytics, switch your post status to public.'));

    assert.equal(r, false);
});

test('does not call a Vietnamese scheduled video restricted', async () => {
    const r = await readRestricted(bannerHtml('Để xem phân tích, hãy chuyển trạng thái bài đăng của bạn sang công khai.'));

    assert.equal(r, false);
});

test('still reports a genuinely restricted video from the banner', async () => {
    const r = await readRestricted(bannerHtml('This video is not eligible for the For You feed.'));

    assert.equal(r, true);
});

test('still reports restriction from the body text without a banner', async () => {
    const r = await readRestricted('<div><p>This video is not eligible for recommendation.</p></div>');

    assert.equal(r, true);
});

test('a normal published analytics page is not restricted', async () => {
    const r = await readRestricted(fixture());

    assert.equal(r, false);
});
