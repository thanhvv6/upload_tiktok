// backend/stats-automation.mjs
import { chromium } from 'playwright';
import path from 'path';

const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const RESTRICTION_TEXT = 'Your video is not eligible for recommendation in the For You feed';
const ROW_SEL = '[data-tt="components_PostTable_Absolute"]';

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
    parseProxy
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
    // Stats automation does NOT use proxy — direct connection for stability

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

    // Wait for content page components or empty state to appear
    const combinedSelector = [
      '[data-tt="components_PostTable_Absolute"]',
      '[data-tt*="PostTable"]',
      'button:has-text("Upload first video")',
      'button:has-text("Upload video")',
      'div:has-text("No content")',
      'div:has-text("No videos")',
      '[role="row"]'
    ].join(', ');

    try {
      await page.waitForSelector(combinedSelector, { timeout: 15000 });
    } catch {
      await page.waitForTimeout(3000);
    }

    if (page.url().includes('login') || page.url().includes('passport')) {
      log('Redirected to login page while loading stats');
      throw new Error('Profile chưa đăng nhập hoặc cookie đã hết hạn (bị chuyển hướng sang trang Login).');
    }

    // Check if channel is empty or has video rows
    const isEmptyState = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Upload first video') ||
             text.includes('No content') ||
             text.includes('No videos') ||
             text.includes('Upload video to get started');
    });

    const hasRows = await page.evaluate(({ rowSel }) => {
      return document.querySelectorAll(`${rowSel}, [data-tt*="PostTable"], [class*="PostTable"], [role="row"]`).length > 0;
    }, { rowSel: ROW_SEL });

    if (isEmptyState && !hasRows) {
      log('No videos found (empty state confirmed)');
      pushEvent(jobId, {
        type: 'progress',
        profileId: profile.id,
        profileName: profile.name,
        done: 0,
        total: 0,
      });
      markProfileDone(jobId, profile.id);
      return;
    }

    log('Starting full scan for all videos...');
    pushEvent(jobId, {
      type: 'progress',
      profileId: profile.id,
      profileName: profile.name,
      done: 0,
      total: 0,
    });

    let processedCount = 0;
    const seenVideoKeys = new Set();
    const MAX_SAFETY_LIMIT = 2000;
    let consecutiveNoNewVideos = 0;

    for (let loop = 0; loop < MAX_SAFETY_LIMIT; loop++) {
      if (isAborted(jobId)) break;

      // Return to content page if needed
      await ensureContentPage(page, log);

      // Wait for rows to appear
      try {
        await page.waitForFunction(
          (sel) => document.querySelectorAll(sel).length > 0,
          ROW_SEL,
          { timeout: 15000 }
        );
      } catch {
        const currentUrl = page.url();
        log(`Table rows not found (url=${currentUrl}). Ending scan. Processed: ${processedCount}, seenKeys: ${seenVideoKeys.size}`);
        break;
      }

      // Find the first unvisited row in DOM
      const nextRow = await page.evaluate(({ rowSel, seenKeys }) => {
        let rows = Array.from(document.querySelectorAll(rowSel));
        if (rows.length === 0) {
          rows = Array.from(document.querySelectorAll('[data-tt*="PostTable"], [class*="ItemRow"], [class*="PostTable"]'));
        }

        const seenSet = new Set(seenKeys);

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const dateEl = row.querySelector('[data-tt="components_PublishStageLabel_TUXText"], [data-tt*="PublishStageLabel"]');
          const viewsEl = row.querySelector('[data-tt="components_ItemRow_TUXText"], [data-tt*="ItemRow"]');

          // Search broadly for a video link — try link selectors, then any <a> with a numeric ID in href
          let linkEl = row.querySelector('a[href*="/video/"]') ||
                       row.querySelector('[data-tt="components_PostInfoCell_a"]') ||
                       row.querySelector('a[href*="tiktok.com"]');
          if (!linkEl) {
            const allLinks = row.querySelectorAll('a');
            for (const a of allLinks) {
              if (/\/video\/\d+/.test(a.getAttribute('href') || '')) { linkEl = a; break; }
            }
          }

          const videoId = linkEl?.getAttribute('href')?.match(/\/video\/(\d+)/)?.[1] ?? '';
          const dateRaw = dateEl?.textContent?.trim() ?? '';
          const views = parseInt(viewsEl?.textContent?.replace(/,/g, '') ?? '0') || 0;
          const key = videoId || (dateRaw ? `${dateRaw}_${views}_${i}` : `row_${i}`);

          if (!seenSet.has(key)) {
            row.scrollIntoView({ block: 'center', behavior: 'instant' });
            const rect = row.getBoundingClientRect();
            return {
              found: true,
              domIndex: i,
              videoKey: key,
              dateRaw,
              views,
              videoId,
              rowCenter: { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 }
            };
          }
        }

        return { found: false, totalDOMRows: rows.length };
      }, { rowSel: ROW_SEL, seenKeys: Array.from(seenVideoKeys) });

      if (!nextRow.found) {
        // TikTok Studio uses overflow:hidden virtual scroll — DOM scroll methods have no effect.
        // Only native OS-level wheel events (via CDP) trigger the virtual scroll handler.
        const wheelDelta = consecutiveNoNewVideos === 0 ? -600 : -900;
        await page.mouse.wheel(0, wheelDelta);
        await page.waitForTimeout(1500);

        const rowCountAfterWheel = await page.evaluate((sel) => {
          let rows = document.querySelectorAll(sel);
          if (rows.length === 0) {
            rows = document.querySelectorAll('[data-tt*="PostTable"], [class*="ItemRow"], [class*="PostTable"]');
          }
          return rows.length;
        }, ROW_SEL);

        if (rowCountAfterWheel > nextRow.totalDOMRows) {
          log(`Wheel scroll loaded more rows: ${nextRow.totalDOMRows} → ${rowCountAfterWheel}`);
          consecutiveNoNewVideos = 0;
          continue;
        }

        consecutiveNoNewVideos++;
        log(`No new rows after wheel scroll (attempt ${consecutiveNoNewVideos}/2). totalDOMRows=${nextRow.totalDOMRows} seenKeys=${seenVideoKeys.size}`);
        if (consecutiveNoNewVideos >= 2) {
          log(`Finished scanning all videos! Total scanned: ${processedCount}, unique keys: ${seenVideoKeys.size}`);
          break;
        }
        await page.waitForTimeout(1000);
        continue;
      }

      consecutiveNoNewVideos = 0;
      seenVideoKeys.add(nextRow.videoKey);
      log(`Scanning video ${processedCount + 1} [${nextRow.videoKey}]...`);

      // Step 1: Hover over the row to trigger CSS :hover and reveal hidden action buttons
      await page.mouse.move(nextRow.rowCenter.cx, nextRow.rowCenter.cy);
      await page.waitForTimeout(400);

      // Step 2: Re-fetch ChartRise button position
      const chartPos = await page.evaluate(({ rowSel, domIdx }) => {
        let rows = Array.from(document.querySelectorAll(rowSel));
        if (rows.length === 0) rows = Array.from(document.querySelectorAll('[data-tt*="PostTable"], [class*="ItemRow"], [class*="PostTable"]'));
        const row = rows[domIdx];
        if (!row) return null;
        const icon = row.querySelector('[data-icon="ChartRise"], svg[class*="ChartRise"], [data-icon*="Chart"]');
        if (!icon) return null;
        let btn = icon;
        while (btn && btn !== row) {
          if (btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.getAttribute('role') === 'button') break;
          btn = btn.parentElement;
        }
        if (!btn || btn === row) btn = icon;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
      }, { rowSel: ROW_SEL, domIdx: nextRow.domIndex });

      if (!chartPos) {
        log(`Video [${nextRow.videoKey}]: ChartRise button not visible after hover, skipping`);
        continue;
      }

      // Step 3: Hover then click the analytics button
      await page.mouse.move(chartPos.cx, chartPos.cy);
      await page.waitForTimeout(150);
      await page.mouse.click(chartPos.cx, chartPos.cy);

      // Step 4: Wait for analytics URL (max 8s)
      try {
        await page.waitForURL('**/analytics**', { timeout: 8000 });
      } catch {
        log(`Video [${nextRow.videoKey}]: analytics page not reached after click (url=${page.url()}), skipping`);
        continue;
      }

      // Extract videoId from analytics URL: .../tiktokstudio/analytics/7673006199935175966
      const urlVideoId = (page.url().match(/\/analytics\/(\d+)/) || [])[1] || '';
      const videoId = nextRow.videoId || urlVideoId;
      if (urlVideoId && !seenVideoKeys.has(urlVideoId)) seenVideoKeys.add(urlVideoId);

      // Wait for analytics page content to fully render (works for both restricted and normal videos)
      try {
        await page.waitForSelector('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]', { timeout: 8000 });
      } catch {
        log(`Video [${nextRow.videoKey}]: analytics content not loaded yet, extracting anyway...`);
      }

      // Check restriction banner AFTER page has rendered
      const restricted = await checkRestriction(page);

      // Extract date AND views from analytics page
      const analyticsData = await page.evaluate(() => {
        // Date: "Posted on 7/20/2026"
        const bodyText = document.body.innerText || '';
        const dateMatch = bodyText.match(/Posted on (\d{1,2}\/\d{1,2}\/\d{4})/);

        // Views: first [data-tt="VideoOverviewPage_VideoInfoCard_TUXText"] = video views count
        const viewEls = document.querySelectorAll('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]');
        let views = 0;
        const allValues = [];
        for (const el of viewEls) {
          const text = el.textContent?.trim().replace(/,/g, '');
          allValues.push(text);
          const num = parseInt(text);
          if (!isNaN(num) && num > 0) { views = num; break; }
        }

        return { date: dateMatch ? dateMatch[1] : null, views, allValues, elCount: viewEls.length };
      });

      const date = analyticsData.date ?? parseContentDate(nextRow.dateRaw);
      const views = analyticsData.views || nextRow.views;

      processedCount++;
      log(`Video ${processedCount} [${videoId || nextRow.videoKey}]: date=${date} views=${views} restricted=${restricted}`);

      const result = {
        title: videoId ? `Video ${videoId}` : `Video ${processedCount}`,
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
        total: processedCount,
      });
    }

    // Push final progress update matching exact processed count
    pushEvent(jobId, {
      type: 'progress',
      profileId: profile.id,
      profileName: profile.name,
      done: processedCount,
      total: processedCount,
    });

    markProfileDone(jobId, profile.id);
  } catch (err) {
    log(`Error: ${err.message}`);
    markError(jobId, profile.id, err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Return to content page: SPA goBack first (fast, preserves scroll), fall back to goto
async function ensureContentPage(page, log) {
  const url = page.url();
  if (url.includes('tiktokstudio/content') && !url.includes('analytics')) return;

  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(800);
  } catch { /* ignore */ }

  if (!page.url().includes('tiktokstudio/content') || page.url().includes('analytics')) {
    if (log) log('goBack failed, navigating to content page');
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
  }
}

async function checkRestriction(page) {
  return await page.evaluate(() => {
    // Check by specific data-tt selector first (DOM presence, CSS-independent)
    const banner = document.querySelector('[data-tt="components_AnalyticsPageBanner_TUXText"]');
    if (banner) return true;
    // Fallback: textContent (not innerText) ignores CSS visibility
    return (document.body.textContent || '').includes('not eligible for recommendation');
  });
}

function parseContentDate(text) {
  // "Jul 13, 2025" with explicit year
  const withYear = text.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (withYear) {
    const m = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
    return `${m[withYear[1]]}/${withYear[2]}/${withYear[3]}`;
  }
  // "Jul 13, 4:20 PM" with time instead of year — assume current year
  const withTime = text.match(/(\w{3})\s+(\d{1,2}),/);
  if (withTime) {
    const m = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };
    return `${m[withTime[1]]}/${withTime[2]}/${new Date().getFullYear()}`;
  }
  return text;
}
