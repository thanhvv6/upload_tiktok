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

    log('Starting element-index based scan for all videos...');
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
    let rowIndex = 0;

    for (let loop = 0; loop < MAX_SAFETY_LIMIT; loop++) {
      if (isAborted(jobId)) break;

      log(`Scanning video row index ${rowIndex}...`);

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
        log(`Row index ${rowIndex}: table rows not found. Ending scan.`);
        break;
      }

      // Query row at index `rowIndex`
      let evalResult = await page.evaluate(({ rowSel, idx }) => {
        let container = null, bestArea = 0;
        document.querySelectorAll('*').forEach(el => {
          const s = window.getComputedStyle(el);
          if (['auto', 'scroll'].includes(s.overflow) || ['auto', 'scroll'].includes(s.overflowY)) {
            const area = el.clientWidth * el.clientHeight;
            if (el.scrollHeight > el.clientHeight + 100 && area > bestArea) { container = el; bestArea = area; }
          }
        });

        let rows = Array.from(document.querySelectorAll(rowSel));
        if (rows.length === 0) {
          rows = Array.from(document.querySelectorAll('[data-tt*="PostTable"], [class*="ItemRow"], [class*="PostTable"]'));
        }

        if (idx >= rows.length) {
          // Scroll container to trigger virtual rendering if there are more rows
          if (container) container.scrollTop += 500;
          return { videoData: null, totalRowsInDOM: rows.length };
        }

        const row = rows[idx];
        row.scrollIntoView({ block: 'nearest', behavior: 'instant' });

        const dateEl = row.querySelector('[data-tt="components_PublishStageLabel_TUXText"], [data-tt*="PublishStageLabel"]');
        const viewsEl = row.querySelector('[data-tt="components_ItemRow_TUXText"], [data-tt*="ItemRow"]');
        const linkEl = row.querySelector('[data-tt="components_PostInfoCell_a"], a[href*="/video/"]');

        let chartBtn = null;
        for (const c of row.querySelectorAll('[data-tt="components_ActionCell_Container"], [class*="ActionCell"], div, button, a')) {
          if (c.querySelector('[data-icon="ChartRise"], svg[class*="ChartRise"], [data-icon*="Chart"]')) { chartBtn = c; break; }
        }
        if (!chartBtn && row.querySelector('[data-icon="ChartRise"]')) {
          chartBtn = row.querySelector('[data-icon="ChartRise"]');
        }

        if (!chartBtn) {
          return { videoData: null, totalRowsInDOM: rows.length };
        }

        const chartRect = chartBtn.getBoundingClientRect();
        return {
          videoData: {
            dateRaw: dateEl?.textContent?.trim() ?? '',
            views: parseInt(viewsEl?.textContent?.replace(/,/g, '') ?? '0') || 0,
            videoId: linkEl?.getAttribute('href')?.match(/\/video\/(\d+)/)?.[1] ?? '',
            clickPos: { cx: chartRect.x + chartRect.width / 2, cy: chartRect.y + chartRect.height / 2 },
          },
          totalRowsInDOM: rows.length
        };
      }, { rowSel: ROW_SEL, idx: rowIndex });

      // If idx >= totalRowsInDOM, we scrolled container down to see if more rows render
      if (!evalResult.videoData) {
        await page.waitForTimeout(1500);
        evalResult = await page.evaluate(({ rowSel, idx }) => {
          let rows = Array.from(document.querySelectorAll(rowSel));
          if (rows.length === 0) {
            rows = Array.from(document.querySelectorAll('[data-tt*="PostTable"], [class*="ItemRow"], [class*="PostTable"]'));
          }

          if (idx >= rows.length) {
            return { videoData: null, totalRowsInDOM: rows.length };
          }

          const row = rows[idx];
          row.scrollIntoView({ block: 'nearest', behavior: 'instant' });

          const dateEl = row.querySelector('[data-tt="components_PublishStageLabel_TUXText"], [data-tt*="PublishStageLabel"]');
          const viewsEl = row.querySelector('[data-tt="components_ItemRow_TUXText"], [data-tt*="ItemRow"]');
          const linkEl = row.querySelector('[data-tt="components_PostInfoCell_a"], a[href*="/video/"]');

          let chartBtn = null;
          for (const c of row.querySelectorAll('[data-tt="components_ActionCell_Container"], [class*="ActionCell"], div, button, a')) {
            if (c.querySelector('[data-icon="ChartRise"], svg[class*="ChartRise"], [data-icon*="Chart"]')) { chartBtn = c; break; }
          }
          if (!chartBtn && row.querySelector('[data-icon="ChartRise"]')) {
            chartBtn = row.querySelector('[data-icon="ChartRise"]');
          }

          if (!chartBtn) return { videoData: null, totalRowsInDOM: rows.length };

          const chartRect = chartBtn.getBoundingClientRect();
          return {
            videoData: {
              dateRaw: dateEl?.textContent?.trim() ?? '',
              views: parseInt(viewsEl?.textContent?.replace(/,/g, '') ?? '0') || 0,
              videoId: linkEl?.getAttribute('href')?.match(/\/video\/(\d+)/)?.[1] ?? '',
              clickPos: { cx: chartRect.x + chartRect.width / 2, cy: chartRect.y + chartRect.height / 2 },
            },
            totalRowsInDOM: rows.length
          };
        }, { rowSel: ROW_SEL, idx: rowIndex });
      }

      const { videoData } = evalResult;

      if (!videoData) {
        log(`No more video rows found at index ${rowIndex}. Finished scanning all ${processedCount} videos!`);
        break;
      }

      const videoKey = videoData.videoId || `${videoData.dateRaw}_${videoData.views}_${rowIndex}`;
      if (seenVideoKeys.has(videoKey)) {
        log(`Video [${videoKey}] already scanned. Moving to next index...`);
        rowIndex++;
        continue;
      }
      seenVideoKeys.add(videoKey);

      // Step 1: Hover over the row to trigger CSS :hover and reveal hidden action buttons
      const rowCenterResult = await page.evaluate(({ rowSel, idx }) => {
        const rows = Array.from(document.querySelectorAll(rowSel));
        if (idx >= rows.length) return null;
        const rect = rows[idx].getBoundingClientRect();
        return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
      }, { rowSel: ROW_SEL, idx: rowIndex });

      if (rowCenterResult) {
        await page.mouse.move(rowCenterResult.cx, rowCenterResult.cy);
        await page.waitForTimeout(400); // wait for :hover to reveal buttons
      }

      // Step 2: Re-fetch ChartRise button position (now visible after hover)
      const chartPos = await page.evaluate(({ rowSel, idx }) => {
        const rows = Array.from(document.querySelectorAll(rowSel));
        if (idx >= rows.length) return null;
        const row = rows[idx];
        // Find ChartRise icon
        const icon = row.querySelector('[data-icon="ChartRise"]');
        if (!icon) return null;
        // Walk up to clickable container
        let btn = icon;
        while (btn && btn !== row) {
          if (btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.getAttribute('role') === 'button') break;
          btn = btn.parentElement;
        }
        if (!btn || btn === row) btn = icon;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
      }, { rowSel: ROW_SEL, idx: rowIndex });

      if (!chartPos) {
        log(`Video row ${rowIndex}: ChartRise button not visible after hover, skipping`);
        rowIndex++;
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
        log(`Video row ${rowIndex}: analytics page not reached after click (url=${page.url()}), skipping`);
        rowIndex++;
        continue;
      }

      // Wait for analytics page content to fully render (works for both restricted and normal videos)
      try {
        await page.waitForSelector('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]', { timeout: 8000 });
      } catch {
        log(`Video row ${rowIndex}: analytics content not loaded yet, extracting anyway...`);
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

      log(`Analytics page: found ${analyticsData.elCount} view elements, values=[${analyticsData.allValues.join(',')}], views=${analyticsData.views}`);

      const date = analyticsData.date ?? parseContentDate(videoData.dateRaw);
      const views = analyticsData.views || videoData.views;


      processedCount++;
      log(`Video ${processedCount} (Row ${rowIndex}): date=${date} views=${views} restricted=${restricted}`);

      const result = {
        title: videoData.videoId ? `Video ${videoData.videoId}` : `Video ${processedCount}`,
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

      // Advance to next row index
      rowIndex++;
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
