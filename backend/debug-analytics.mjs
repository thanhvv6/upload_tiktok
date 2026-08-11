// debug-analytics.mjs - Iterate all video rows, dump restriction banners on analytics page
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const DB_PATH = path.join(__dirname, '..', 'data', 'tiktok.db');
const PROFILE_NAME = '3l.luc.rebecca';
const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';
const ROW_SEL = '[data-tt="components_PostTable_Absolute"]';

async function injectProfileCookies(browser, profile) {
  if (!profile.cookies || !profile.cookies.trim()) return;
  try {
    let cookies;
    try { cookies = JSON.parse(profile.cookies); } catch {
      cookies = profile.cookies.split(';').map(part => {
        const eq = part.indexOf('=');
        if (eq === -1) return null;
        return { name: part.substring(0, eq).trim(), value: part.substring(eq + 1).trim(), domain: '.tiktok.com', path: '/' };
      }).filter(Boolean);
    }
    if (Array.isArray(cookies) && cookies.length > 0) {
      const cleaned = cookies.map(c => {
        const clean = { ...c };
        if (typeof clean.expires === 'number') clean.expires = Math.round(clean.expires);
        if (clean.sameSite && !['Lax', 'Strict', 'None'].includes(clean.sameSite)) delete clean.sameSite;
        return clean;
      });
      await browser.addCookies(cleaned);
      console.log(`Injected ${cleaned.length} cookies`);
    }
  } catch (e) { console.error('Cookie injection error:', e.message); }
}

async function ensureContentPage(page) {
  if (page.url().includes('tiktokstudio/content') && !page.url().includes('analytics')) return;
  try { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }); await page.waitForTimeout(1500); } catch {}
  if (!page.url().includes('tiktokstudio/content') || page.url().includes('analytics')) {
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
  }
}

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  let profile = db.prepare('SELECT * FROM profiles WHERE name LIKE ?').get(`%${PROFILE_NAME}%`);
  if (!profile) {
    profile = db.prepare('SELECT * FROM profiles ORDER BY created_at DESC LIMIT 1').get();
    console.log(`Profile "${PROFILE_NAME}" not found, using: ${profile?.name}`);
  } else {
    console.log(`Found profile: ${profile.name}`);
  }
  if (!profile) { console.error('No profiles!'); process.exit(1); }

  const userDataDir = path.join(PROFILES_DIR, profile.name);
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
    viewport: { width: 1440, height: 900 },
  });

  await injectProfileCookies(browser, profile);

  const page = browser.pages()[0] || await browser.newPage();
  try {
    await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch { console.log('goto timeout, continuing...'); }
  await page.waitForTimeout(6000);

  console.log('URL:', page.url());
  if (page.url().includes('login') || page.url().includes('passport') || page.url() === 'about:blank') {
    console.log('ERROR: Not on content page. URL:', page.url());
    await page.waitForTimeout(10000);
    await browser.close();
    return;
  }

  // Wait for rows to appear
  try {
    await page.waitForSelector(ROW_SEL, { timeout: 15000 });
  } catch { console.log('Row selector not found after 15s'); }

  const rowCount = await page.evaluate(sel => document.querySelectorAll(sel).length, ROW_SEL).catch(() => 0);
  console.log(`Total video rows: ${rowCount}`);

  for (let idx = 0; idx < rowCount; idx++) {
    await ensureContentPage(page);

    // Wait for rows
    try { await page.waitForFunction(({ s }) => document.querySelectorAll(s).length > 0, { s: ROW_SEL }, { timeout: 10000 }); } catch { break; }

    // Hover row
    const rowCenter = await page.evaluate(({ sel, i }) => {
      const row = document.querySelectorAll(sel)[i];
      if (!row) return null;
      row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const rect = row.getBoundingClientRect();
      return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
    }, { sel: ROW_SEL, i: idx });
    if (!rowCenter) { console.log(`Row ${idx}: not found`); continue; }

    await page.mouse.move(rowCenter.cx, rowCenter.cy);
    await page.waitForTimeout(600);

    // Get ChartRise
    const chartPos = await page.evaluate(({ sel, i }) => {
      const row = document.querySelectorAll(sel)[i];
      if (!row) return null;
      const icon = row.querySelector('[data-icon="ChartRise"]');
      if (!icon) return null;
      let btn = icon;
      while (btn && btn !== row) {
        if (btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.getAttribute('role') === 'button') break;
        btn = btn.parentElement;
      }
      if (!btn || btn === row) btn = icon;
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 ? { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 } : null;
    }, { sel: ROW_SEL, i: idx });
    if (!chartPos) { console.log(`Row ${idx}: ChartRise not found`); continue; }

    await page.mouse.move(chartPos.cx, chartPos.cy);
    await page.waitForTimeout(200);
    await page.mouse.click(chartPos.cx, chartPos.cy);

    try { await page.waitForURL('**/analytics**', { timeout: 10000 }); } catch { console.log(`Row ${idx}: analytics not reached`); continue; }

    // Wait for render
    try { await page.waitForSelector('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]', { timeout: 6000 }); } catch {}
    await page.waitForTimeout(500);

    const info = await page.evaluate(() => {
      // Views
      const viewEls = document.querySelectorAll('[data-tt="VideoOverviewPage_VideoInfoCard_TUXText"]');
      let views = 0;
      for (const el of viewEls) {
        const n = parseInt(el.textContent?.trim().replace(/,/g, ''));
        if (!isNaN(n) && n >= 0) { views = n; break; }
      }

      // ALL data-tt banners / restriction indicators
      const banners = [];
      document.querySelectorAll('[data-tt]').forEach(el => {
        const tt = el.getAttribute('data-tt') || '';
        const text = (el.textContent?.trim() || '').substring(0, 200);
        const keywords = ['banner', 'restrict', 'notice', 'warn', 'eligible', 'unavailable', 'limit', 'violat', 'community', 'guideline'];
        if (keywords.some(k => tt.toLowerCase().includes(k) || text.toLowerCase().includes(k)) && text.length > 0) {
          banners.push({ tt, text });
        }
      });

      // Body text
      const body = (document.body.innerText || '').substring(0, 600);

      return { views, banners, body };
    });

    console.log(`\n========= Row ${idx} | Views: ${info.views} =========`);
    console.log('Analytics URL:', page.url());
    if (info.banners.length > 0) {
      console.log('BANNERS/RESTRICTION elements:');
      info.banners.forEach(b => console.log(`  [${b.tt}]: "${b.text}"`));
    } else {
      console.log('No restriction banners found.');
    }
    console.log('Body (first 400 chars):', info.body.substring(0, 400));
  }

  console.log('\n=== Done scanning all rows ===');
  await page.waitForTimeout(3000);
  await browser.close();
})();
