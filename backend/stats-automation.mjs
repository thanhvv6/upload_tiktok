// backend/stats-automation.mjs
import { chromium } from 'playwright';
import path from 'path';

const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const RESTRICTION_TEXT = 'Your video is not eligible for recommendation in the For You feed';
const ROW_SEL = '[data-tt="components_PostTable_Absolute"]';

export async function runStatsForProfile(profile, jobId, ctx) {
  const { PROFILES_DIR, pushEvent, appendResult, markProfileDone, markError, isAborted } = ctx;
  const userDataDir = path.join(PROFILES_DIR, profile.name);
  let browser = null;
  const log = (msg) => console.log(`[${profile.name}][STATS] ${msg}`);

  try {
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
      viewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();

    log('Opening TikTok Studio content page');
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Get total from "Posts 153" badge — instant, no scrolling needed
    const totalVideos = await page.evaluate(() => {
      const m = document.body.innerText.match(/Posts\s+([\d,]+)/);
      return m ? parseInt(m[1].replace(/,/g, '')) : 0;
    });
    log(`Total videos from badge: ${totalVideos}`);

    if (totalVideos === 0) {
      log('No videos found');
      markProfileDone(jobId, profile.id);
      return;
    }

    pushEvent(jobId, {
      type: 'progress',
      profileId: profile.id,
      profileName: profile.name,
      done: 0,
      total: totalVideos,
    });

    // Wait for rows to appear
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length > 0,
      ROW_SEL,
      { timeout: 15000 }
    );

    // Track absolute scroll position. Each row is height="100px" so advance by 100px per video.
    // Using SPA goBack preserves inner div scroll position, then we set it explicitly.
    let currentScrollTop = 0;

    for (let i = 0; i < totalVideos; i++) {
      if (isAborted(jobId)) break;

      log(`Processing video ${i + 1}/${totalVideos}`);

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
        log(`Video ${i + 1}: rows not found, skipping`);
        currentScrollTop += 100;
        continue;
      }

      // Get first VISIBLE row's data + ChartRise click position.
      // Sets scroll to currentScrollTop, then finds row whose top >= container.top.
      const videoData = await page.evaluate(({ rowSel, scrollTop }) => {
        let container = null, bestArea = 0;
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);
          if (['auto', 'scroll'].includes(s.overflow) || ['auto', 'scroll'].includes(s.overflowY)) {
            const area = el.clientWidth * el.clientHeight;
            if (el.scrollHeight > el.clientHeight + 100 && area > bestArea) { container = el; bestArea = area; }
          }
        });
        if (container) container.scrollTop = scrollTop;

        const containerRect = container?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };

        for (const row of document.querySelectorAll(rowSel)) {
          const rowRect = row.getBoundingClientRect();
          if (rowRect.top >= containerRect.top - 5 && rowRect.bottom > containerRect.top) {
            const dateEl = row.querySelector('[data-tt="components_PublishStageLabel_TUXText"]');
            const viewsEl = row.querySelector('[data-tt="components_ItemRow_TUXText"]');
            const linkEl = row.querySelector('[data-tt="components_PostInfoCell_a"]');

            let chartBtn = null;
            for (const c of row.querySelectorAll('[data-tt="components_ActionCell_Container"]')) {
              if (c.querySelector('[data-icon="ChartRise"]')) { chartBtn = c; break; }
            }
            if (!chartBtn) continue;

            const chartRect = chartBtn.getBoundingClientRect();
            return {
              dateRaw: dateEl?.textContent?.trim() ?? '',
              views: parseInt(viewsEl?.textContent?.replace(/,/g, '') ?? '0') || 0,
              videoId: linkEl?.getAttribute('href')?.match(/\/video\/(\d+)/)?.[1] ?? '',
              clickPos: { cx: chartRect.x + chartRect.width / 2, cy: chartRect.y + chartRect.height / 2 },
            };
          }
        }
        return null;
      }, { rowSel: ROW_SEL, scrollTop: currentScrollTop });

      if (!videoData) {
        log(`Video ${i + 1}: no visible row at scroll=${currentScrollTop}, skipping`);
        currentScrollTop += 100;
        continue;
      }

      // Click the ChartRise analytics button via mouse (hover triggers CSS :hover, then click)
      await page.mouse.move(videoData.clickPos.cx, videoData.clickPos.cy - 50);
      await page.waitForTimeout(150);
      await page.mouse.move(videoData.clickPos.cx, videoData.clickPos.cy);
      await page.waitForTimeout(200);
      await page.mouse.click(videoData.clickPos.cx, videoData.clickPos.cy);
      await page.waitForTimeout(4000);

      if (!page.url().includes('analytics')) {
        log(`Video ${i + 1}: analytics page not reached, skipping`);
        currentScrollTop += 100;
        continue;
      }

      // Check restriction banner on analytics page
      const restricted = await checkRestriction(page);

      // Get date from analytics page (has full year); fall back to content page date
      const bodyText = await page.evaluate(() => document.body.innerText);
      const analyticsDateMatch = bodyText.match(/Posted on (\d{1,2}\/\d{1,2}\/\d{4})/);
      const date = analyticsDateMatch ? analyticsDateMatch[1] : parseContentDate(videoData.dateRaw);

      log(`Video ${i + 1}/${totalVideos}: date=${date} views=${videoData.views} restricted=${restricted}`);

      const result = {
        title: videoData.videoId ? `Video ${videoData.videoId}` : `Video ${i + 1}`,
        date,
        views: videoData.views,
        restricted,
      };

      appendResult(jobId, profile.id, result);
      pushEvent(jobId, { type: 'video', profileId: profile.id, ...result });
      pushEvent(jobId, {
        type: 'progress',
        profileId: profile.id,
        profileName: profile.name,
        done: i + 1,
        total: totalVideos,
      });

      // SPA goBack — preserves inner div scroll, then we set to next position
      await ensureContentPage(page, log);
      currentScrollTop += 100; // advance by one row (height="100px")
    }

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
