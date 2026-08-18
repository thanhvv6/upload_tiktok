// Exercises the analytics-page DOM heuristics in a real browser against a
// fixture shaped like TikTok Studio's video overview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readVideoAnalytics } from '../stats-automation.mjs';

const LABELS = {
  likeLabels: ['Likes', 'Like', 'Lượt thích', 'Thích'],
  followLabels: ['New followers', 'New follower', 'Người theo dõi mới', 'Lượt theo dõi mới', 'Follower mới'],
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
