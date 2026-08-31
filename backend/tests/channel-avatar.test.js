// Kiểm phần đọc avatar kênh: hàm lọc thuần, rồi cả nhánh DOM chạy trong một
// trang chromium thật dựng theo hình dáng header của TikTok Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pickAvatarSrc, fetchChannelAvatar } from '../stats-automation.mjs';

const REAL = 'https://p16-sign.tiktokcdn-us.com/tos-avt-0068/abc~tplv-tiktokx-cropcenter_1080_1080.jpeg';
// Hai URL dưới đây theo đúng hình dáng thật đọc được từ trang TikTok Studio
// (id đã thay bằng chuỗi giả). Khác nhau đúng một chỗ: object store của avatar
// là "-avt-", của cover video là "-p-".
const STUDIO_AVATAR = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-avt-0068-tx2/0000avatar0000~tplv-tiktokx-cropcenter:720:720.jpeg?dr=9640&t=4d5b0474';
const VIDEO_COVER = 'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-p-0068-tx2/0000cover0000~tplv-tiktokx-cropcenter:300:400.jpeg?dr=9640&t=4d5b0474';

test('pickAvatarSrc takes the first usable http url', () => {
  assert.equal(pickAvatarSrc(['', REAL, 'https://other.example/x.jpg']), REAL);
});

test('pickAvatarSrc unwraps a background-image value', () => {
  assert.equal(pickAvatarSrc([`url("${REAL}")`]), REAL);
  assert.equal(pickAvatarSrc([`url('${REAL}')`]), REAL);
  assert.equal(pickAvatarSrc([`url(${REAL})`]), REAL);
});

// Placeholder xám mà Studio dựng trước khi avatar thật về. Lưu nhầm nó thì card
// kẹt một ô xám và lần quét sau vẫn tưởng là đã có avatar.
test('pickAvatarSrc skips placeholders and keeps looking', () => {
  const candidates = ['none', 'data:image/png;base64,iVBORw0KGgo=', '/static/blank.png', REAL];
  assert.equal(pickAvatarSrc(candidates), REAL);
});

test('pickAvatarSrc returns null when nothing is usable', () => {
  assert.equal(pickAvatarSrc([]), null);
  assert.equal(pickAvatarSrc(['none', undefined, 42]), null);
});

let browser, page;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
test.after(async () => { await browser?.close(); });

const readFrom = async (html) => {
  await page.setContent(`<body>${html}</body>`);
  return fetchChannelAvatar(page);
};

test('reads the avatar from the studio header img', async () => {
  assert.equal(
    await readFrom(`<div id="header-profile-avatar"><img src="${REAL}"></div>`),
    REAL,
  );
});

test('reads the avatar when it is drawn as a background image', async () => {
  assert.equal(
    await readFrom(`<div id="header-profile-avatar" style="background-image:url('${REAL}')"></div>`),
    REAL,
  );
});

test('falls back to the data-e2e avatar selectors', async () => {
  assert.equal(
    await readFrom(`<div data-e2e="profile-icon"><img src="${REAL}"></div>`),
    REAL,
  );
});

test('returns null instead of throwing when the header is absent', async () => {
  assert.equal(await readFrom('<div>no header here</div>'), null);
});

// Markup thật của header TikTok Studio — nơi lượt quét thực sự đứng. Trang này
// KHÔNG có #header-profile-avatar; id đó chỉ tồn tại trên tiktok.com, và việc
// bê nhầm nó sang đây là nguyên nhân lượt quét đầu tiên không lấy được avatar.
test('reads the avatar from the TikTok Studio header', async () => {
  const html = `
    <div data-tt="components_Avatar_AvatarContainer">
      <img data-tt="components_Avatar_AvatarImg" src="${STUDIO_AVATAR}">
    </div>`;
  assert.equal(await readFrom(html), STUDIO_AVATAR);
});

// Phòng khi TikTok đổi tên data-tt: vẫn nhận ra avatar qua object store "-avt-".
test('falls back to the -avt- object path when the markup is unfamiliar', async () => {
  const html = `
    <img src="${VIDEO_COVER}">
    <div class="brand-new-wrapper"><img src="${STUDIO_AVATAR}"></div>`;
  assert.equal(await readFrom(html), STUDIO_AVATAR);
});

// Trang Content đầy cover video; bắt nhầm một cái thì avatar của kênh hoá ra
// thumbnail của một video nào đó.
test('never mistakes a video cover for the channel avatar', async () => {
  const html = `<img data-tt="VideoCover_index_picture" src="${VIDEO_COVER}">`;
  assert.equal(await readFrom(html), null);
});
