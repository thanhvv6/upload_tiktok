// backend/stats-automation.mjs
import { chromium } from 'playwright';
import path from 'path';

const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const ANALYTICS_URL = 'https://www.tiktok.com/tiktokstudio/analytics';
const API_PATH = '/tiktok/creator/manage/item_list/v1/';

// Metric names TikTok uses for the same number across its analytics payloads.
export const LIKE_KEYS = ['like_count', 'digg_count', 'like_num', 'likes', 'total_like', 'total_likes'];
export const NEW_FOLLOWER_KEYS = [
  'new_follower_num', 'new_follower_count', 'new_followers', 'new_follower',
  'follower_increase', 'net_follower_num', 'follower_num_increase',
];
// Tổng follower hiện tại của kênh, đọc từ /aweme/v2/data/insight/ trên trang
// Studio analytics. Tách hẳn khỏi NEW_FOLLOWER_KEYS: những khoá kia là số
// follower tăng thêm của riêng một video, không phải con số net của cả kênh.
export const FOLLOWER_TOTAL_KEYS = ['follower_num', 'follower_count', 'total_follower_num'];
// Chuỗi TikTok hiển thị thay cho analytics khi video chưa công khai (đang chờ
// lịch). Hai hàm chạy-trong-trang bên dưới đều cần, mà page.evaluate không mang
// theo biến ngoài, nên giữ ở dạng nguồn regex để truyền vào như tham số.
export const AWAITING_PUBLISH_PATTERNS = [
  'post status to public',
  'tr\u1ea1ng th\u00e1i[^.]{0,40}c\u00f4ng khai',
];
const LIKE_LABELS = ['Likes', 'Like', 'Lượt thích', 'Thích'];
const NEW_FOLLOWER_LABELS = [
  'New followers', 'New follower', 'Người theo dõi mới', 'Lượt theo dõi mới', 'Follower mới',
];

export async function runStatsForProfile(profile, jobId, ctx) {
  const {
    PROFILES_DIR,
    pushEvent,
    appendResult,
    setProfileMeta,
    markProfileDone,
    markError,
    isAborted,
    applyProfileFingerprint,
    injectProfileCookies,
    statsLimitDate,
  } = ctx;
  const userDataDir = path.join(PROFILES_DIR, profile.name);
  let browser = null;
  const log = (msg) => console.log(`[${profile.name}][STATS] ${msg}`);

  try {
    const browserOptions = {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
      viewport: { width: 1440, height: 900 },
    };

    browser = await chromium.launchPersistentContext(userDataDir, browserOptions);

    if (typeof applyProfileFingerprint === 'function') {
      await applyProfileFingerprint(browser, profile);
    }
    if (typeof injectProfileCookies === 'function') {
      await injectProfileCookies(browser, profile);
    }

    const page = browser.pages()[0] || await browser.newPage();

    log('Opening TikTok Studio content page');
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to fully load (API calls happen after initial render)
    await page.waitForTimeout(4000);

    if (page.url().includes('login') || page.url().includes('passport')) {
      log('Redirected to login page');
      throw new Error('Profile chưa đăng nhập hoặc cookie đã hết hạn (bị chuyển hướng sang trang Login).');
    }

    // ── Phase 1: Discover all video IDs via TikTok's internal API ──
    log('Phase 1: Discovering all videos via API pagination...');

    const videos = await discoverAllVideos(page, log, isAborted, jobId, statsLimitDate);

    // Số follower của kênh — best effort, hỏng ở đây không được phép làm
    // gãy lượt quét từng video.
    const account = await fetchAccountStats(page, profile, log);
    if (typeof setProfileMeta === 'function') {
      setProfileMeta(jobId, profile.id, account);
    }
    pushEvent(jobId, {
      type: 'account', profileId: profile.id, profileName: profile.name, ...account,
    });

    if (videos.length === 0) {
      log('No videos found');
      pushEvent(jobId, {
        type: 'progress', profileId: profile.id, profileName: profile.name, done: 0, total: 0,
      });
      markProfileDone(jobId, profile.id);
      return;
    }

    log(`Discovered ${videos.length} unique videos`);

    pushEvent(jobId, {
      type: 'progress', profileId: profile.id, profileName: profile.name, done: 0, total: videos.length,
    });

    // ── Phase 2: Extract stats for each video ──
    let processedCount = 0;
    let skippedScheduled = 0;
    const sniffer = attachAnalyticsSniffer(page);
    let loggedMetricKeys = false;

    for (const video of videos) {
      if (isAborted(jobId)) {
        log('Job aborted');
        break;
      }

      log(`[${processedCount + 1}/${videos.length}] Extracting stats for video ${video.id}...`);

      // Navigate directly to analytics page for this video
      const analyticsUrl = `${ANALYTICS_URL}/${video.id}`;
      sniffer.reset();
      try {
        await page.goto(analyticsUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        log(`Navigation to analytics for ${video.id} timed out, skipping`);
        continue;
      }

      // Wait for analytics content. Trang không có thẻ này (video hạn chế, hoặc
      // video đang chờ lịch) sẽ chờ hết 8 giây — đó cũng là khoảng nghỉ để
      // banner kịp render trước khi đọc. Nếu muốn rút ngắn, nhớ waitForSelector
      // mặc định chờ state 'visible', không phải chỉ gắn vào DOM.
      try {
        await page.waitForSelector('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]', { timeout: 8000 });
      } catch {
        // Continue anyway — restriction page may not have this element
      }

      // Likes / new-follower tiles render below the fold, after the first paint
      await page.waitForTimeout(500);

      // Check restriction
      const restricted = await checkRestriction(page);

      // Extract date, views, likes and new followers from the rendered page
      const analyticsData = await page.evaluate(
        readVideoAnalytics,
        {
          likeLabels: LIKE_LABELS,
          followLabels: NEW_FOLLOWER_LABELS,
          awaitingPublishPatterns: AWAITING_PUBLISH_PATTERNS,
        },
      );

      // Video đang chờ lịch: không có số liệu để lấy. Vẫn tính vào tiến độ vì
      // nó đã được duyệt, nhưng không đưa vào kết quả hay Excel.
      if (analyticsData.awaitingPublish) {
        processedCount++;
        skippedScheduled++;
        log(`  -> skipped: chua dang (dang cho lich)`);
        pushEvent(jobId, {
          type: 'progress',
          profileId: profile.id,
          profileName: profile.name,
          done: processedCount,
          total: videos.length,
        });
        continue;
      }

      const payloads = sniffer.take();
      if (!loggedMetricKeys) {
        loggedMetricKeys = true;
        const keys = collectMetricKeys(payloads);
        if (keys.length) log(`  analytics API metric keys: ${keys.join(', ')}`);
      }

      const date = analyticsData.date ?? video.date ?? '';
      const views = analyticsData.views || 0;
      const likes = pickMetric(payloads, LIKE_KEYS) ?? video.likes ?? analyticsData.likes ?? null;
      const newFollowers = pickMetric(payloads, NEW_FOLLOWER_KEYS) ?? analyticsData.newFollowers ?? null;

      processedCount++;
      log(`  -> date=${date} views=${views.toLocaleString()} likes=${likes ?? '?'} newFollowers=${newFollowers ?? '?'} restricted=${restricted}`);

      const result = {
        title: `Video ${video.id}`,
        date,
        views,
        likes,
        newFollowers,
        restricted,
      };

      appendResult(jobId, profile.id, result);
      pushEvent(jobId, { type: 'video', profileId: profile.id, ...result });
      pushEvent(jobId, {
        type: 'progress',
        profileId: profile.id,
        profileName: profile.name,
        done: processedCount,
        total: videos.length,
      });
    }

    pushEvent(jobId, {
      type: 'progress',
      profileId: profile.id,
      profileName: profile.name,
      done: processedCount,
      total: videos.length,
    });

    sniffer.detach();
    markProfileDone(jobId, profile.id);
    log(`Done! Processed ${processedCount}/${videos.length} videos`
      + (skippedScheduled ? ` (${skippedScheduled} scheduled, excluded from stats)` : ''));
  } catch (err) {
    log(`Error: ${err.message}`);
    markError(jobId, profile.id, err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Paginate through TikTok's internal API to discover all video IDs
async function discoverAllVideos(page, log, isAborted, jobId, statsLimitDate) {
  const allVideos = [];
  const seenIds = new Set();
  const limitTs = statsLimitDate ? new Date(statsLimitDate + 'T00:00:00').getTime() / 1000 : null;

  // Build the base URL params from the page context
  const baseParams = await page.evaluate(() => {
    const p = new URLSearchParams({
      locale: 'en',
      aid: '1988',
      priority_region: 'VN',
      region: 'US',
      app_name: 'tiktok_creator_center',
      app_language: 'en',
      device_platform: 'web_pc',
      channel: 'tiktok_web',
      os: 'mac',
      screen_width: String(window.screen.width || 1440),
      screen_height: String(window.screen.height || 900),
      browser_language: navigator.language || 'en-US',
      browser_platform: navigator.platform || 'MacIntel',
      browser_name: 'Mozilla',
      browser_version: navigator.userAgent?.match(/Chrome\/([\d.]+)/)?.[1]
        ? `5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${navigator.userAgent.match(/Chrome\/([\d.]+)/)[1]} Safari/537.36`
        : '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    return p.toString();
  });

  let cursor = 0;
  let hasMore = true;
  const MAX_PAGES = 20;

  while (hasMore && !isAborted(jobId) && cursor < 10000) {
    const pageResult = await page.evaluate(async ({ apiPath, baseParams, cursor, limitTs }) => {
      try {
        const body = JSON.stringify({
          cursor: cursor,
          size: 50,
          query: {
            sort_orders: [{ field_name: 'post_time', order: 2 }],
            conditions: [],
            is_recent_posts: false
          }
        });

        const resp = await fetch(apiPath + '?' + baseParams, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: body,
        });

        const data = await resp.json();
        const allItems = (data.item_list || []).map(item => ({
          id: item.item_id || item.aweme_id || '',
          title: (item.title || '').substring(0, 80),
          date: item.create_time ? new Date(item.create_time * 1000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '',
          create_time: item.create_time || 0,
          likes: item.stats?.like_count ?? item.stats?.digg_count
            ?? item.statistics?.digg_count ?? item.like_count ?? item.digg_count ?? null,
        }));

        // Filter by limit date if set (API returns newest first)
        const items = limitTs ? allItems.filter(item => item.create_time >= limitTs) : allItems;
        const allOutOfRange = limitTs && allItems.length > 0 && items.length === 0;

        return {
          items,
          hasMore: allOutOfRange ? false : (data.has_more || false),
          nextCursor: data.cursor || cursor + 50,
          statusCode: data.status_code,
          allOutOfRange,
        };
      } catch (e) {
        return { error: e.message, items: [], hasMore: false, nextCursor: cursor };
      }
    }, { apiPath: API_PATH, baseParams, cursor, limitTs });

    if (pageResult.error) {
      log(`API error at cursor ${cursor}: ${pageResult.error}`);
      break;
    }

    if (pageResult.allOutOfRange) {
      log(`Cursor ${cursor}: all ${pageResult.items.length} videos older than limit date, stopping`);
      break;
    }

    let newCount = 0;
    for (const video of pageResult.items) {
      if (video.id && !seenIds.has(video.id)) {
        seenIds.add(video.id);
        allVideos.push(video);
        newCount++;
      }
    }

    log(`Cursor ${cursor}: ${newCount} new videos (total: ${allVideos.length}, has_more: ${pageResult.hasMore})`);

    hasMore = pageResult.hasMore;
    cursor = pageResult.nextCursor;

    if (allVideos.length >= MAX_PAGES * 50) {
      log(`Safety limit reached (${MAX_PAGES * 50} videos)`);
      break;
    }
  }

  log(`Discovery complete: ${allVideos.length} unique videos`);
  return allVideos;
}

async function checkRestriction(page) {
  return await page.evaluate(readRestriction, {
    awaitingPublishPatterns: AWAITING_PUBLISH_PATTERNS,
  });
}

// Runs inside the analytics page. Exported so it can be tested against a
// fixture instead of a live TikTok session.
export function readRestriction({ awaitingPublishPatterns = [] } = {}) {
  const matches = (text) =>
    awaitingPublishPatterns.some((pattern) => new RegExp(pattern).test(String(text || '').toLowerCase()));

  const banner = document.querySelector('[data-tt="components_AnalyticsPageBanner_TUXText"]');
  // Trang của video đang chờ lịch dùng CHÍNH banner này để nhắc đổi trạng thái
  // bài đăng sang công khai. Đó không phải hạn chế — coi nhầm thì mọi video chờ
  // lịch bị đếm vào ô "Bị hạn chế".
  if (banner && !matches(banner.textContent)) return true;

  return (document.body.textContent || '').includes('not eligible for recommendation');
}



// Runs inside the analytics page. Exported so the DOM heuristics can be tested
// against a fixture instead of a live TikTok session.
export function readVideoAnalytics({ likeLabels, followLabels, awaitingPublishPatterns = [] }) {
  const parseViews = (raw) => {
    const match = String(raw || '').trim().replace(/,/g, '').match(/^([\d.]+)\s*([KMB])?/i);
    if (!match) return NaN;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] || 1;
    return parseFloat(match[1]) * mult;
  };

  // Stricter than parseViews: the whole text must be the number, so that
  // "Posted on 01/02/2026" or "12.3%" never gets mistaken for a metric.
  const parseMetric = (raw) => {
    const text = String(raw || '').replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
    const match = text.match(/^(\d+(?:\.\d+)?)\s*([KMB])?$/i);
    if (!match) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] || 1;
    return Math.round(parseFloat(match[1]) * mult);
  };

  const norm = (raw) => String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const leaves = Array.from(
    document.querySelectorAll('div,span,p,h1,h2,h3,h4,strong,label')
  ).filter(el => el.children.length === 0);

  // TikTok Studio renders each metric as a value + label pair; walk up from
  // the label until a sibling that is purely a number shows up.
  const readByLabel = (labels) => {
    const targets = labels.map(norm);
    for (const leaf of leaves) {
      if (!targets.includes(norm(leaf.textContent))) continue;
      let scope = leaf.parentElement;
      for (let up = 0; up < 4 && scope; up++) {
        for (const el of scope.querySelectorAll('*')) {
          if (el.children.length !== 0 || el === leaf) continue;
          const value = parseMetric(el.textContent);
          if (value !== null) return value;
        }
        scope = scope.parentElement;
      }
    }
    return null;
  };

  const bodyText = document.body.innerText || '';
  const dateMatch = bodyText.match(/Posted on (\d{1,2}\/\d{1,2}\/\d{4})/);

  // Video đang chờ lịch chưa có analytics: TikTok thay toàn bộ nội dung bằng
  // lời nhắc "To see analytics, switch your post status to public." Đây là dấu
  // hiệu duy nhất đáng tin — API item_list trả video chờ lịch chung danh sách
  // với video đã đăng, và create_time của chúng là giờ upload nên không tách được.
  const lowerBody = bodyText.toLowerCase();
  const awaitingPublish = awaitingPublishPatterns.some((pattern) => new RegExp(pattern).test(lowerBody));

  const viewEls = document.querySelectorAll('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]');
  let views = 0;
  for (const el of viewEls) {
    const num = parseViews(el.textContent);
    if (!isNaN(num) && num > 0) { views = num; break; }
  }

  return {
    date: dateMatch ? dateMatch[1] : null,
    views,
    likes: readByLabel(likeLabels),
    newFollowers: readByLabel(followLabels),
    awaitingPublish,
  };
}

// ── Analytics API sniffing ───────────────────────────────────────────────────
// TikTok Studio renders the analytics tiles from XHR payloads. Reading those
// payloads gives exact numbers instead of the abbreviated "1.2K" in the DOM.
function attachAnalyticsSniffer(page) {
  const payloads = [];
  const MAX_PAYLOADS = 20;

  const handler = async (response) => {
    try {
      const url = response.url();
      if (!/creator|analytic|insight/i.test(url)) return;
      if (!/json/i.test(response.headers()['content-type'] || '')) return;
      if (payloads.length >= MAX_PAYLOADS) return;
      const json = await response.json();
      if (json && typeof json === 'object') payloads.push(json);
    } catch (_) {
      // Body already discarded or not JSON — nothing to salvage.
    }
  };

  page.on('response', handler);

  return {
    reset: () => { payloads.length = 0; },
    take: () => payloads.slice(),
    detach: () => page.off('response', handler),
  };
}

// Walk a JSON payload and hand every numeric leaf to `visit(key, value)`.
function deepScan(node, visit, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) deepScan(item, visit, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'number' && Number.isFinite(value)) visit(key, value);
    else if (typeof value === 'string' && /^\d+$/.test(value)) visit(key, Number(value));
    else deepScan(value, visit, depth + 1);
  }
}

export function pickMetric(payloads, wantedKeys) {
  for (const payload of payloads) {
    let found = null;
    deepScan(payload, (key, value) => {
      if (found === null && wantedKeys.includes(key.toLowerCase())) found = value;
    });
    if (found !== null) return found;
  }
  return null;
}

// Logged once per profile so a TikTok field rename is visible in the run log
// instead of silently turning into blank Excel cells.
export function collectMetricKeys(payloads) {
  const keys = new Set();
  for (const payload of payloads) {
    deepScan(payload, (key) => {
      if (/like|digg|follow/i.test(key)) keys.add(key);
    });
  }
  return [...keys];
}

// Chỉ số cấp tài khoản không đi qua deepScan được: TikTok bọc chúng thành
// {status, value}, nên lá số duy nhất deepScan nhìn thấy mang key "value" và
// tên thật của chỉ số đã mất. Hàm này giữ lại tên cha, và chỉ nhận value khi
// status là 0 — status 2 nghĩa là TikTok không có dữ liệu cho khoảng đó.
export function pickAccountMetric(payloads, wantedKeys, depthLimit = 8) {
  const wanted = wantedKeys.map((k) => k.toLowerCase());

  const unwrap = (node) => {
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node === 'string' && /^\d+$/.test(node)) return Number(node);
    if (node && typeof node === 'object' && !Array.isArray(node)
      && typeof node.value === 'number' && Number.isFinite(node.value)
      && (node.status == null || node.status === 0)) return node.value;
    return null;
  };

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > depthLimit) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    // Khớp tên ngay tại tầng này trước khi đi sâu, để một khoá đúng ở gốc
    // không bị khoá trùng tên nằm sâu hơn qua mặt.
    for (const [key, value] of Object.entries(node)) {
      if (wanted.includes(key.toLowerCase())) {
        const hit = unwrap(value);
        if (hit !== null) return hit;
      }
    }
    for (const value of Object.values(node)) {
      const hit = walk(value, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };

  for (const payload of payloads) {
    const hit = walk(payload, 0);
    if (hit !== null) return hit;
  }
  return null;
}

// ── Account-level stats ──────────────────────────────────────────────────────
//
// Trước đây hàm này mở https://www.tiktok.com/@handle để đọc followerCount và
// heartCount từ blob rehydration. Đó là web app chính, không phải Studio, và
// với tài khoản đang bị TikTok gắn cờ xác minh thì mỗi lần ghé là một lần phiên
// bị hạ xuống còn 6 tiếng kèm xoá sạch tt-target-idc — đo được trực tiếp trên
// máy: cookie vừa tiêm lúc 00:49:21 thì 00:49:32 đã bị thay. Studio không đi
// qua cổng kiểm tra đó, nên số liệu giờ lấy từ trang analytics của Studio.
//
// Đổi lại, Studio không có tổng tim trọn đời — chỉ có lượt thích theo khoảng
// thời gian. Bỏ luôn `hearts`: Excel lấy cột "Tổng Tim" bằng cách cộng tim của
// từng video, còn card "Tổng tim" trên giao diện đã gỡ ở 9267b1a, nên không ai
// đọc con số đó nữa.
async function fetchAccountStats(page, profile, log) {
  const sniffer = attachAnalyticsSniffer(page);
  try {
    log('Reading account stats from TikTok Studio analytics');
    await page.goto(ANALYTICS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Con số không nằm trong HTML mà bay về qua XHR /aweme/v2/data/insight/,
    // và trang bắn nhiều lượt insight khác nhau — cái mang follower_num không
    // phải lượt đầu. Nên chờ tới khi bắt được thay vì ngủ một khoảng cố định.
    const deadline = Date.now() + 15000;
    let followers = null;
    while (followers === null && Date.now() < deadline) {
      await page.waitForTimeout(500);
      followers = pickAccountMetric(sniffer.take(), FOLLOWER_TOTAL_KEYS);
    }

    log(`  account: followers=${followers ?? '?'}`);
    return { followers };
  } catch (err) {
    log(`Account stats unavailable: ${err.message}`);
    return { followers: null };
  } finally {
    sniffer.detach();
  }
}
