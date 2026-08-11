// frontend/src/components/StatsModal.jsx
import React, { useEffect, useRef, useState } from 'react';
import { X, Download, StopCircle, BarChart2 } from 'lucide-react';

export default function StatsModal({ isOpen, profileIds, onClose }) {
  const [jobId, setJobId]       = useState(null);
  const [logs, setLogs]         = useState([]);
  const [progress, setProgress] = useState({});  // profileId -> { done, total, name }
  const [isDone, setIsDone]     = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError]       = useState(null);
  const esRef   = useRef(null);
  const logsEnd = useRef(null);

  // Auto-scroll log
  useEffect(() => {
    logsEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Start job when modal opens
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

  // Close EventSource on unmount
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
      setError('Mất kết nối SSE');
      es.close();
    };
  }

  const handleClose = async () => {
    esRef.current?.close();
    if (jobId && !isDone) {
      await fetch(`/api/stats/cancel/${jobId}`, { method: 'DELETE' }).catch(() => {});
    }
    onClose();
  };

  const handleDownload = () => {
    const date = new Date().toISOString().split('T')[0];
    const a = document.createElement('a');
    a.href = `/api/stats/download/${jobId}`;
    a.download = `tiktok_stats_${date}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!isOpen) return null;

  const profileList = Object.entries(progress);
  const logCount = logs.filter(l => !l.isError).length;

  return (
    <div className="modal-backdrop" onClick={handleClose}>
      <div
        className="glass modal-card"
        style={{ maxWidth: '640px', width: '100%' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '1.1rem' }}>
            <BarChart2 size={20} />
            Thống kê video TikTok
          </h2>
          <button className="modal-close" onClick={handleClose}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '0 0 8px' }}>
          {isStarting && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Đang khởi động job...</p>
          )}
          {error && (
            <p style={{ color: 'var(--danger, #ef4444)', fontSize: '0.9rem' }}>Lỗi: {error}</p>
          )}

          {/* Progress bars per profile */}
          {profileList.map(([pid, p]) => (
            <div key={pid} style={{ marginBottom: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '3px' }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span style={{ color: 'var(--text-muted)' }}>{p.done} / {p.total} video</span>
              </div>
              <div style={{ background: 'var(--surface-1)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                <div style={{
                  background: 'var(--primary, #6366f1)',
                  height: '100%',
                  width: p.total > 0 ? `${Math.round((p.done / p.total) * 100)}%` : '0%',
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          ))}

          {/* Log panel */}
          <div style={{
            marginTop: '10px',
            maxHeight: '260px',
            overflowY: 'auto',
            background: 'var(--input-bg)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '10px',
            fontSize: '0.78rem',
            fontFamily: 'monospace',
            color: 'var(--text)',
          }}>
            {logs.length === 0 && !isStarting && (
              <p style={{ color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>
                Đang chờ dữ liệu...
              </p>
            )}
            {logs.map((log, i) => (
              <div
                key={i}
                style={{
                  padding: '2px 0',
                  borderBottom: '1px solid var(--border, #ddd)',
                  color: log.isError
                    ? 'var(--danger, #ef4444)'
                    : log.restricted
                      ? '#ef4444'
                      : 'var(--text)',
                }}
              >
                {log.isError
                  ? `[ERROR] ${log.message}`
                  : `${log.date} | ${log.views} views${log.restricted ? ' | 🚫 RESTRICTED' : ''}`
                }
              </div>
            ))}
            <div ref={logsEnd} />
          </div>

          {isDone && (
            <p style={{
              marginTop: '12px',
              color: 'var(--success, #22c55e)',
              fontWeight: 600,
              textAlign: 'center',
              fontSize: '0.9rem',
            }}>
              Hoàn thành! {logCount} video đã thống kê.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={handleClose}>
            <StopCircle size={14} />
            {isDone ? 'Đóng' : 'Hủy'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleDownload}
            disabled={!isDone || !jobId}
          >
            <Download size={14} />
            Download Excel
          </button>
        </div>
      </div>
    </div>
  );
}
