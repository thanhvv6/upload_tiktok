// backend/stats-store.js
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const jobs = new Map();
const AUTO_CLEANUP_MS = 24 * 60 * 60 * 1000; // Keep jobs for 24 hours

export function createJob(profileIds) {
  const jobId = randomUUID();
  setTimeout(() => jobs.delete(jobId), AUTO_CLEANUP_MS);
  jobs.set(jobId, {
    status: 'running',
    profileIds: [...profileIds],
    results: new Map(),
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

export async function getExcelBuffer(jobId, profileNames) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job không tồn tại hoặc đã hết hạn.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TikTok Stats Tool';
  workbook.created = new Date();

  // Track sheet names to prevent duplicates crashing ExcelJS
  const usedSheetNames = new Set();

  // 1. Overall Summary Sheet
  const summarySheet = workbook.addWorksheet('Tong_Quan');
  usedSheetNames.add('Tong_Quan');
  summarySheet.columns = [
    { header: 'STT', key: 'stt', width: 6 },
    { header: 'Tên Profile', key: 'name', width: 30 },
    { header: 'Tổng Video', key: 'totalVideos', width: 14 },
    { header: 'Tổng Views', key: 'totalViews', width: 14 },
    { header: 'Video Bị Restricted', key: 'restrictedCount', width: 22 },
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

    // Sanitize sheet name: Excel allows max 31 chars and prohibits: \ / ? * [ ] :
    let safeName = rawName.replace(/[:\\/?*\[\]]/g, '_').substring(0, 25) || `Profile_${profileIndex}`;
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
    let profileRestrictedCount = 0;

    videos.forEach((v, i) => {
      const vViews = Number(v.views) || 0;
      profileTotalViews += vViews;
      if (v.restricted) profileRestrictedCount++;

      const row = sheet.addRow({
        stt: i + 1,
        date: v.date || '',
        views: vViews,
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
      restrictedCount: profileRestrictedCount,
    });

    if (profileRestrictedCount > 0) {
      const cell = summaryRow.getCell('restrictedCount');
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCC7' } };
      cell.font = { color: { argb: 'FFA8071A' }, bold: true };
    }
  }

  // If no profiles had data, at least one row in summary
  if (job.profileIds.length === 0) {
    summarySheet.addRow({
      stt: 1,
      name: 'Không có dữ liệu',
      totalVideos: 0,
      totalViews: 0,
      restrictedCount: 0,
    });
  }

  return await workbook.xlsx.writeBuffer();
}
