// frontend/src/components/StatsModal.jsx
import React, { useEffect, useRef, useState } from 'react';
import {
  X, Download, StopCircle, BarChart2,
  CheckCircle2, AlertCircle, Loader2, FileSpreadsheet,
  Video, Hash, Flag, Heart
} from 'lucide-react';

export default function StatsModal({ isOpen, profileIds, onClose }) {
  const [jobId, setJobId]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [progress, setProgress] = useState({});  // profileId -> { done, total, name }
  const [isDone, setIsDone]     = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError]       = useState(null);
  const esRef   = useRef(null);
  const logsEnd = useRef(null);

  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (!isOpen) return;
    setLogs([]);
    setProgress({});
    setIsDone(false);
    setJobId(null);
    setError(null);

    let cancelled = false;
    (async () => {
      setIsStarting(true);
      try {
        const res = await fetch('/api/stats/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileIds }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to start job');
        if (cancelled) return;
        setJobId(data.jobId);
        openStream(data.jobId);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setIsStarting(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => () => esRef.current?.close(), []);

  function openStream(jid) {
    const es = new EventSource(`/api/stats/stream/${jid}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'progress') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: { done: ev.done, total: ev.total, name: ev.profileName },
        }));
      } else if (ev.type === 'account') {
        setProgress(prev => ({
          ...prev,
          [ev.profileId]: {
            ...(prev[ev.profileId] || { done: 0, total: 0, name: ev.profileName }),
            followers: ev.followers,
          },
        }));
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
  const totalLikes = logs.reduce((sum, l) => sum + (l.isError ? 0 : (l.likes || 0)), 0);
  const totalVideos = profileList.reduce((sum, [, p]) => sum + (p.total || 0), 0);
  const doneVideos = profileList.reduce((sum, [, p]) => sum + (p.done || 0), 0);
  const allProfilesDone = profileList.length > 0 && profileList.every(([, p]) => p.done >= p.total && p.total > 0);

  const getStatus = (p) => {
    if (p.total > 0 && p.done >= p.total) return 'done';
    if (p.total === 0 && isDone) return 'done';
    if (p.done > 0 || p.total > 0) return 'running';
    return 'running';
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
            Thống kê video TikTok
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

          {/* Starting state */}
          {isStarting && profileList.length === 0 && (
            <div className="stats-empty-state">
              <Loader2 size={28} className="stats-spinner" color="var(--primary)" />
              <span>Đang khởi động trình thống kê...</span>
            </div>
          )}

          {/* Summary cards — stays fixed above scroll area */}
          {(logCount > 0 || totalVideos > 0) && (
            <div className="stats-summary">
              <div className="stats-summary-card">
                <div className="stats-summary-value">{logCount || doneVideos}</div>
                <div className="stats-summary-label">
                  <Video size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  Video đã quét
                </div>
              </div>
              <div className="stats-summary-card">
                <div className="stats-summary-value">{totalLikes.toLocaleString()}</div>
                <div className="stats-summary-label">
                  <Heart size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                  Tổng tim
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                    <span className="stats-progress-count">
                      {p.done}{p.total > 0 && ` / ${p.total} video`}
                    </span>
                    {p.total > 0 && (
                      <span className="stats-progress-count">{pct}%</span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Log panel */}
            {logs.length > 0 && (
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

            {/* Empty log — waiting */}
            {logs.length === 0 && !isStarting && profileList.length > 0 && (
              <div className="stats-empty-state" style={{ padding: '20px' }}>
                <Loader2 size={22} className="stats-spinner" color="var(--primary)" />
                <span style={{ fontSize: '0.82rem' }}>Đang thu thập dữ liệu video...</span>
              </div>
            )}

            {/* Done banner */}
            {(isDone || allProfilesDone) && logCount > 0 && (
              <div className="stats-done-banner">
                <CheckCircle2 size={18} />
                Hoàn thành! {logCount} video đã được thống kê từ {profileList.length} profile.
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>
            <StopCircle size={14} />
            {isDone ? 'Đóng' : 'Hủy'}
          </button>
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
        </div>
      </div>
    </div>
  );
}
