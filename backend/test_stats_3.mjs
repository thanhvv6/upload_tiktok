// Quick test: run stats for first 5 videos only
// Usage: node test_stats_3.mjs <profile-name>
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const RESTRICTION_TEXT = 'Your video is not eligible for recommendation in the For You feed';
const ROW_SEL = '[data-tt="components_PostTable_Absolute"]';

const profileName = process.argv[2];
if (!profileName) { console.error('Usage: node test_stats_3.mjs <profile>'); process.exit(1); }

const MAX_VIDEOS = 5;
const userDataDir = path.join(PROFILES_DIR, profileName);
console.log('Profile:', profileName);

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
  viewport: { width: 1440, height: 900 },
});

const page = await browser.newPage();
console.log('Navigating...');
await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(4000);

const totalFromText = await page.evaluate(() => {
  const m = document.body.innerText.match(/Posts\s+([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, '')) : 0;
});
console.log(`Total: ${totalFromText}`);

await page.waitForFunction(
  (sel) => document.querySelectorAll(sel).length > 0, ROW_SEL, { timeout: 15000 }
);

const limit = Math.min(MAX_VIDEOS, totalFromText);
console.log(`Testing first ${limit} videos...\n`);

// Track absolute scroll position across iterations.
// Each row is height="100px", so advance by 100px per video.
let currentScrollTop = 0;

const results = [];

for (let i = 0; i < limit; i++) {
  console.log(`--- Video ${i + 1}/${limit} (scroll=${currentScrollTop}) ---`);

  // Ensure on content page
  const currentUrl = page.url();
  if (!currentUrl.includes('tiktokstudio/content') || currentUrl.includes('analytics')) {
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1000);
    } catch {}
    if (!page.url().includes('tiktokstudio/content') || page.url().includes('analytics')) {
      await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      currentScrollTop = 0;
    }
  }

  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length > 0, ROW_SEL, { timeout: 15000 }
  );

  // Get first VISIBLE row's data + ChartRise click position.
  // Sets container scroll to currentScrollTop, then finds the first row
  // whose top is at or below the container's top (first visible row, not first DOM row).
  const videoData = await page.evaluate(({ rowSel, scrollTop }) => {
    // Find main scrollable container
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

    // Find first row that is visible within the container (top >= container.top)
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
          date: dateEl?.textContent?.trim() ?? '',
          views: parseInt(viewsEl?.textContent?.replace(/,/g, '') ?? '0') || 0,
          videoId: linkEl?.getAttribute('href')?.match(/\/video\/(\d+)/)?.[1] ?? '',
          clickPos: { cx: chartRect.x + chartRect.width / 2, cy: chartRect.y + chartRect.height / 2 },
          rowTop: Math.round(rowRect.top),
          containerTop: Math.round(containerRect.top),
        };
      }
    }
    return null;
  }, { rowSel: ROW_SEL, scrollTop: currentScrollTop });

  if (!videoData) {
    console.log('  No visible row found, skipping');
    currentScrollTop += 100;
    continue;
  }

  console.log(`  row.top=${videoData.rowTop} container.top=${videoData.containerTop}`);
  console.log(`  date="${videoData.date}" views=${videoData.views} videoId=${videoData.videoId}`);
  console.log(`  ChartRise at (${videoData.clickPos.cx.toFixed(0)}, ${videoData.clickPos.cy.toFixed(0)})`);

  // Move mouse to trigger CSS hover, then click the analytics button
  await page.mouse.move(videoData.clickPos.cx, videoData.clickPos.cy - 50); // approach from above
  await page.waitForTimeout(150);
  await page.mouse.move(videoData.clickPos.cx, videoData.clickPos.cy);
  await page.waitForTimeout(200);
  await page.mouse.click(videoData.clickPos.cx, videoData.clickPos.cy);
  await page.waitForTimeout(3500);

  const afterUrl = page.url();
  console.log(`  Analytics URL: ${afterUrl}`);

  if (!afterUrl.includes('analytics')) {
    console.log('  Not on analytics page!');
    currentScrollTop += 100;
    continue;
  }

  // Check restriction via DOM selector (CSS-independent, most reliable)
  const restricted = await page.evaluate(() => {
    const banner = document.querySelector('[data-tt="components_AnalyticsPageBanner_TUXText"]');
    if (banner) return true;
    return (document.body.textContent || '').includes('not eligible for recommendation');
  });
  if (restricted) console.log('  [RESTRICTED] banner element found in DOM');

  // Get date from analytics page if content page date lacks year
  const bodyText = await page.evaluate(() => document.body.innerText);
  const analyticsDateMatch = bodyText.match(/Posted on (\d{1,2}\/\d{1,2}\/\d{4})/);
  const date = analyticsDateMatch ? analyticsDateMatch[1] : parseContentDate(videoData.date);

  console.log(`  date="${date}" restricted=${restricted}`);
  results.push({ i: i + 1, date, views: videoData.views, restricted, videoId: videoData.videoId });

  // SPA goBack — preserves inner div scroll position from before the click
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1000);
  } catch {
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    currentScrollTop = 0; // full reload resets scroll
  }

  // Advance to next video: +100px (one row height)
  currentScrollTop += 100;
}

console.log('\n=== RESULTS ===');
results.forEach(r => console.log(`  Video ${r.i}: date="${r.date}" views=${r.views} restricted=${r.restricted} id=${r.videoId}`));

function parseContentDate(text) {
  const withYear = text.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (withYear) {
    const m = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
    return `${m[withYear[1]]}/${withYear[2]}/${withYear[3]}`;
  }
  const withTime = text.match(/(\w{3})\s+(\d{1,2}),/);
  if (withTime) {
    const m = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
    return `${m[withTime[1]]}/${withTime[2]}/${new Date().getFullYear()}`;
  }
  return text;
}

console.log('\nDone. Browser stays open. Ctrl+C to close.');
await new Promise(() => {});
