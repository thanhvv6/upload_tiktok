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

    // Account-level numbers (current followers / total hearts) — best effort,
    // a failure here must never abort the per-video stats run.
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

      // Wait for analytics content
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
        { likeLabels: LIKE_LABELS, followLabels: NEW_FOLLOWER_LABELS },
      );

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
    log(`Done! Processed ${processedCount}/${videos.length} videos`);
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
  return await page.evaluate(() => {
    const banner = document.querySelector('[data-tt="components_AnalyticsPageBanner_TUXText"]');
    if (banner) return true;
    return (document.body.textContent || '').includes('not eligible for recommendation');
  });
}



// Runs inside the analytics page. Exported so the DOM heuristics can be tested
// against a fixture instead of a live TikTok session.
export function readVideoAnalytics({ likeLabels, followLabels }) {
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

// ── Account-level stats ──────────────────────────────────────────────────────
async function fetchAccountStats(page, profile, log) {
  const empty = { followers: null, hearts: null };
  try {
    const handle = await resolveHandle(page, profile.name);
    if (!handle) {
      log('Could not resolve TikTok handle, skipping account stats');
      return empty;
    }

    log(`Reading account stats for @${handle}`);
    await page.goto(`https://www.tiktok.com/@${handle}`, {
      waitUntil: 'domcontentloaded', timeout: 20000,
    });
    await page.waitForTimeout(2500);

    const stats = await page.evaluate(() => {
      const parseCompact = (raw) => {
        const text = String(raw || '').replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
        const match = text.match(/^(\d+(?:\.\d+)?)\s*([KMB])?$/i);
        if (!match) return null;
        const mult = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase()] || 1;
        return Math.round(parseFloat(match[1]) * mult);
      };

      let followers = null;
      let hearts = null;

      // Exact numbers live in the rehydration blob; the visible DOM is rounded.
      try {
        const raw = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
        if (raw) {
          const scope = JSON.parse(raw)?.__DEFAULT_SCOPE__ || {};
          const userStats = scope['webapp.user-detail']?.userInfo?.stats;
          if (userStats) {
            followers = userStats.followerCount ?? null;
            hearts = userStats.heartCount ?? userStats.diggCount ?? null;
          }
        }
      } catch (_) {}

      if (followers === null) {
        followers = parseCompact(document.querySelector('[data-e2e="followers-count"]')?.textContent);
      }
      if (hearts === null) {
        hearts = parseCompact(document.querySelector('[data-e2e="likes-count"]')?.textContent);
      }

      return { followers, hearts };
    });

    log(`  account: followers=${stats.followers ?? '?'} hearts=${stats.hearts ?? '?'}`);
    return stats;
  } catch (err) {
    log(`Account stats unavailable: ${err.message}`);
    return empty;
  }
}

// The profile name is normally the TikTok handle, but prefer whatever the
// logged-in session reports so a renamed folder does not send us to a 404.
async function resolveHandle(page, fallbackName) {
  try {
    const detected = await page.evaluate(() => {
      try {
        const raw = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
        if (raw) {
          const scope = JSON.parse(raw)?.__DEFAULT_SCOPE__ || {};
          const user = scope['webapp.app-context']?.user
            || scope['webapp.user-detail']?.userInfo?.user;
          if (user?.uniqueId) return user.uniqueId;
        }
      } catch (_) {}
      const anchor = document.querySelector('a[href^="/@"], a[href*="tiktok.com/@"]');
      const match = anchor?.getAttribute('href')?.match(/@([^/?#]+)/);
      return match ? match[1] : null;
    });
    if (detected) return detected;
  } catch (_) {}
  return fallbackName || null;
}
