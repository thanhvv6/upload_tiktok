// backend/stats-store.js
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

const jobs = new Map();
const AUTO_CLEANUP_MS = 30 * 60 * 1000;

export function createJob(profileIds) {
  const jobId = randomUUID();
  setTimeout(() => jobs.delete(jobId), AUTO_CLEANUP_MS);
  jobs.set(jobId, {
    status: 'running',
    profileIds: [...profileIds],
    results: new Map(),
    clients: new Set(),
    aborted: false,
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
  if (!job) throw new Error('Job not found');

  const workbook = new ExcelJS.Workbook();

  for (const [profileId, videos] of job.results) {
    const rawName = profileNames.get(profileId) || profileId;
    const sheetName = rawName.substring(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    sheet.columns = [
      { header: 'STT',        key: 'stt',        width: 6  },
      { header: 'Ngày upload', key: 'date',       width: 16 },
      { header: 'Views',       key: 'views',      width: 12 },
      { header: 'Restricted',  key: 'restricted', width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    videos.forEach((v, i) => {
      const row = sheet.addRow({
        stt: i + 1,
        date: v.date,
        views: v.views,
        restricted: v.restricted ? 'RED' : '',
      });
      if (v.restricted) {
        const cell = row.getCell('restricted');
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
        cell.font  = { color: { argb: 'FFFFFFFF' }, bold: true };
      }
    });
  }

  return workbook.xlsx.writeBuffer();
}
