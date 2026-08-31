// frontend/src/components/StatsModal.jsx
import React, { useEffect, useRef, useState } from 'react';
import {
  X, StopCircle, BarChart2,
  CheckCircle2, AlertCircle, Loader2, FileSpreadsheet,
  Video, Hash, Flag, Play, Image as ImageIcon, CalendarDays
} from 'lucide-react';

export default function StatsModal({ isOpen, profileIds, onClose }) {
  const [jobId, setJobId]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [progress, setProgress] = useState({});  // profileId -> { done, total, name }
  const [isDone, setIsDone]     = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError]       = useState(null);
  // Chọn nội dung quét trước khi chạy. Hai cờ này cố tình không reset khi
  // đóng/mở modal: chạy nhiều lượt liên tiếp thường là cùng một lựa chọn.
  const [scanStats, setScanStats]   = useState(true);
  const [scanAvatar, setScanAvatar] = useState(true);
  const [scanDayCount, setScanDayCount] = useState(true);
  // Ngày mặc định là hôm nay, theo giờ máy. Không dùng toISOString() vì nó trả
  // về ngày UTC — sau 7h tối giờ VN sẽ nhảy sang ngày mai.
  const [countDate, setCountDate] = useState(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [hasStarted, setHasStarted] = useState(false);
  const esRef   = useRef(null);
  const logsEnd = useRef(null);

  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Mở modal chỉ dựng lại màn chọn; lượt quét bắt đầu khi người dùng bấm nút,
  // không tự chạy ngay như trước.
  useEffect(() => {
    if (!isOpen) return;
    setLogs([]);
    setProgress({});
    setIsDone(false);
    setJobId(null);
    setError(null);
    setHasStarted(false);
    setIsStarting(false);
  }, [isOpen]);

  useEffect(() => () => esRef.current?.close(), []);

  const startScan = async () => {
    if (isStarting || (!scanStats && !scanAvatar && !scanDayCount)) return;
    setIsStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/stats/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds, scanStats, scanAvatar, scanDayCount, countDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start job');
      setHasStarted(true);
      setJobId(data.jobId);
      openStream(data.jobId);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsStarting(false);
    }
  };

  function openStream(jid) {
    const es = new EventSource(`/api/stats/stream/${jid}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'progress') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: { ...(prev[ev.profileId] || {}), done: ev.done, total: ev.total, name: ev.profileName },
        }));
      } else if (ev.type === 'account') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: {
            ...(prev[ev.profileId] || { done: 0, total: 0, name: ev.profileName }),
            followers: ev.followers,
          },
        }));
      } else if (ev.type === 'avatar') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: {
            ...(prev[ev.profileId] || { done: 0, total: 0 }),
            name: ev.profileName,
            avatarOk: ev.ok,
          },
        }));
      } else if (ev.type === 'day_count') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: {
            ...(prev[ev.profileId] || { done: 0, total: 0 }),
            name: ev.profileName,
            dayCount: ev.count,
          },
        }));
      } else if (ev.type === 'done') {
        // Quét avatar không sinh event progress nào, nên không đọc 'done' thì
        // card đứng mãi ở "Đang quét..." tới khi cả job kết thúc.
        setProgress(prev => (
          prev[ev.profileId]
            ? { ...prev, [ev.profileId]: { ...prev[ev.profileId], finished: true } }
            : prev
        ));
      } else if (ev.type === 'video') {
        setLogs(prev => [...prev, { ...ev, isError: false }]);
      } else if (ev.type === 'error') {
        setLogs(prev => [...prev, { isError: true, message: ev.message, profileId: ev.profileId }]);
      } else if (ev.type === 'all_done') {
        setIsDone(true);
        es.close();
      }
    };

    es.onerror = () => {
      es.close();
      const poll = setInterval(async () => {
        try {
          const r = await fetch(`/api/stats/status/${jid}`);
          if (!r.ok) { clearInterval(poll); setIsDone(true); return; }
          const data = await r.json();
          if (data.status === 'done' || data.status === 'cancelled') {
            clearInterval(poll);
            setIsDone(true);
          }
        } catch { clearInterval(poll); }
      }, 3000);
    };
  }

  const handleClose = async () => {
    esRef.current?.close();
    if (jobId && !isDone) {
      await fetch(`/api/stats/cancel/${jobId}`, { method: 'DELETE' }).catch(() => {});
    }
    onClose();
  };

  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownload = async () => {
    if (!jobId || isDownloading) return;
    try {
      setIsDownloading(true);
      setError(null);
      const res = await fetch(`/api/stats/download/${jobId}`);
      if (!res.ok) {
        let errMsg = 'Không thể tải file Excel';
        try {
          const errData = await res.json();
          if (errData?.error) errMsg = errData.error;
        } catch (_) {}
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      const a = document.createElement('a');
      a.href = url;
      a.download = `tiktok_stats_${date}.xlsx`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }, 1000);
    } catch (err) {
      setError(err.message || 'Lỗi khi tải file Excel');
    } finally {
      setIsDownloading(false);
    }
  };

  if (!isOpen) return null;

  const profileList = Object.entries(progress);
  const logCount = logs.filter(l => !l.isError).length;
  const restrictedCount = logs.filter(l => !l.isError && l.restricted).length;
  const totalVideos = profileList.reduce((sum, [, p]) => sum + (p.total || 0), 0);
  const doneVideos = profileList.reduce((sum, [, p]) => sum + (p.done || 0), 0);
  const allProfilesDone = profileList.length > 0 && profileList.every(([, p]) => p.done >= p.total && p.total > 0);
  const avatarOkCount = profileList.filter(([, p]) => p.avatarOk).length;
  const dayCountTotal = profileList.reduce((sum, [, p]) => sum + (p.dayCount || 0), 0);
  // Lượt quét nhẹ (không thống kê video) không có con số nào của bảng log để
  // tổng kết, nên tự dựng câu tóm tắt từ những phần thực sự đã chạy.
  const lightSummary = [
    scanAvatar ? `avatar ${avatarOkCount}/${profileList.length}` : null,
    scanDayCount ? `${dayCountTotal} video ngày ${countDate}` : null,
  ].filter(Boolean).join(' · ');

  const getStatus = (p) => {
    if (p.finished) return 'done';
    if (p.total > 0 && p.done >= p.total) return 'done';
    if (p.total === 0 && isDone) return 'done';
    if (p.done > 0 || p.total > 0) return 'running';
    return 'running';
  };

  const optionRow = (checked) => ({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '12px 14px',
    borderRadius: '10px',
    cursor: 'pointer',
    background: checked ? 'rgba(255, 63, 182, 0.07)' : 'rgba(255, 255, 255, 0.02)',
    border: `1px solid ${checked ? 'rgba(255, 63, 182, 0.35)' : 'var(--border)'}`
  });

  const optionCheckbox = {
    width: '17px',
    height: '17px',
    marginTop: '2px',
    accentColor: 'var(--primary)',
    cursor: 'pointer',
    flexShrink: 0
  };

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div
        className="glass modal-card"
        style={{ maxWidth: '680px', width: '100%' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="modal-header">
          <h2>
            <BarChart2 size={20} color="var(--primary)" />
            Quét kênh TikTok
          </h2>
          <button className="modal-close" onClick={handleClose}>
            <X size={16} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="modal-body" style={{ overflow: 'visible' }}>
          {/* Error banner */}
          {error && (
            <div className="stats-error-banner">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Màn chọn — hiện trước khi chạy */}
          {!hasStarted && !isStarting && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {profileIds.length} profile được chọn. Chọn nội dung cần quét:
              </div>

              <label style={optionRow(scanStats)}>
                <input
                  type="checkbox"
                  checked={scanStats}
                  onChange={e => setScanStats(e.target.checked)}
                  style={optionCheckbox}
                />
                <div>
                  <div style={{ fontWeight: '700', fontSize: '0.86rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <BarChart2 size={14} color="var(--primary)" />
                    Quét thống kê
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5 }}>
                    Duyệt từng video để lấy lượt xem, tim, follow mới, kèm số follower của kênh. Xuất được file Excel. Chạy lâu.
                  </div>
                </div>
              </label>

              <label style={optionRow(scanAvatar)}>
                <input
                  type="checkbox"
                  checked={scanAvatar}
                  onChange={e => setScanAvatar(e.target.checked)}
                  style={optionCheckbox}
                />
                <div>
                  <div style={{ fontWeight: '700', fontSize: '0.86rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ImageIcon size={14} color="var(--accent)" />
                    Quét avatar
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5 }}>
                    Lưu avatar hiện tại của kênh để hiện trên card profile. Chỉ mất vài giây mỗi profile.
                  </div>
                </div>
              </label>

              {/* Ô ngày phải nằm NGOÀI <label>, nếu không mỗi lần bấm vào lịch
                  sẽ tắt/bật luôn checkbox. */}
              <div style={{ ...optionRow(scanDayCount), alignItems: 'center', cursor: 'default' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flex: 1, minWidth: 0, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={scanDayCount}
                    onChange={e => setScanDayCount(e.target.checked)}
                    style={optionCheckbox}
                  />
                  <div>
                    <div style={{ fontWeight: '700', fontSize: '0.86rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CalendarDays size={14} color="#F59E0B" />
                      Đếm video đã up trong ngày
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5 }}>
                      Số video mang mốc ngày đã chọn, tính cả video còn chờ tới giờ đăng. Chỉ tốn một lượt gọi API.
                    </div>
                  </div>
                </label>
                <input
                  type="date"
                  className="input"
                  value={countDate}
                  disabled={!scanDayCount}
                  onChange={e => setCountDate(e.target.value)}
                  style={{
                    width: '146px',
                    flexShrink: 0,
                    padding: '6px 8px',
                    fontSize: '0.78rem',
                    colorScheme: 'dark',
                    opacity: scanDayCount ? 1 : 0.4,
                    cursor: scanDayCount ? 'pointer' : 'not-allowed'
                  }}
                />
              </div>

              {!scanStats && !scanAvatar && !scanDayCount && (
                <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>
                  Phải chọn ít nhất một loại quét.
                </div>
              )}
            </div>
          )}

          {/* Starting state */}
          {isStarting && (
            <div className="stats-empty-state">
              <Loader2 size={28} className="stats-spinner" color="var(--primary)" />
              <span>Đang khởi động trình quét...</span>
            </div>
          )}

          {/* Summary cards — stays fixed above scroll area */}
          {hasStarted && scanStats && (logCount > 0 || totalVideos > 0) && (
            <div className="stats-summary">
              <div className="stats-summary-card">
                <div className="stats-summary-value">{logCount || doneVideos}</div>
                <div className="stats-summary-label">
                  <Video size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  Video đã quét
                </div>
              </div>
              <div className="stats-summary-card">
                <div className="stats-summary-value">{restrictedCount}</div>
                <div className="stats-summary-label">
                  <Flag size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  Bị hạn chế
                </div>
              </div>
              <div className="stats-summary-card">
                <div className="stats-summary-value">{profileList.length}</div>
                <div className="stats-summary-label">
                  <Hash size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  Profile
                </div>
              </div>
            </div>
          )}

          {/* Scrollable area: profile cards + logs */}
          {hasStarted && (
            <div className="modal-scroll" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              {/* Per-profile progress cards */}
              {profileList.map(([pid, p]) => {
                const status = getStatus(p);
                const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                return (
                  <div key={pid} className={`stats-profile-card ${status}`}>
                    <div className="stats-profile-header">
                      <span className="stats-profile-name">
                        {status === 'done'
                          ? <CheckCircle2 size={15} color="var(--success)" />
                          : <Loader2 size={15} className="stats-spinner" color="var(--primary)" />
                        }
                        {p.name}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {p.avatarOk != null && (
                          <span
                            className="stats-profile-followers"
                            style={{ color: p.avatarOk ? 'var(--success)' : 'var(--error)' }}
                          >
                            <ImageIcon size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                            {p.avatarOk ? 'avatar ok' : 'avatar lỗi'}
                          </span>
                        )}
                        {p.dayCount != null && (
                          <span className="stats-profile-followers" style={{ color: '#F59E0B' }}>
                            <CalendarDays size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                            {p.dayCount} video
                          </span>
                        )}
                        {p.followers != null && (
                          <span className="stats-profile-followers">
                            {p.followers.toLocaleString()} follower
                          </span>
                        )}
                        <span className={`stats-profile-status ${status}`}>
                          {status === 'done' ? 'Hoàn thành' : 'Đang quét...'}
                        </span>
                      </span>
                    </div>
                    <div className="stats-progress-bar">
                      <div
                        className="stats-progress-fill"
                        style={{ width: `${p.total > 0 ? pct : (status === 'done' ? 100 : 0)}%` }}
                      />
                    </div>
                    {scanStats && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                        <span className="stats-progress-count">
                          {p.done}{p.total > 0 && ` / ${p.total} video`}
                        </span>
                        {p.total > 0 && (
                          <span className="stats-progress-count">{pct}%</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Log panel */}
              {scanStats && logs.length > 0 && (
                <div className="stats-log-panel">
                  {/* Header row */}
                  <div className="stats-log-row" style={{ background: 'rgba(255,255,255,0.03)', fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                    <span style={{ minWidth: 90 }}>Ngày đăng</span>
                    <span style={{ textAlign: 'right' }}>Lượt xem</span>
                    <span style={{ textAlign: 'right' }}>Tim</span>
                    <span style={{ textAlign: 'right' }}>Follow mới</span>
                    <span style={{ textAlign: 'center' }}>Trạng thái</span>
                  </div>
                  {logs.map((log, i) => (
                    <div key={i} className="stats-log-row">
                      <span className="stats-log-date">{log.date || '—'}</span>
                      <span className="stats-log-views">{log.views?.toLocaleString() || 0}</span>
                      <span className="stats-log-metric">
                        {log.likes != null ? log.likes.toLocaleString() : '—'}
                      </span>
                      <span className="stats-log-metric">
                        {log.newFollowers != null ? log.newFollowers.toLocaleString() : '—'}
                      </span>
                      {log.isError ? (
                        <span className="stats-log-badge restricted">Lỗi</span>
                      ) : log.restricted ? (
                        <span className="stats-log-badge restricted">Hạn chế</span>
                      ) : (
                        <span className="stats-log-badge ok">OK</span>
                      )}
                    </div>
                  ))}
                  <div ref={logsEnd} />
                </div>
              )}

              {/* Chỉ quét avatar: bảng thống kê không còn nghĩa gì, nhưng lỗi
                  của từng profile thì vẫn phải nói ra. */}
              {!scanStats && logs.some(l => l.isError) && (
                <div className="stats-log-panel">
                  {logs.filter(l => l.isError).map((log, i) => (
                    <div key={i} className="stats-log-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <AlertCircle size={13} color="var(--error)" style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: '0.75rem' }}>{log.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Empty log — waiting */}
              {scanStats && logs.length === 0 && !isStarting && profileList.length > 0 && (
                <div className="stats-empty-state" style={{ padding: '20px' }}>
                  <Loader2 size={22} className="stats-spinner" color="var(--primary)" />
                  <span style={{ fontSize: '0.82rem' }}>Đang thu thập dữ liệu video...</span>
                </div>
              )}

              {/* Done banner */}
              {(isDone || allProfilesDone) && (scanStats ? logCount > 0 : isDone) && (
                <div className="stats-done-banner">
                  <CheckCircle2 size={18} />
                  {scanStats
                    ? `Hoàn thành! ${logCount} video đã được thống kê từ ${profileList.length} profile.`
                    : `Hoàn thành ${profileList.length} profile — ${lightSummary}.`}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>
            <StopCircle size={14} />
            {(!hasStarted || isDone) ? 'Đóng' : 'Hủy'}
          </button>
          {!hasStarted ? (
            <button
              className="btn btn-primary"
              onClick={startScan}
              disabled={isStarting || (!scanStats && !scanAvatar && !scanDayCount)}
              style={{ gap: 8 }}
            >
              {isStarting ? <Loader2 size={14} className="stats-spinner" /> : <Play size={14} />}
              Bắt đầu quét
            </button>
          ) : scanStats ? (
            <button
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={!isDone || !jobId || isDownloading}
              style={{ gap: 8 }}
            >
              {isDownloading ? (
                <Loader2 size={14} className="stats-spinner" />
              ) : (
                <FileSpreadsheet size={14} />
              )}
              {isDownloading ? 'Đang tải...' : 'Tải Excel'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
