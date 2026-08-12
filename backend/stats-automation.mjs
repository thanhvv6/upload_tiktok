// backend/stats-automation.mjs
import { chromium } from 'playwright';
import path from 'path';

const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const ANALYTICS_URL = 'https://www.tiktok.com/tiktokstudio/analytics';
const API_PATH = '/tiktok/creator/manage/item_list/v1/';

export async function runStatsForProfile(profile, jobId, ctx) {
  const {
    PROFILES_DIR,
    pushEvent,
    appendResult,
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

    for (const video of videos) {
      if (isAborted(jobId)) {
        log('Job aborted');
        break;
      }

      log(`[${processedCount + 1}/${videos.length}] Extracting stats for video ${video.id}...`);

      // Navigate directly to analytics page for this video
      const analyticsUrl = `${ANALYTICS_URL}/${video.id}`;
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

      // Check restriction
      const restricted = await checkRestriction(page);

      // Extract date and views
      const analyticsData = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const dateMatch = bodyText.match(/Posted on (\d{1,2}\/\d{1,2}\/\d{4})/);

        const viewEls = document.querySelectorAll('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]');
        let views = 0;
        for (const el of viewEls) {
          const text = el.textContent?.trim().replace(/,/g, '');
          const num = parseInt(text);
          if (!isNaN(num) && num > 0) { views = num; break; }
        }

        return { date: dateMatch ? dateMatch[1] : null, views };
      });

      const date = analyticsData.date ?? video.date ?? '';
      const views = analyticsData.views || 0;

      processedCount++;
      log(`  -> date=${date} views=${views.toLocaleString()} restricted=${restricted}`);

      const result = {
        title: `Video ${video.id}`,
        date,
        views,
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
