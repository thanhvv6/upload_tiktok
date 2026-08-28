// backend/stats-store.js
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const jobs = new Map();
const AUTO_CLEANUP_MS = 24 * 60 * 60 * 1000; // Keep jobs for 24 hours

export function createJob(profileIds) {
  const jobId = randomUUID();
  // unref'd so the cleanup timer never keeps a short-lived process alive
  setTimeout(() => jobs.delete(jobId), AUTO_CLEANUP_MS).unref?.();
  jobs.set(jobId, {
    status: 'running',
    profileIds: [...profileIds],
    results: new Map(),
    profileMeta: new Map(), // profileId -> { followers }
    clients: new Set(),
    aborted: false,
    createdAt: Date.now(),
  });
  return jobId;
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function addClient(jobId, res) {
  jobs.get(jobId)?.clients.add(res);
}

export function removeClient(jobId, res) {
  jobs.get(jobId)?.clients.delete(res);
}

export function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of job.clients) {
    try { client.write(data); } catch (_) {}
  }
}

export function appendResult(jobId, profileId, video) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (!job.results.has(profileId)) job.results.set(profileId, []);
  job.results.get(profileId).push(video);
}

// Số liệu cấp tài khoản, quét một lần cho mỗi profile. Hiện chỉ còn follower:
// tổng tim trọn đời đã bỏ vì trang Studio analytics không cung cấp, và không
// nơi nào đọc tới nó.
export function setProfileMeta(jobId, profileId, meta) {
  const job = jobs.get(jobId);
  if (!job || !meta) return;
  const prev = job.profileMeta.get(profileId) || {};
  job.profileMeta.set(profileId, { ...prev, ...meta });
}

export function markProfileDone(jobId, profileId) {
  pushEvent(jobId, { type: 'done', profileId });
}

export function markAllDone(jobId) {
  const job = jobs.get(jobId);
  if (job) job.status = 'done';
  pushEvent(jobId, { type: 'all_done' });
}

export function markError(jobId, profileId, message) {
  pushEvent(jobId, { type: 'error', profileId, message });
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.aborted = true;
  job.status = 'cancelled';
}

export function isAborted(jobId) {
  return jobs.get(jobId)?.aborted ?? true;
}

// A link to another sheet inside the same workbook, in the form ExcelJS
// recognises as internal (see fixInternalHyperlinks for the cleanup it needs).
function internalLinkTarget(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'!A1`;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(raw) {
  return String(raw).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity];
    return entity[1] === 'x' || entity[1] === 'X'
      ? String.fromCodePoint(parseInt(entity.slice(2), 16))
      : String.fromCodePoint(Number(entity.slice(1)));
  });
}

function escapeXmlAttr(raw) {
  return String(raw)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Two things ExcelJS gets wrong about internal links, both fixed on the raw XML
// because its writer offers no hook for either.
//
// 1. It emits the link as `location` on the <hyperlink> tag *and* as a
//    relationship with TargetMode="External" whose target is a sheet reference
//    rather than a URL. Excel then offers to repair the workbook, and readers
//    that resolve r:id before location (LibreOffice, Google Sheets, WPS) end up
//    with a dead link. Dropping those relationships leaves a plain internal
//    hyperlink, which every spreadsheet app follows.
//
// 2. It never writes the optional `display` attribute that Excel itself always
//    puts on an internal link. Google Sheets builds the imported link cell from
//    that attribute alone: with no label it converts the cell to a one-argument
//    HYPERLINK("#gid=<sheet>") and renders the raw target — so the profile name
//    turned into "#gid=548982655" even though the jump itself worked.
//
// `labels` maps a link target ("'Sheet name'!A1") to the text its cell shows.
async function fixInternalHyperlinks(buffer, labels = new Map()) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetPaths = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));

  for (const sheetPath of sheetPaths) {
    const xml = await zip.file(sheetPath).async('string');
    const strippedIds = [];

    const patched = xml.replace(/<hyperlink\b[^>]*\/>/g, (tag) => {
      if (!tag.includes('location=')) return tag;
      let out = tag;

      const rId = out.match(/r:id="([^"]+)"/)?.[1];
      if (rId) {
        strippedIds.push(rId);
        out = out.replace(/\s*r:id="[^"]+"/, '');
      }

      if (!/\sdisplay="/.test(out)) {
        const target = decodeXmlText(out.match(/location="([^"]*)"/)?.[1] ?? '');
        const label = labels.get(target);
        if (label != null) out = out.replace(/\s*\/>$/, ` display="${escapeXmlAttr(label)}"/>`);
      }
      return out;
    });

    if (patched === xml) continue;
    zip.file(sheetPath, patched);
    if (!strippedIds.length) continue;

    const relsPath = sheetPath.replace(/worksheets\/(sheet\d+)\.xml$/, 'worksheets/_rels/$1.xml.rels');
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;

    const rels = await relsFile.async('string');
    const cleaned = rels.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
      const id = tag.match(/Id="([^"]+)"/)?.[1];
      return id && strippedIds.includes(id) && tag.includes('/hyperlink') ? '' : tag;
    });
    zip.file(relsPath, cleaned);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function getExcelBuffer(jobId, profileNames) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job không tồn tại hoặc đã hết hạn.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TikTok Stats Tool';
  workbook.created = new Date();

  // Track sheet names to prevent duplicates crashing ExcelJS
  const usedSheetNames = new Set();
  // Link target -> the text its cell shows, for the `display` attribute below
  const linkLabels = new Map();

  // 1. Overall Summary Sheet
  const summarySheet = workbook.addWorksheet('Tong_Quan');
  usedSheetNames.add('Tong_Quan');
  summarySheet.columns = [
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Tên Profile', key: 'name', width: 30 },
    { header: 'Tổng Video', key: 'totalVideos', width: 12 },
    { header: 'Tổng Views', key: 'totalViews', width: 14 },
    { header: 'Tổng Tim', key: 'totalLikes', width: 13 },
    // Gross: tổng follow các video mang về, không trừ unfollow — nên cột này
    // có thể lớn hơn 'Follower hiện tại', vốn là con số net tại lúc quét.
    { header: 'Follow mới (cộng dồn)', key: 'newFollowers', width: 20 },
    { header: 'Follower hiện tại', key: 'followers', width: 17 },
    { header: 'Video Bị Restricted', key: 'restrictedCount', width: 20 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF0F0F0' },
  };

  let profileIndex = 1;

  for (const profileId of job.profileIds) {
    const rawName = (profileNames?.get(profileId) || profileId || `Profile_${profileIndex}`).toString().trim();
    const videos = job.results.get(profileId) || [];
    const meta = job.profileMeta.get(profileId) || {};

    // Sanitize sheet name: Excel allows max 31 chars and prohibits: \ / ? * [ ] :
    // Apostrophes are stripped too so the HYPERLINK() target stays quotable.
    let safeName = rawName.replace(/[:\\/?*\[\]'!]/g, '_').substring(0, 25) || `Profile_${profileIndex}`;
    let uniqueSheetName = safeName;
    let dupCounter = 1;
    while (usedSheetNames.has(uniqueSheetName)) {
      uniqueSheetName = `${safeName.substring(0, 20)}_${dupCounter++}`;
    }
    usedSheetNames.add(uniqueSheetName);

    const sheet = workbook.addWorksheet(uniqueSheetName);

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 6 },
      { header: 'Ngày upload', key: 'date', width: 16 },
      { header: 'Views', key: 'views', width: 12 },
      { header: 'Tim', key: 'likes', width: 12 },
      { header: 'Follow mới', key: 'newFollowers', width: 13 },
      { header: 'Trạng thái', key: 'restricted', width: 18 },
      { header: 'Ghi chú', key: 'note', width: 28 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE6F7FF' },
    };

    let profileTotalViews = 0;
    let profileTotalLikes = 0;
    let profileNewFollowers = 0;
    let profileRestrictedCount = 0;
    let anyLikes = false;
    let anyNewFollowers = false;

    videos.forEach((v, i) => {
      const vViews = Number(v.views) || 0;
      profileTotalViews += vViews;
      if (v.restricted) profileRestrictedCount++;

      const vLikes = v.likes == null ? null : (Number(v.likes) || 0);
      if (vLikes != null) { profileTotalLikes += vLikes; anyLikes = true; }

      const vFollows = v.newFollowers == null ? null : (Number(v.newFollowers) || 0);
      if (vFollows != null) { profileNewFollowers += vFollows; anyNewFollowers = true; }

      const row = sheet.addRow({
        stt: i + 1,
        date: v.date || '',
        views: vViews,
        likes: vLikes == null ? '' : vLikes,
        newFollowers: vFollows == null ? '' : vFollows,
        restricted: v.restricted ? 'BỊ CHẶN (RED)' : 'Bình thường',
        note: v.restricted ? 'Không được đề xuất vào For You' : '',
      });

      if (v.restricted) {
        const cell = row.getCell('restricted');
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF4D4F' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      }
    });

    // Add row to summary sheet
    const summaryRow = summarySheet.addRow({
      stt: profileIndex++,
      name: rawName,
      totalVideos: videos.length,
      totalViews: profileTotalViews,
      totalLikes: anyLikes ? profileTotalLikes : '',
      newFollowers: anyNewFollowers ? profileNewFollowers : '',
      followers: meta.followers == null ? '' : meta.followers,
      restrictedCount: profileRestrictedCount,
    });

    let linkColor = 'FF1677FF';

    if (profileTotalViews === 0) {
      summaryRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCC7' } };
        cell.font = { color: { argb: 'FFA8071A' }, bold: true };
      });
      linkColor = 'FFA8071A';
    } else if (profileRestrictedCount > 0) {
      const cell = summaryRow.getCell('restrictedCount');
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCC7' } };
      cell.font = { color: { argb: 'FFA8071A' }, bold: true };
    }

    // Clicking the profile name jumps to that profile's detail sheet.
    const nameCell = summaryRow.getCell('name');
    const linkTarget = internalLinkTarget(uniqueSheetName);
    linkLabels.set(linkTarget, rawName);
    nameCell.value = { text: rawName, hyperlink: linkTarget };
    nameCell.font = { color: { argb: linkColor }, underline: true, bold: linkColor !== 'FF1677FF' };
  }

  // If no profiles had data, at least one row in summary
  if (job.profileIds.length === 0) {
    summarySheet.addRow({
      stt: 1,
      name: 'Không có dữ liệu',
      totalVideos: 0,
      totalViews: 0,
      totalLikes: 0,
      newFollowers: 0,
      followers: '',
      restrictedCount: 0,
    });
  }

  return await fixInternalHyperlinks(await workbook.xlsx.writeBuffer(), linkLabels);
}
