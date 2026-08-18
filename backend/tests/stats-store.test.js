// Covers the downloaded workbook: the follow/like columns and the Tong_Quan
// links that jump to each profile's detail sheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createJob, appendResult, setProfileMeta, getExcelBuffer } from '../stats-store.js';

function makeJob(profiles) {
  const names = new Map();
  const ids = [];
  for (const p of profiles) {
    ids.push(p.id);
    names.set(p.id, p.name);
  }
  const jobId = createJob(ids);
  for (const p of profiles) {
    for (const v of p.videos || []) appendResult(jobId, p.id, v);
    if (p.meta) setProfileMeta(jobId, p.id, p.meta);
  }
  return { jobId, names };
}

async function workbookFor(profiles) {
  const { jobId, names } = makeJob(profiles);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await getExcelBuffer(jobId, names));
  return wb;
}

// Spreadsheet apps read the <hyperlink location="..."> tags straight out of the
// sheet XML, and ExcelJS' own reader drops links that carry no r:id — so assert
// on the file itself rather than on what ExcelJS can parse back.
async function summaryLinks(profiles) {
  const { jobId, names } = makeJob(profiles);
  const zip = await JSZip.loadAsync(await getExcelBuffer(jobId, names));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const sheetNames = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map(m => decode(m[1]));

  // Tong_Quan is the first worksheet added, so it is sheet1.xml
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const links = [...sheetXml.matchAll(/<hyperlink\b[^>]*\/>/g)].map(([tag]) => ({
    tag,
    ref: tag.match(/ref="([^"]*)"/)?.[1],
    location: decode(tag.match(/location="([^"]*)"/)?.[1] ?? ''),
    display: tag.match(/display="([^"]*)"/) ? decode(tag.match(/display="([^"]*)"/)[1]) : null,
    rId: tag.match(/r:id="([^"]+)"/)?.[1] ?? null,
  }));
  return { sheetNames, links };
}

const decode = (xml) => xml
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// an empty cell round-trips as '' or null depending on the reader
const assertBlank = (value, what) =>
  assert.ok(value === null || value === '' || value === undefined, `${what} should be blank, got ${JSON.stringify(value)}`);
// "'Sheet name'!A1" -> "Sheet name"
const linkedSheet = (location) => location?.match(/^'(.+)'!A1$/)?.[1] ?? null;

test('summary carries the like and follow columns', async () => {
  const wb = await workbookFor([{
    id: 'p1', name: 'alpha',
    videos: [
      { date: '08/01/2026', views: 1000, likes: 300, newFollowers: 10, restricted: false },
      { date: '08/02/2026', views: 500, likes: 40, newFollowers: 2, restricted: true },
    ],
    meta: { followers: 15300, hearts: 98000 },
  }]);

  const summary = wb.getWorksheet('Tong_Quan');
  assert.deepEqual(summary.getRow(1).values.filter(Boolean), [
    'STT', 'Tên Profile', 'Tổng Video', 'Tổng Views', 'Tổng Tim',
    'Follow mới (cộng dồn)', 'Follower hiện tại', 'Video Bị Restricted',
  ]);

  const row = summary.getRow(2);
  assert.equal(row.getCell(3).value, 2);      // videos
  assert.equal(row.getCell(4).value, 1500);   // views
  assert.equal(row.getCell(5).value, 340);    // likes summed
  assert.equal(row.getCell(6).value, 12);     // new followers summed
  assert.equal(row.getCell(7).value, 15300);  // account followers
  assert.equal(row.getCell(8).value, 1);      // restricted
});

test('detail sheet lists likes and new followers per video', async () => {
  const wb = await workbookFor([{
    id: 'p1', name: 'alpha',
    videos: [{ date: '08/01/2026', views: 1000, likes: 300, newFollowers: 10, restricted: false }],
  }]);

  const detail = wb.getWorksheet('alpha');
  assert.deepEqual(detail.getRow(1).values.filter(Boolean), [
    'STT', 'Ngày upload', 'Views', 'Tim', 'Follow mới', 'Trạng thái', 'Ghi chú',
  ]);
  assert.equal(detail.getRow(2).getCell(4).value, 300);
  assert.equal(detail.getRow(2).getCell(5).value, 10);
});

test('uncaptured metrics stay blank rather than reading as zero', async () => {
  const wb = await workbookFor([{
    id: 'p1', name: 'alpha',
    videos: [{ date: '08/01/2026', views: 1000, likes: null, newFollowers: null, restricted: false }],
  }]);

  const row = wb.getWorksheet('Tong_Quan').getRow(2);
  assertBlank(row.getCell(5).value, 'Tổng Tim');
  assertBlank(row.getCell(6).value, 'Follow mới');
  assertBlank(row.getCell(7).value, 'Follower hiện tại');
  assertBlank(wb.getWorksheet('alpha').getRow(2).getCell(4).value, 'Tim');
});

test('a genuine zero is still written as zero', async () => {
  const wb = await workbookFor([{
    id: 'p1', name: 'alpha',
    videos: [{ date: '08/01/2026', views: 1000, likes: 0, newFollowers: 0, restricted: false }],
  }]);
  assert.equal(wb.getWorksheet('Tong_Quan').getRow(2).getCell(5).value, 0);
  assert.equal(wb.getWorksheet('alpha').getRow(2).getCell(5).value, 0);
});

test('each summary row links to its own detail sheet', async () => {
  const profiles = [
    { id: 'p1', name: 'alpha', videos: [{ views: 10 }] },
    { id: 'p2', name: 'beta', videos: [{ views: 20 }] },
  ];
  const { links } = await summaryLinks(profiles);

  assert.deepEqual(links.map(l => [l.ref, l.location]), [
    ['B2', "'alpha'!A1"],
    ['B3', "'beta'!A1"],
  ]);

  const wb = await workbookFor(profiles);
  assert.equal(wb.getWorksheet('Tong_Quan').getRow(2).getCell(2).text, 'alpha');
});

test('links are plain internal links, with no external relationship', async () => {
  // An r:id here sends Excel to a "repair the workbook" prompt, and leaves
  // LibreOffice / Google Sheets / WPS following a dead external target.
  const { links } = await summaryLinks([{ id: 'p1', name: 'alpha', videos: [{ views: 1 }] }]);
  assert.equal(links.length, 1);
  assert.equal(links[0].rId, null, `hyperlink must carry no r:id: ${links[0].tag}`);
});

test('links survive names Excel forbids in a sheet title', async () => {
  // '!' matters too: it would stop ExcelJS treating the target as internal.
  const messy = "co'gai/mua*dong[2026]:ten!rat-dai-vuot-31-ky-tu";
  const profiles = [{ id: 'p1', name: messy, videos: [{ views: 1 }] }];
  const { sheetNames, links } = await summaryLinks(profiles);

  const sheetName = linkedSheet(links[0].location);
  assert.ok(sheetNames.includes(sheetName), `${links[0].location} must resolve to a real sheet`);

  const wb = await workbookFor(profiles);
  assert.equal(wb.getWorksheet('Tong_Quan').getRow(2).getCell(2).text, messy, 'full name stays visible');
});

test('duplicate profile names get distinct sheets and distinct links', async () => {
  const { sheetNames, links } = await summaryLinks([
    { id: 'p1', name: 'same', videos: [{ views: 1 }] },
    { id: 'p2', name: 'same', videos: [{ views: 2 }] },
  ]);

  assert.notEqual(links[0].location, links[1].location);
  for (const { location } of links) {
    assert.ok(sheetNames.includes(linkedSheet(location)), `${location} must resolve`);
  }
});

test('no relationship file declares an external hyperlink target', async () => {
  const { jobId, names } = makeJob([
    { id: 'p1', name: 'alpha', videos: [{ views: 1 }] },
    { id: 'p2', name: 'beta', videos: [{ views: 2 }] },
  ]);
  const zip = await JSZip.loadAsync(await getExcelBuffer(jobId, names));
  for (const path of Object.keys(zip.files).filter(f => f.endsWith('.rels'))) {
    const xml = await zip.file(path).async('string');
    assert.ok(!/\/hyperlink"/.test(xml), `${path} still declares a hyperlink relationship`);
  }
});

test('internal links carry a display label so the name survives the import', async () => {
  // Google Sheets builds the link cell from the <hyperlink> tag. With no
  // display=, it imports the link as HYPERLINK("#gid=123") with no label and
  // renders the raw target ("#gid=548982655") in place of the profile name.
  const { links } = await summaryLinks([
    { id: 'p1', name: 'alpha', videos: [{ views: 1 }] },
    { id: 'p2', name: 'beta', videos: [{ views: 2 }] },
  ]);
  assert.deepEqual(links.map(l => l.display), ['alpha', 'beta']);
});

test('display label keeps the full name, not the truncated sheet title', async () => {
  const messy = "co'gai/mua*dong[2026]:ten!rat-dai-vuot-31-ky-tu";
  const { links } = await summaryLinks([{ id: 'p1', name: messy, videos: [{ views: 1 }] }]);
  assert.equal(links[0].display, messy);
});

test('display label escapes characters that would break the attribute', async () => {
  const nasty = 'A & B "quoted" <tag>';
  const { links } = await summaryLinks([{ id: 'p1', name: nasty, videos: [{ views: 1 }] }]);
  assert.equal(links[0].display, nasty);
});
