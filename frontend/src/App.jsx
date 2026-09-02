import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import {
  Plus,
  Play,
  Trash2,
  Settings,
  Globe,
  Video,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Layout,
  Clock,
  ShieldCheck,
  Zap,
  FolderOpen,
  FolderArchive,
  Download,
  Link,
  ExternalLink,
  Edit3,
  Check,
  X,
  Users,
  Music,
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  StopCircle,
  Upload,
  LogIn,
  Image,
  Camera,
  BarChart2
} from 'lucide-react';

import { motion, AnimatePresence } from 'framer-motion';
import StatsModal from './components/StatsModal';
const ProfileCard = React.memo(React.forwardRef(({
  profile,
  isSelected,
  onToggleSelected,
  onDelete,
  onOpen,
  onStart,
  onEngage,
  onStopEngage,
  isEngaging,
  onLoginTikTok,
  onStopLoginTikTok,
  isLoggingIn,
  onChangeAvatar,
  isChangingAvatar,
  onAddFavoriteMusic,
  isAddingFavoriteMusic,
  getStatusColor,
  editingId,
  setEditingId,
  editingValue,
  setEditingValue,
  onUpdateName,
  onEdit,
  onOpenFolder,
  groups
}, ref) => {
  // Ảnh hỏng (file bị xoá tay, quét lỗi) thì rơi về icon mặc định. Reset theo
  // channel_avatar_at để lượt quét sau còn có cơ hội hiện ảnh mới.
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => { setAvatarFailed(false); }, [profile.channel_avatar_at]);
  const showAvatar = !!profile.channel_avatar && !avatarFailed;

  // Trạng thái thật của card. Các việc như engage hay login không ghi vào
  // profiles.status mà chỉ sống trong state của trang, nên phải gộp lại ở đây;
  // nếu không, card đang engage sẽ mang vạch đèn màu "nghỉ".
  const effectiveStatus = isEngaging ? 'engaging'
    : isLoggingIn ? 'logging_in'
    : isChangingAvatar ? 'changing_avatar'
    : isAddingFavoriteMusic ? 'adding_favorite_music'
    : (profile.status || 'idle');
  const isRunning = ['uploading', 'engaging', 'logging_in', 'changing_avatar', 'adding_favorite_music']
    .includes(effectiveStatus);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`glass card s-${effectiveStatus}${isRunning ? ' is-running' : ''}`}
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <div>
        {/* Row 1: controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleSelected(profile.id)}
                style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
              />
            </label>
            <div style={{
              background: 'rgba(56, 189, 248, 0.1)',
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0
            }}>
              {showAvatar ? (
                <img
                  src={`/api/profiles/${profile.id}/avatar?v=${encodeURIComponent(profile.channel_avatar_at || '')}`}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                  title={profile.channel_avatar_at ? `Avatar quét lúc ${new Date(profile.channel_avatar_at).toLocaleString('vi-VN')}` : undefined}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <Globe size={20} color="var(--accent)" />
              )}
            </div>
          </div>

          <button
            onClick={() => onEdit(profile.id)}
            title="Edit settings"
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '5px 10px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              fontSize: '0.72rem',
              fontWeight: '600'
            }}
          >
            <Settings size={13} /> Edit
          </button>
        </div>

        {/* Row 2: name + meta */}
        <div style={{ marginTop: '12px' }}>
          {editingId === profile.id ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                autoFocus
                className="input"
                style={{ fontSize: '0.9rem', padding: '4px 8px', width: '140px' }}
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onUpdateName(profile.id, editingValue);
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
              <button onClick={() => onUpdateName(profile.id, editingValue)} style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: '4px' }}><Check size={15} /></button>
              <button onClick={() => setEditingId(null)} style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', padding: '4px' }}><X size={15} /></button>
            </div>
          ) : (
            <h3 style={{ fontSize: '1rem', fontWeight: '700', wordBreak: 'break-word' }}>
              {profile.name}
            </h3>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', minWidth: 0 }}>
              <Clock size={11} style={{ flexShrink: 0 }} />
              <span>{profile.last_run ? new Date(profile.last_run).toLocaleDateString() : 'Never run'}</span>
              <div style={{
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                backgroundColor: getStatusColor(profile.status),
                marginLeft: '4px',
                flexShrink: 0
              }} />
              {/* Mốc hẹn giờ của video cuối cùng trong lượt chạy gần nhất. */}
              {(() => {
                if (!profile.last_scheduled_at) return null;
                const when = new Date(profile.last_scheduled_at);
                if (Number.isNaN(when.getTime())) return null;
                const passed = when.getTime() < Date.now();
                return (
                  <span
                    title={`Video cuối của lượt chạy gần nhất được hẹn đăng lúc ${when.toLocaleString('vi-VN')}`}
                    style={{ color: passed ? 'var(--error)' : '#F59E0B', fontWeight: '700', marginLeft: '2px' }}
                  >
                    {'\u2192'} {when.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                    {' '}
                    {when.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}
                  </span>
                );
              })()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
              <button onClick={() => { setEditingId(profile.id); setEditingValue(profile.name); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', opacity: 0.5, padding: '2px' }}><Edit3 size={13} /></button>
              <button onClick={() => onDelete(profile.id)} style={{ background: 'none', border: 'none', color: 'rgba(239, 68, 68, 0.4)', cursor: 'pointer', padding: '2px' }}><Trash2 size={13} /></button>
            </div>
          </div>

          {/* Group */}
          <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {profile.group_id
                ? (() => { const g = groups.find(gr => gr.id === profile.group_id); return g ? g.name : '—'; })()
                : 'No group'}
            </span>
              {(() => {
                const status = profile.folder_status || 'not_set';
                const count = profile.video_count || 0;
                const clickable = status === 'ok';
                const config = status === 'not_set'
                  ? { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.12)', text: 'Chưa set folder' }
                  : status === 'missing'
                    ? { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.12)', text: 'Folder không tồn tại' }
                    : count > 0
                      ? { color: 'var(--success)', bg: 'rgba(34, 197, 94, 0.12)', text: `${count} videos` }
                      : { color: 'var(--text-muted)', bg: 'rgba(148, 163, 184, 0.12)', text: '0 videos' };
                return (
                  <div
                    onClick={clickable ? () => onOpenFolder(profile) : undefined}
                    title={clickable ? 'Mở folder' : undefined}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '3px 8px',
                      borderRadius: '999px',
                      fontSize: '0.65rem',
                      fontWeight: '600',
                      color: config.color,
                      background: config.bg,
                      cursor: clickable ? 'pointer' : 'default',
                      userSelect: 'none'
                    }}
                  >
                    <FolderOpen size={11} />
                    {config.text}
                  </div>
                );
              })()}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border)' }}>
        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: getStatusColor(profile.status)
          }} />
          <span className="micro" style={{ color: getStatusColor(profile.status) }}>
            {profile.status}
          </span>
        </div>

        {/* Row 1: Open + Start */}
        <div style={{ display: 'flex', gap: '6px', minWidth: 0 }}>
          <button
            className="btn btn-ghost"
            onClick={() => onOpen(profile.id)}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600' }}
          >
            <ExternalLink size={13} />
            OPEN
          </button>

          <button
            className={`btn ${profile.status === 'uploading' ? 'btn-tinted' : 'btn-ghost'}`}
            onClick={() => onStart(profile.id)}
            disabled={profile.status === 'uploading' || isEngaging}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600', '--tint': profile.status === 'uploading' ? 'var(--sky)' : 'var(--pink)' }}
          >
            {profile.status === 'uploading' ? (
              <RefreshCw size={13} className="animate-pulse" />
            ) : (
              <Play size={13} fill="white" />
            )}
            {profile.status === 'uploading' ? 'ACTIVE' : 'START'}
          </button>
        </div>

        {/* Row 2: Engage | Login */}
        <div style={{ display: 'flex', gap: '6px', minWidth: 0 }}>
          <button
            className={`btn ${isEngaging ? 'btn-tinted' : 'btn-ghost'}`}
            onClick={() => isEngaging ? onStopEngage(profile.id) : onEngage(profile.id)}
            disabled={profile.status === 'uploading'}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600', '--tint': isEngaging ? 'var(--red)' : 'var(--indigo)' }}
          >
            <Heart size={13} />
            ENGAGE
          </button>

          <button
            className={`btn ${isLoggingIn ? 'btn-tinted' : 'btn-ghost'}`}
            onClick={() => isLoggingIn ? onStopLoginTikTok(profile.id) : onLoginTikTok(profile.id)}
            disabled={profile.status === 'uploading' || (!profile.email && !profile.pass)}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600', '--tint': isLoggingIn ? 'var(--red)' : 'var(--green)' }}
          >
            <LogIn size={14} />
            LOGIN
          </button>
        </div>

        {/* Row 3: Avatar | Favorites */}
        <div style={{ display: 'flex', gap: '6px', minWidth: 0 }}>
          <button
            className={`btn ${isChangingAvatar ? 'btn-tinted' : 'btn-ghost'}`}
            onClick={() => onChangeAvatar(profile.id)}
            disabled={profile.status === 'uploading' || isChangingAvatar}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600', '--tint': 'var(--sky)' }}
          >
            <Camera size={13} />
            AVATAR
          </button>

          <button
            className={`btn ${isAddingFavoriteMusic ? 'btn-tinted' : 'btn-ghost'}`}
            onClick={() => onAddFavoriteMusic(profile.id)}
            disabled={profile.status === 'uploading' || isAddingFavoriteMusic}
            style={{ display: 'flex', flex: 1, minWidth: 0, padding: '7px 8px', borderRadius: '8px', gap: '4px', justifyContent: 'center', fontSize: '0.78rem', fontWeight: '600', '--tint': 'var(--amber)' }}
          >
            <Music size={13} />
            FAVORITES
          </button>
        </div>

      </div>
    </motion.div>
  );
}));
ProfileCard.displayName = 'ProfileCard';

const App = () => {
  const [profiles, setProfiles] = useState([]);
  const [config, setConfig] = useState({ videoFolder: '', maxConcurrency: 2, statsLimitDate: null, postDelayEnabled: 0, postDelayMinutes: 60 });
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileGroupId, setNewProfileGroupId] = useState('');
  const [newProfileVideoFolder, setNewProfileVideoFolder] = useState('');
  const [newProfileChannelIds, setNewProfileChannelIds] = useState('');
  const [newProfileNeedsRender, setNewProfileNeedsRender] = useState(true);
  const [newProfileRenderConcatVideo, setNewProfileRenderConcatVideo] = useState(false);
  const [newProfileRemoveTitle, setNewProfileRemoveTitle] = useState(true);
  const [newProfileNeedContentCheck, setNewProfileNeedContentCheck] = useState(true);
  const [newProfileRenderVideoLong, setNewProfileRenderVideoLong] = useState(false);
  const [isCreateProfileModalOpen, setIsCreateProfileModalOpen] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('profiles');
  const processingRef = useRef(new Set());
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [groups, setGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupValue, setEditingGroupValue] = useState('');
  const [selectedForRun, setSelectedForRun] = useState(() => new Set());
  const [bulkRunMode, setBulkRunMode] = useState('parallel');
  const [engagingProfiles, setEngagingProfiles] = useState(() => new Set());
  const [loggingInProfiles, setLoggingInProfiles] = useState(() => new Set());
  const [changingAvatarProfiles, setChangingAvatarProfiles] = useState(() => new Set());
  const [addingFavoriteMusicProfiles, setAddingFavoriteMusicProfiles] = useState(() => new Set());
  const [avatarSelections, setAvatarSelections] = useState({}); // profileId -> filePath
  const [musicSearchTerms, setMusicSearchTerms] = useState({}); // profileId -> searchTerm
  const [limitUploads, setLimitUploads] = useState(false);
  const [uploadLimitCount, setUploadLimitCount] = useState(1);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportFolderModalOpen, setIsImportFolderModalOpen] = useState(false);
  const [isExportFolderModalOpen, setIsExportFolderModalOpen] = useState(false);
  const [importCsvText, setImportCsvText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importResults, setImportResults] = useState(null);
  const [isImporting, setIsImporting] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [importFolderPath, setImportFolderPath] = useState('');
  const [exportFolderPath, setExportFolderPath] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResults, setExportResults] = useState(null);
  const [editingProfileId, setEditingProfileId] = useState(null);
  const [isStatsModalOpen, setIsStatsModalOpen] = useState(false);
  const [statsProfileIds, setStatsProfileIds] = useState([]);


  const filteredProfiles = useMemo(() => {
    if (groupFilter === 'all') return profiles;
    if (groupFilter === 'ungrouped') {
      return profiles.filter((p) => !p.group_id);
    }
    return profiles.filter((p) => p.group_id === groupFilter);
  }, [profiles, groupFilter]);

  useEffect(() => {
    fetchData();
    fetchConfig();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const validIds = new Set(profiles.map((p) => p.id));
    setSelectedForRun((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [profiles]);

  // Config is deliberately NOT part of the 5s poll below. Overwriting it on a
  // timer wipes edits the user has not saved yet -- picking a date takes longer
  // than one poll interval, so the pick was always reverted before Save. Server
  // side config only changes when this app writes it, so mount + after-save is
  // enough.
  const fetchConfig = async () => {
    try {
      const res = await axios.get('/api/config');
      setConfig(res.data || { videoFolder: '', maxConcurrency: 2, postDelayEnabled: 0, postDelayMinutes: 60 });
    } catch (err) {
      console.error('Fetch config error:', err);
    }
  };

  const fetchData = async () => {
    try {
      const [pRes, gRes] = await Promise.all([
        axios.get('/api/profiles'),
        axios.get('/api/groups')
      ]);

      const newProfiles = pRes.data || [];
      setProfiles(prev => {
        // Don't overwrite profiles that are currently being updated
        return newProfiles.map(np => {
          if (processingRef.current.has(np.id)) {
            const current = prev.find(p => p.id === np.id);
            return current || np;
          }
          return np;
        });
      });

      setGroups(gRes.data || []);

      // Sync engaging status from profile status field
      setEngagingProfiles(prev => {
        const next = new Set(prev);
        newProfiles.forEach(p => {
          if (p.status === 'engaging') next.add(p.id);
          else next.delete(p.id);
        });
        return next;
      });

      // Sync login status from profile status field
      setLoggingInProfiles(prev => {
        const next = new Set(prev);
        newProfiles.forEach(p => {
          if (p.status === 'logging_in') next.add(p.id);
          else next.delete(p.id);
        });
        return next;
      });

      // Sync changing avatar status from profile status field
      setChangingAvatarProfiles(prev => {
        const next = new Set(prev);
        newProfiles.forEach(p => {
          if (p.status === 'changing_avatar') next.add(p.id);
          else next.delete(p.id);
        });
        return next;
      });

      // Sync adding favorite music status from profile status field
      setAddingFavoriteMusicProfiles(prev => {
        const next = new Set(prev);
        newProfiles.forEach(p => {
          if (p.status === 'adding_favorite_music') next.add(p.id);
          else next.delete(p.id);
        });
        return next;
      });
    } catch (err) {
      console.error('Fetch error:', err);
    }
  };

  const addGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await axios.post('/api/groups', { name });
      setNewGroupName('');
      await fetchData();
      setMessage({ type: 'success', text: 'Group created successfully' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to create group' });
    }
  };

  const updateGroupName = async (id, newName) => {
    if (!newName.trim()) {
      setEditingGroupId(null);
      return;
    }
    try {
      await axios.patch(`/api/groups/${id}`, { name: newName.trim() });
      setEditingGroupId(null);
      await fetchData();
      setMessage({ type: 'success', text: 'Group renamed successfully' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to rename group' });
      setEditingGroupId(null);
    }
  };

  const deleteGroup = async (id) => {
    if (!window.confirm('Delete this group? It must have no profiles assigned.')) return;
    try {
      await axios.delete(`/api/groups/${id}`);
      if (groupFilter === id) setGroupFilter('all');
      await fetchData();
      setMessage({ type: 'success', text: 'Group deleted' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to delete group' });
    }
  };

  const updateProfileGroup = async (profileId, groupId) => {
    try {
      await axios.patch(`/api/profiles/${profileId}`, { group_id: groupId });
      await fetchData();
      setMessage({ type: 'success', text: 'Profile group updated' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to update profile group' });
    }
  };

  const resetCreateProfileForm = () => {
    setNewProfileName('');
    setNewProfileGroupId('');
    setNewProfileVideoFolder('');
    setNewProfileChannelIds('');
    setNewProfileNeedsRender(true);
    setNewProfileRenderConcatVideo(false);
    setNewProfileRemoveTitle(true);
    setNewProfileNeedContentCheck(true);
    setNewProfileRenderVideoLong(false);
  };

  const closeCreateProfileModal = ({ force } = {}) => {
    if ((isCreatingProfile || isSelectingFolder) && !force) return;
    setIsCreateProfileModalOpen(false);
    resetCreateProfileForm();
  };

  const addProfile = async () => {
    if (isCreatingProfile) return;
    const name = newProfileName.trim();
    if (!name) return;

    setIsCreatingProfile(true);
    try {
      await axios.post('/api/profiles', {
        name,
        group_id: newProfileGroupId || null,
        video_folder: newProfileVideoFolder.trim() || null,
        channel_ids: newProfileChannelIds.trim() || null,
        needs_render: newProfileNeedsRender,
        render_concat_video: newProfileRenderConcatVideo,
        remove_title: newProfileRemoveTitle,
        need_content_check: newProfileNeedContentCheck,
        render_video_long: newProfileRenderVideoLong,
        set_music: true
      });
      closeCreateProfileModal({ force: true });
      await fetchData();
      setMessage({ type: 'success', text: 'Profile added successfully' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to add profile' });
    } finally {
      setIsCreatingProfile(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setImportCsvText(ev.target.result);
    };
    reader.readAsText(file);
  };

  const handleImportCsv = async () => {
    if (!importCsvText.trim()) {
      setMessage({ type: 'error', text: 'Vui lòng chọn file CSV trước' });
      return;
    }
    setIsImporting(true);
    setImportResults(null);
    try {
      const res = await axios.post('/api/profiles/import-csv', { csvText: importCsvText });
      setImportResults(res.data);
      await fetchData();
      setMessage({
        type: 'success',
        text: `Import xong: ${res.data.imported} profiles đã tạo, ${res.data.skipped} bỏ qua`
      });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Lỗi import CSV' });
      setImportResults(null);
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportFolder = async () => {
    if (!importFolderPath.trim()) {
      setMessage({ type: 'error', text: 'Vui lòng nhập đường dẫn thư mục' });
      return;
    }
    setIsImporting(true);
    setImportResults(null);
    try {
      const res = await axios.post('/api/profiles/import-folder', { folderPath: importFolderPath });
      setImportResults(res.data);
      await fetchData();
      setMessage({
        type: 'success',
        text: `Import xong: ${res.data.imported} profiles đã tạo, ${res.data.skipped} bỏ qua`
      });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Lỗi import thư mục' });
      setImportResults(null);
    } finally {
      setIsImporting(false);
    }
  };

  const closeImportModal = () => {
    if (isImporting) return;
    setIsImportModalOpen(false);
    setImportCsvText('');
    setImportFileName('');
    setImportResults(null);
  };

  const closeImportFolderModal = () => {
    if (isImporting) return;
    setIsImportFolderModalOpen(false);
    setImportFolderPath('');
    setImportResults(null);
  };

  const handleExportFolder = async (downloadZip = false) => {
    if (selectedForRun.size === 0) {
      setMessage({ type: 'error', text: 'Vui lòng chọn ít nhất 1 profile để export' });
      return;
    }
    setIsExporting(true);
    setExportResults(null);
    try {
      const res = await axios.post('/api/profiles/export-folder', {
        profileIds: Array.from(selectedForRun),
        exportPath: exportFolderPath,
        downloadZip
      });
      setExportResults(res.data);
      if (downloadZip && res.data.downloadUrl) {
        const link = document.createElement('a');
        link.href = res.data.downloadUrl;
        link.setAttribute('download', '');
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      setMessage({
        type: 'success',
        text: `Export thành công ${res.data.total} profiles (${res.data.exportedCookies} có cookie)`
      });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Lỗi export thư mục' });
      setExportResults(null);
    } finally {
      setIsExporting(false);
    }
  };

  const closeExportFolderModal = () => {
    if (isExporting) return;
    setIsExportFolderModalOpen(false);
    setExportFolderPath('');
    setExportResults(null);
  };

  const deleteProfile = async (id) => {
    if (!window.confirm('Are you sure you want to delete this profile?')) return;
    try {
      await axios.delete(`/api/profiles/${id}`);
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const deleteSelectedProfiles = async () => {
    if (selectedForRun.size === 0) return;
    if (!window.confirm(`Bạn có chắc muốn xóa ${selectedForRun.size} profile đã chọn? Việc này cũng sẽ xóa các folder liên quan.`)) return;
    try {
      await axios.post('/api/profiles/delete-multiple', { profileIds: Array.from(selectedForRun) });
      setSelectedForRun(new Set());
      fetchData();
    } catch (err) {
      console.error(err);
      alert('Có lỗi khi xóa profile');
    }
  };

  // Giờ dự kiến của video đầu khi bật hẹn giờ. Chỉ là ước lượng cho người dùng
  // nhìn: backend còn làm tròn lên theo khoảng cách lịch của từng profile.
  const postDelayPreview = () => {
    const minutes = Number(config.postDelayMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return new Date(Date.now() + minutes * 60 * 1000).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  };

  // "90" đọc là "1 giờ 30 phút" cho dễ hình dung, nhưng dưới 60 thì giữ nguyên
  // phút thay vì hiện "0 giờ 15 phút".
  const formatPostDelay = (value) => {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) return '0 phút';
    if (minutes < 60) return `${minutes} phút`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} giờ` : `${hours} giờ ${rest} phút`;
  };

  const updateConfig = async () => {
    try {
      await axios.post('/api/config', config);
      await fetchConfig();
      setMessage({ type: 'success', text: 'Settings updated' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      console.error(err);
    }
  };

  const startAutomation = async (profileId = null) => {
    setIsLoading(true);
    try {
      if (profileId) {
        await axios.post('/api/start', { 
          profileId,
          limitUploads,
          uploadLimitCount
        });
        setMessage({
          type: 'success',
          text: 'Automation started for profile'
        });
      } else {
        const profileIds = [...selectedForRun];
        if (profileIds.length === 0) {
          setMessage({ type: 'error', text: 'Chọn ít nhất một profile (checkbox) để chạy hàng loạt.' });
          setIsLoading(false);
          return;
        }
        await axios.post('/api/start', { 
          profileIds, 
          runMode: bulkRunMode,
          limitUploads,
          uploadLimitCount
        });
        setMessage({
          type: 'success',
          text:
            bulkRunMode === 'sequential'
              ? `Đã bật chạy tuần tự cho ${profileIds.length} profile (theo thứ tự đã chọn)`
              : `Đã bật chạy cùng lúc cho ${profileIds.length} profile đã chọn`
        });
      }
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to start' });
    }
    setIsLoading(false);
  };

  const toggleProfileSelectedForRun = (id) => {
    setSelectedForRun((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allFilteredSelected =
    filteredProfiles.length > 0 && filteredProfiles.every((p) => selectedForRun.has(p.id));

  const toggleSelectAllFiltered = () => {
    setSelectedForRun((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredProfiles.forEach((p) => next.delete(p.id));
      } else {
        filteredProfiles.forEach((p) => next.add(p.id));
      }
      return next;
    });
  };

  const openProfile = async (profileId) => {
    try {
      await axios.post('/api/open-profile', { profileId });
      setMessage({ type: 'success', text: 'Browser opened for profile' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to open browser' });
    }
  };

  const openProfileFolder = async (profile) => {
    try {
      await axios.post(`/api/profiles/${profile.id}/open-folder`);
      setMessage({ type: 'success', text: 'Đã mở folder upload' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      const code = err.response?.data?.error;
      const text = code === 'not_set'
        ? 'Profile chưa set folder upload'
        : code === 'missing'
          ? 'Folder upload không tồn tại'
          : err.response?.data?.error || 'Không thể mở folder';
      setMessage({ type: 'error', text });
    }
  };

  const startEngage = async (profileId) => {
    try {
      await axios.post('/api/engage', { profileId });
      setEngagingProfiles(prev => new Set([...prev, profileId]));
      setMessage({ type: 'success', text: 'Auto Engage started! ♥️ TikTok sẽ tự động xem video.' });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to start engage' });
    }
  };

  const stopEngage = async (profileId) => {
    try {
      await axios.post('/api/engage/stop', { profileId });
      setEngagingProfiles(prev => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
      setMessage({ type: 'success', text: 'Auto Engage dừng. Browser sẽ đóng sau vài giây.' });
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to stop engage' });
    }
  };

  const startLoginTikTok = async (profileId) => {
    try {
      await axios.post('/api/login-tiktok', { profileId });
      setLoggingInProfiles(prev => new Set([...prev, profileId]));
      setMessage({ type: 'success', text: 'Login TikTok started! Browser will open shortly.' });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to start login' });
    }
  };

  const stopLoginTikTok = async (profileId) => {
    try {
      await axios.post('/api/login-tiktok/stop', { profileId });
      setLoggingInProfiles(prev => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
      setMessage({ type: 'success', text: 'Login session stopping...' });
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to stop login' });
    }
  };

  const startBulkLogin = async () => {
    const profileIds = [...selectedForRun];
    if (profileIds.length === 0) {
      setMessage({ type: 'error', text: 'Chọn ít nhất một profile để Login.' });
      return;
    }
    const missing = profileIds.filter(id => {
      const p = profiles.find(pr => pr.id === id);
      return !p || (!p.cookies && (!p.email || !p.pass));
    });
    if (missing.length > 0) {
      setMessage({ type: 'error', text: `${missing.length} profile thiếu cookies hoặc email/password (cần Import CSV trước).` });
      return;
    }
    setMessage({ type: 'success', text: `Bắt đầu Login cho ${profileIds.length} profile...` });
    for (const pid of profileIds) {
      if (loggingInProfiles.has(pid)) continue;
      try {
        await axios.post('/api/login-tiktok', { profileId: pid });
        setLoggingInProfiles(prev => new Set([...prev, pid]));
      } catch (err) {
        setMessage({ type: 'error', text: `Lỗi login profile ${pid}: ${err.response?.data?.error || err.message}` });
      }
    }
    setTimeout(() => setMessage(null), 6000);
  };

  const clearTrash = async () => {
    const profileIds = [...selectedForRun];
    if (profileIds.length === 0) {
      setMessage({ type: 'error', text: 'Chọn ít nhất một profile để Clear Trash.' });
      return;
    }
    setMessage({ type: 'info', text: `Đang dọn rác cho ${profileIds.length} profile...` });
    try {
      const res = await axios.post('/api/profiles/clear-trash', { profileIds });
      const { totalFreedMB } = res.data;
      if (totalFreedMB > 0) {
        setMessage({ type: 'success', text: `Đã giải phóng ${totalFreedMB} MB từ ${profileIds.length} profile.` });
      } else {
        setMessage({ type: 'info', text: 'Không có file rác nào cần dọn.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Lỗi khi dọn rác' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const openStatsModal = () => {
    if (selectedForRun.size === 0) {
      setMessage({ type: 'error', text: 'Chọn ít nhất một profile để thống kê.' });
      setTimeout(() => setMessage(null), 3000);
      return;
    }
    setStatsProfileIds([...selectedForRun]);
    setIsStatsModalOpen(true);
  };

  const clearDebugFiles = async () => {
    if (!window.confirm('Xóa toàn bộ file debug PNG và dọn automation.log?\nHành động này không ảnh hưởng đến profile hay cookie.')) return;
    setMessage({ type: 'info', text: 'Đang xóa file debug...' });
    try {
      const res = await axios.post('/api/system/clear-debug');
      const { freedMB, deletedFiles } = res.data;
      setMessage({ type: 'success', text: `Đã xóa ${deletedFiles} file debug PNG + dọn log → giải phóng ${freedMB} MB` });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Lỗi khi xóa debug' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const startBulkEngage = async () => {
    const profileIds = [...selectedForRun];
    if (profileIds.length === 0) {
      setMessage({ type: 'error', text: 'Chọn ít nhất một profile (checkbox) để Engage hàng loạt.' });
      return;
    }

    let successCount = 0;
    let failCount = 0;
    const errors = [];

    await Promise.all(
      profileIds.map(async (profileId) => {
        // Bỏ qua các profile đã đang engage hoặc đang upload
        if (engagingProfiles.has(profileId)) return;
        try {
          await axios.post('/api/engage', { profileId });
          setEngagingProfiles(prev => new Set([...prev, profileId]));
          successCount++;
        } catch (err) {
          failCount++;
          errors.push(err.response?.data?.error || `Profile ${profileId} failed`);
        }
      })
    );

    if (successCount > 0) {
      setMessage({
        type: 'success',
        text: `♥️ Đã bật Auto Engage cho ${successCount} profile${failCount > 0 ? ` (${failCount} thất bại)` : ''}`
      });
    } else {
      setMessage({ type: 'error', text: errors[0] || 'Không có profile nào được bật Engage' });
    }
    setTimeout(() => setMessage(null), 5000);
  };

  const stopBulkEngage = async () => {
    const engagingSelected = [...selectedForRun].filter(id => engagingProfiles.has(id));
    if (engagingSelected.length === 0) {
      setMessage({ type: 'error', text: 'Không có profile nào đang engage trong danh sách đã chọn.' });
      return;
    }
    await Promise.all(engagingSelected.map(id => stopEngage(id)));
  };


  const updateProfileFolder = async (id, folder) => {
    try {
      await axios.patch(`/api/profiles/${id}`, { video_folder: folder });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const updateProfileProxy = async (id, proxy) => {
    try {
      await axios.patch(`/api/profiles/${id}`, { proxy });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const updateProfileChannelIds = async (id, channelIds) => {
    try {
      await axios.patch(`/api/profiles/${id}`, { channel_ids: channelIds });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const updateProfileName = async (id, newName) => {
    if (!newName.trim()) {
      setEditingId(null);
      return;
    }
    try {
      await axios.patch(`/api/profiles/${id}`, { name: newName });
      setEditingId(null);
      fetchData();
      setMessage({ type: 'success', text: 'Profile renamed successfully' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to rename profile' });
      setEditingId(null);
    }
  };

  const updateProfileSchedule = async (id, is_scheduled) => {
    // Prevent multiple concurrent updates
    if (processingRef.current.has(id)) return;

    // Optimistic update
    setProfiles(prev => prev.map(p => p.id === id ? { ...p, is_scheduled: is_scheduled ? 1 : 0 } : p));
    processingRef.current.add(id);

    try {
      await axios.patch(`/api/profiles/${id}`, { is_scheduled });
      // Small delay to ensure DB is written and GET will find it
      await new Promise(resolve => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileSchedules = async (id, timesStr) => {
    // timesStr is comma-separated e.g. "08:00, 18:00"
    const times = timesStr.split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));

    try {
      await axios.post(`/api/profiles/${id}/schedules`, { times });
      await fetchData();
      setMessage({ type: 'success', text: 'Schedule times updated' });
      setTimeout(() => setMessage(null), 3000);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to update schedule times' });
    }
  };

  const updateProfileSetMusic = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, set_music: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { set_music: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileNeedsRender = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, needs_render: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { needs_render: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileRenderConcatVideo = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, render_concat_video: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { render_concat_video: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileRenderVideoLong = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, render_video_long: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { render_video_long: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileRemoveTitle = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, remove_title: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { remove_title: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileNeedContentCheck = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, need_content_check: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { need_content_check: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileAutoIncrementSchedule = async (id, enabled) => {
    if (processingRef.current.has(id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, auto_increment_schedule: enabled ? 1 : 0 } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { auto_increment_schedule: enabled });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileScheduleInterval = async (id, interval) => {
    if (processingRef.current.has(id)) return;
    const intervalNum = Number(interval);
    const intervalVal = [5, 10, 15, 20].includes(intervalNum) ? intervalNum : 5;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, schedule_interval: intervalVal } : p))
    );
    processingRef.current.add(id);
    try {
      await axios.patch(`/api/profiles/${id}`, { schedule_interval: intervalVal });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    } finally {
      processingRef.current.delete(id);
    }
  };

  const updateProfileUploadCount = async (id, count) => {
    // Optimistic update
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, upload_count: count } : p))
    );
    try {
      await axios.patch(`/api/profiles/${id}`, { upload_count: count });
      // Small delay to ensure DB consistency
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetchData();
    } catch (err) {
      console.error(err);
      await fetchData();
    }
  };

  const selectFolderPath = async () => {
    try {
      const res = await axios.post('/api/select-folder');
      return res.data?.path || null;
    } catch (err) {
      console.error('Folder selection cancelled or failed');
      return null;
    }
  };

  const handleSelectFolder = async (id) => {
    setIsSelectingFolder(true);
    try {
      const selectedPath = await selectFolderPath();
      if (selectedPath) {
        await updateProfileFolder(id, selectedPath);
      }
    } finally {
      setIsSelectingFolder(false);
    }
  };

  const selectAvatarPath = async () => {
    try {
      const res = await axios.post('/api/select-image-file');
      return res.data?.path || null;
    } catch (err) {
      console.error('Image file selection cancelled or failed');
      return null;
    }
  };

  const handleSelectAvatar = async (id) => {
    setIsSelectingFolder(true);
    try {
      const selectedPath = await selectAvatarPath();
      if (selectedPath) {
        setAvatarSelections(prev => ({ ...prev, [id]: selectedPath }));
        await axios.patch(`/api/profiles/${id}`, { avatar_image: selectedPath });
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, avatar_image: selectedPath } : p));
      }
    } finally {
      setIsSelectingFolder(false);
    }
  };

  const handleSelectFolderForCreateProfile = async () => {
    setIsSelectingFolder(true);
    try {
      const selectedPath = await selectFolderPath();
      if (selectedPath) {
        setNewProfileVideoFolder(selectedPath);
      }
    } finally {
      setIsSelectingFolder(false);
    }
  };

  const handleChangeAvatar = async (profileId) => {
    const profile = profiles.find(p => p.id === profileId);
    const avatarImage = avatarSelections[profileId] || profile?.avatar_image;
    if (!avatarImage) {
      setMessage({ type: 'error', text: 'Please select an avatar image first' });
      return;
    }
    try {
      setChangingAvatarProfiles(prev => new Set([...prev, profileId]));
      await axios.post('/api/change-avatar', { profileId, avatarImage });
      setMessage({ type: 'success', text: 'Avatar change started! Browser will open shortly.' });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setChangingAvatarProfiles(prev => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to change avatar' });
    }
  };

  const handleAddFavoriteMusic = async (profileId) => {
    const searchTerm = musicSearchTerms[profileId];
    if (!searchTerm || !searchTerm.trim()) {
      setMessage({ type: 'error', text: 'Please enter a search term in Edit settings' });
      return;
    }
    try {
      setAddingFavoriteMusicProfiles(prev => new Set([...prev, profileId]));
      await axios.post('/api/add-favorite-music', { profileId, searchTerm: searchTerm.trim() });
      setMessage({ type: 'success', text: 'Adding favorite music! Browser will open shortly.' });
      setTimeout(() => setMessage(null), 5000);
    } catch (err) {
      setAddingFavoriteMusicProfiles(prev => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
      setMessage({ type: 'error', text: err.response?.data?.error || 'Failed to add favorite music' });
    }
  };

  const handleUpdateMusicSearchTerm = async (profileId, value) => {
    setMusicSearchTerms(prev => ({ ...prev, [profileId]: value }));
    try {
      await axios.patch(`/api/profiles/${profileId}`, { music_search: value });
    } catch (err) {
      console.error('Failed to save music_search:', err);
    }
  };

  const handleEditProfile = (profileId) => {
    // Load existing music_search from profile data into the edit state
    const profile = profiles.find(p => p.id === profileId);
    if (profile?.music_search) {
      setMusicSearchTerms(prev => ({ ...prev, [profileId]: profile.music_search }));
    }
    setEditingProfileId(profileId);
  };

  const handleCloseEditProfile = () => {
    setEditingProfileId(null);
  };

  const handleDoneEditProfile = () => {
    setEditingProfileId(null);
    setMessage({ type: 'success', text: 'Profile updated successfully' });
    setTimeout(() => setMessage(null), 3000);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'uploading': return 'var(--accent)';
      case 'logging_in': return '#10B981';
      case 'engaging': return '#EC4899';
      case 'changing_avatar': return '#3B82F6';
      case 'adding_favorite_music': return '#A855F7';
      case 'success': return 'var(--success)';
      case 'error': return 'var(--error)';
      case 'no_videos': return '#EAB308';
      default: return 'var(--text-muted)';
    }
  };

  return (
    <div className="container" style={{ padding: '20px 20px', maxWidth: '1400px', margin: '0 auto', minHeight: '100vh', boxSizing: 'border-box' }}>
      {/* Sidebar / Navigation */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: sidebarCollapsed ? '60px 1fr' : '280px 1fr',
        gap: '40px',
        alignItems: 'start',
        transition: 'grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      }}>
        <motion.aside
          layout
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '32px',
            overflowX: 'hidden',
            overflowY: 'auto',
            position: 'sticky',
            top: '20px',
            alignSelf: 'start',
            maxHeight: 'calc(100vh - 40px)'
          }}
        >
          {/* Toggle button */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              cursor: 'pointer',
              padding: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              alignSelf: sidebarCollapsed ? 'center' : 'flex-end',
              transition: 'all 0.2s',
              flexShrink: 0
            }}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          </button>

          {/* Brand */}
          {!sidebarCollapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <div style={{
                  background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(255, 63, 182, 0.3)',
                  flexShrink: 0
                }}>
                  <Zap fill="white" size={20} color="white" />
                </div>
                <h1 style={{ fontSize: '1.75rem', fontWeight: '800', letterSpacing: '-0.02em' }}>
                  TikTok<span style={{ color: 'var(--primary)' }}>Manager</span>
                </h1>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', paddingLeft: '4px' }}>Enterprise Automation</p>
            </motion.div>
          )}

          {/* Nav */}
          <nav className="glass" style={{ padding: sidebarCollapsed ? '8px' : '12px', borderRadius: '20px', transition: 'padding 0.3s' }}>
            <button
              onClick={() => setActiveTab('profiles')}
              title={sidebarCollapsed ? 'Profiles Management' : undefined}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                gap: sidebarCollapsed ? '0' : '12px',
                padding: sidebarCollapsed ? '10px 0' : '12px 16px',
                borderRadius: '12px',
                background: activeTab === 'profiles' ? 'rgba(255, 63, 182, 0.1)' : 'transparent',
                color: activeTab === 'profiles' ? 'var(--primary)' : 'var(--text-muted)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: '600',
                transition: 'all 0.2s'
              }}
            >
              <Layout size={20} /> {!sidebarCollapsed && 'Profiles Management'}
            </button>
            <button
              onClick={() => setActiveTab('groups')}
              title={sidebarCollapsed ? 'Groups' : undefined}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                gap: sidebarCollapsed ? '0' : '12px',
                padding: sidebarCollapsed ? '10px 0' : '12px 16px',
                borderRadius: '12px',
                background: activeTab === 'groups' ? 'rgba(255, 63, 182, 0.1)' : 'transparent',
                color: activeTab === 'groups' ? 'var(--primary)' : 'var(--text-muted)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: '600',
                marginTop: '8px',
                transition: 'all 0.2s'
              }}
            >
              <Users size={20} /> {!sidebarCollapsed && 'Groups'}
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              title={sidebarCollapsed ? 'System Settings' : undefined}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                gap: sidebarCollapsed ? '0' : '12px',
                padding: sidebarCollapsed ? '10px 0' : '12px 16px',
                borderRadius: '12px',
                background: activeTab === 'settings' ? 'rgba(255, 63, 182, 0.1)' : 'transparent',
                color: activeTab === 'settings' ? 'var(--primary)' : 'var(--text-muted)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: '600',
                marginTop: '8px',
                transition: 'all 0.2s'
              }}
            >
              <Settings size={20} /> {!sidebarCollapsed && 'System Settings'}
            </button>
          </nav>

          {/* System Status - only when expanded */}
          {!sidebarCollapsed && (
            <motion.div
              className="glass"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ padding: '18px 20px', borderRadius: '16px' }}
            >
              <h4 style={{ fontFamily: 'var(--display)', fontSize: '13px', fontWeight: '600', margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldCheck size={14} color="var(--green)" /> System Status
              </h4>
              {/* Nhãn là siêu dữ liệu, con số mới là nội dung: nhãn nhỏ in hoa
                  giãn chữ, số dùng mono tabular để các hàng thẳng cột với nhau. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
                {[
                  ['Active profiles', String(profiles.length)],
                  ['Concurrency', String(config.maxConcurrency)],
                  ['Stats từ ngày', config.statsLimitDate || '—'],
                  ['Hẹn giờ đăng', Number(config.postDelayEnabled) === 1 ? formatPostDelay(config.postDelayMinutes) : 'Tắt'],
                ].map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
                    <span className="micro">{label}</span>
                    <span className="mono" style={{ fontSize: '12.5px', color: 'var(--ink)' }}>{value}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </motion.aside>

        {/* Main Content */}
        <main>
          {/* Flash message is now rendered as fixed toast below */}

          {activeTab === 'profiles' ? (
            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '1.5rem', fontWeight: '700', marginBottom: '4px' }}>Profiles Dashboard</h2>
                  <p style={{ color: 'var(--text-muted)' }}>Manage and automate your TikTok accounts</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '16px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      Group
                      <select
                        className="input"
                        style={{ padding: '8px 12px', minWidth: '180px' }}
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                      >
                        <option value="all">All Groups</option>
                        <option value="ungrouped">Ungrouped</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.name}</option>
                        ))}
                      </select>
                    </label>
                    {filteredProfiles.length > 0 && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleSelectAllFiltered}
                          style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                        />
                        Chọn tất cả
                      </label>
                    )}
                    {selectedForRun.size > 0 && (
                      <span style={{ fontSize: '0.85rem', color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                        Đã chọn {selectedForRun.size} profile
                        {bulkRunMode === 'sequential' ? ' (chạy tuần tự)' : ' (chạy cùng lúc)'}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexShrink: 1, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setIsCreateProfileModalOpen(true)}
                    style={{ gap: '10px' }}
                  >
                    <Plus size={18} />
                    Thêm mới
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setIsImportModalOpen(true)}
                    style={{ gap: '10px' }}
                  >
                    <Upload size={18} />
                    Import CSV
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setIsImportFolderModalOpen(true)}
                    style={{ gap: '10px' }}
                  >
                    <FolderOpen size={18} />
                    Import Folder
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setIsExportFolderModalOpen(true)}
                    disabled={selectedForRun.size === 0}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên các profile cần export' : 'Export danh sách profile đã chọn thành thư mục/ZIP theo format TikTok_Export'}
                    style={{ gap: '10px', '--tint': 'var(--sky)' }}
                  >
                    <Download size={18} />
                    Export Folder ({selectedForRun.size})
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={clearTrash}
                    disabled={selectedForRun.size === 0}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần dọn rác' : 'Xoá cache/thùng rác của các profile đã chọn để tiết kiệm dung lượng'}
                    style={{ gap: '10px', '--tint': 'var(--amber)' }}
                  >
                    <Trash2 size={18} />
                    Clear Trash
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={clearDebugFiles}
                    title="Xóa file debug PNG và dọn automation.log để giải phóng dung lượng (~300-600MB)"
                    style={{ gap: '10px', '--tint': 'var(--amber)' }}
                  >
                    <Trash2 size={18} />
                    Clear Debug
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={deleteSelectedProfiles}
                    disabled={selectedForRun.size === 0}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần xóa' : 'Xoá các profile đã chọn và folder của chúng'}
                    style={{ gap: '10px', '--tint': 'var(--red)' }}
                  >
                    <Trash2 size={18} />
                    Xóa Profile
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => startAutomation()}
                    disabled={isLoading || selectedForRun.size === 0}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần upload' : undefined}
                    style={{ gap: '10px' }}
                  >
                    {isLoading ? <RefreshCw className="animate-pulse" size={18} /> : <Play fill="white" size={18} />}
                    Chạy đã chọn
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={openStatsModal}
                    disabled={selectedForRun.size === 0}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần thống kê' : 'Thống kê video cho các profile đã chọn'}
                    style={{ gap: '10px', '--tint': 'var(--indigo)' }}
                  >
                    <BarChart2 size={18} />
                    Thống kê
                  </button>

                  {/* Bulk Login button */}
                  <button
                    className="btn btn-ghost"
                    onClick={startBulkLogin}
                    disabled={selectedForRun.size === 0 || isLoading}
                    title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần Login' : 'Login TikTok cho tất cả đã chọn'}
                    style={{ gap: '10px', '--tint': 'var(--green)' }}
                  >
                    <LogIn size={18} />
                    Login đã chọn
                  </button>

                  {/* Bulk Engage button */}
                  {(() => {
                    const selectedEngaging = [...selectedForRun].filter(id => engagingProfiles.has(id));
                    const allSelectedEngaging = selectedForRun.size > 0 && selectedEngaging.length === selectedForRun.size;
                    return (
                      <button
                        className={`btn ${allSelectedEngaging ? 'btn-tinted' : 'btn-ghost'}`}
                        onClick={() => allSelectedEngaging ? stopBulkEngage() : startBulkEngage()}
                        disabled={selectedForRun.size === 0}
                        title={selectedForRun.size === 0 ? 'Tick checkbox trên từng profile cần Engage' : (allSelectedEngaging ? 'Dừng Engage tất cả đã chọn' : 'Bật Auto Engage cho tất cả đã chọn')}
                        style={{ gap: '10px', '--tint': allSelectedEngaging ? 'var(--red)' : 'var(--pink)' }}
                      >
                        {allSelectedEngaging
                          ? <><StopCircle size={18} className="animate-pulse" /> Stop Engage</>
                          : <><Heart size={18} /> Engage đã chọn</>
                        }
                      </button>
                    );
                  })()}

                </div>
              </div>

              {/* Limit upload row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', height: '38px', padding: '0 12px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', userSelect: 'none', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={limitUploads}
                    onChange={(e) => setLimitUploads(e.target.checked)}
                    style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'white' }}>Giới hạn upload</span>
                </label>
                {limitUploads && (
                  <>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Số video</span>
                    <input
                      type="number"
                      className="input"
                      style={{ padding: '8px 10px', height: '38px', width: '64px' }}
                      min="1"
                      value={uploadLimitCount}
                      onChange={(e) => setUploadLimitCount(parseInt(e.target.value) || 1)}
                    />
                  </>
                )}
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Kiểu chạy</span>
                <select
                  className="input"
                  value={bulkRunMode}
                  onChange={(e) => setBulkRunMode(e.target.value === 'sequential' ? 'sequential' : 'parallel')}
                  style={{ padding: '8px 10px', height: '38px', cursor: 'pointer' }}
                >
                  <option value="parallel">Cùng lúc</option>
                  <option value="sequential">Tuần tự</option>
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '24px', alignItems: 'start' }}>
                  {filteredProfiles.map((profile) => (
                    <ProfileCard
                      key={profile.id}
                      profile={profile}
                      isSelected={selectedForRun.has(profile.id)}
                      onToggleSelected={toggleProfileSelectedForRun}
                      onDelete={deleteProfile}
                      onOpen={openProfile}
                      onOpenFolder={openProfileFolder}
                      onStart={startAutomation}
                      onEngage={startEngage}
                      onStopEngage={stopEngage}
                      isEngaging={engagingProfiles.has(profile.id)}
                      onLoginTikTok={startLoginTikTok}
                      onStopLoginTikTok={stopLoginTikTok}
                      isLoggingIn={loggingInProfiles.has(profile.id)}
                      onUpdateName={updateProfileName}
                      onChangeAvatar={handleChangeAvatar}
                      isChangingAvatar={changingAvatarProfiles.has(profile.id)}
                      onAddFavoriteMusic={handleAddFavoriteMusic}
                      isAddingFavoriteMusic={addingFavoriteMusicProfiles.has(profile.id)}

                      getStatusColor={getStatusColor}
                      editingId={editingId}
                      setEditingId={setEditingId}
                      editingValue={editingValue}
                      setEditingValue={setEditingValue}
                      onEdit={handleEditProfile}
                      groups={groups}

                    />
                  ))}
              </div>

              {profiles.length === 0 && (
                <div style={{
                  textAlign: 'center',
                  padding: '80px 40px',
                  color: 'var(--text-muted)',
                  border: '2px dashed var(--border)',
                  borderRadius: '24px',
                  marginTop: '40px'
                }}>
                  <div style={{ background: 'rgba(255,255,255,0.02)', width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                    <Layout size={32} opacity={0.3} />
                  </div>
                  <h3 style={{ color: 'white', marginBottom: '8px' }}>No profiles yet</h3>
                  <p>Add your first TikTok account profile to start automation.</p>
                </div>
              )}

              {profiles.length > 0 && filteredProfiles.length === 0 && (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '48px 24px',
                    color: 'var(--text-muted)',
                    border: '2px dashed var(--border)',
                    borderRadius: '24px',
                    marginTop: '24px'
                  }}
                >
                  <p style={{ color: 'white', marginBottom: '8px', fontWeight: '600' }}>No profiles match this filter</p>
                  <p style={{ fontSize: '0.9rem' }}>Change the group filter above to see profiles.</p>
                </div>
              )}

              <AnimatePresence>
                {isCreateProfileModalOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{
                      position: 'fixed',
                      inset: 0,
                      background: 'rgba(15, 23, 42, 0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1000,
                      padding: '24px'
                    }}
                    onClick={() => closeCreateProfileModal()}
                  >
                    <motion.div
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 12, scale: 0.98 }}
                      className="glass"
                      style={{
                        width: '100%',
                        maxWidth: '520px',
                        maxHeight: '85vh',
                        padding: '24px',
                        borderRadius: '20px',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden'
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexShrink: 0 }}>
                        <div>
                          <h3 style={{ fontSize: '1.15rem', fontWeight: '700' }}>Create Profile</h3>
                          <p style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '0.8rem' }}>Add a new TikTok profile and assign a group</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => closeCreateProfileModal()}
                          disabled={isCreatingProfile || isSelectingFolder}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: isCreatingProfile || isSelectingFolder ? 'not-allowed' : 'pointer',
                            opacity: isCreatingProfile || isSelectingFolder ? 0.45 : 1
                          }}
                          aria-label="Close create profile modal"
                        >
                          <X size={18} />
                        </button>
                      </div>

                      <div className="modal-scroll" style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'grid', gap: '12px', minWidth: 0 }}>
                        <div className="input-group">
                          <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Profile Name</label>
                          <input
                            autoFocus
                            className="input"
                            style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                            placeholder="Nhập tên profile"
                            value={newProfileName}
                            onChange={(e) => setNewProfileName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') addProfile();
                              if (e.key === 'Escape') closeCreateProfileModal();
                            }}
                            disabled={isCreatingProfile || isSelectingFolder}
                          />
                        </div>

                        <div className="input-group">
                          <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Group</label>
                          <select
                            className="input"
                            style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                            value={newProfileGroupId}
                            onChange={(e) => setNewProfileGroupId(e.target.value)}
                            disabled={isCreatingProfile || isSelectingFolder}
                          >
                            <option value="">No group</option>
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="input-group">
                          <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Source Folder</label>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <input
                              className="input"
                              style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
                              placeholder="/path/to/videos"
                              value={newProfileVideoFolder}
                              onChange={(e) => setNewProfileVideoFolder(e.target.value)}
                              disabled={isCreatingProfile || isSelectingFolder}
                            />
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={handleSelectFolderForCreateProfile}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ padding: '0 12px', fontSize: '0.8rem' }}
                            >
                              <FolderOpen size={16} style={{ marginRight: '6px' }} />
                              Browse
                            </button>
                          </div>
                        </div>

                        <div className="input-group">
                          <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Channel IDs (comma separated)</label>
                          <textarea
                            className="input"
                            style={{ width: '100%', boxSizing: 'border-box', minHeight: '100px', resize: 'vertical', fontFamily: 'inherit', padding: '8px 12px', fontSize: '0.85rem' }}
                            placeholder="e.g. UC123, UC456"
                            value={newProfileChannelIds}
                            onChange={(e) => setNewProfileChannelIds(e.target.value)}
                            disabled={isCreatingProfile || isSelectingFolder}
                            rows={4}
                          />
                        </div>

                        <div className="input-group">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                            <input
                              type="checkbox"
                              checked={newProfileNeedsRender}
                              onChange={(e) => setNewProfileNeedsRender(e.target.checked)}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.82rem', fontWeight: '700' }}>Render video bypass</span>
                              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Mặc định bật. Tắt đi nếu muốn giữ nguyên video gốc.</span>
                            </div>
                          </label>
                        </div>

                        <div className="input-group">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                            <input
                              type="checkbox"
                              checked={newProfileRenderConcatVideo}
                              onChange={(e) => setNewProfileRenderConcatVideo(e.target.checked)}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>Render concat video</span>
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Nối video tải về với 1 video ngẫu nhiên trong thư mục concat_videos.</span>
                            </div>
                          </label>
                        </div>

                        <div className="input-group" style={{ marginBottom: '12px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                            <input
                              type="checkbox"
                              checked={newProfileRemoveTitle}
                              onChange={(e) => setNewProfileRemoveTitle(e.target.checked)}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.82rem', fontWeight: '700' }}>Xóa tiêu đề khi upload</span>
                              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Mặc định bật. Tắt đi nếu muốn giữ lại tiêu đề gốc làm caption.</span>
                            </div>
                          </label>
                        </div>

                        <div className="input-group">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                            <input
                              type="checkbox"
                              checked={newProfileRenderVideoLong}
                              onChange={(e) => setNewProfileRenderVideoLong(e.target.checked)}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>Render video dài (&gt;3p cắt nhỏ, up tất cả ngay)</span>
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Mặc định tắt. Tự động cắt video dài thành nhiều phần, upload toàn bộ.</span>
                            </div>
                          </label>
                        </div>

                        <div className="input-group" style={{ marginBottom: '24px' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                            <input
                              type="checkbox"
                              checked={newProfileNeedContentCheck}
                              onChange={(e) => setNewProfileNeedContentCheck(e.target.checked)}
                              disabled={isCreatingProfile || isSelectingFolder}
                              style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.82rem', fontWeight: '700' }}>Kiểm tra nội dung (Content Check)</span>
                              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Mặc định bật. Tắt đi nếu muốn bỏ qua Content Check Lite của TikTok khi upload.</span>
                            </div>
                          </label>
                        </div>

                      </div>
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                        <button type="button" className="btn btn-secondary" onClick={() => closeCreateProfileModal()} disabled={isCreatingProfile || isSelectingFolder} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>
                          Cancel
                        </button>
                        <button className="btn btn-primary" onClick={addProfile} disabled={isCreatingProfile || isSelectingFolder || !newProfileName.trim()} style={{ padding: '8px 20px', fontSize: '0.85rem' }}>
                          {isCreatingProfile ? 'Creating...' : 'Create'}
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Import CSV Modal */}
              <AnimatePresence>
                {isImportModalOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{
                      position: 'fixed',
                      inset: 0,
                      background: 'rgba(15, 23, 42, 0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1000,
                      padding: '24px'
                    }}
                    onClick={() => closeImportModal()}
                  >
                    <motion.div
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 12, scale: 0.98 }}
                      className="glass"
                      style={{ width: '100%', maxWidth: '520px', padding: '24px', borderRadius: '20px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                        <div>
                          <h3 style={{ fontSize: '1.2rem', fontWeight: '700' }}>Import CSV Profiles</h3>
                          <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                            Tạo hàng loạt profile từ file CSV
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => closeImportModal()}
                          disabled={isImporting}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: isImporting ? 'not-allowed' : 'pointer',
                            opacity: isImporting ? 0.45 : 1
                          }}
                          aria-label="Close import modal"
                        >
                          <X size={18} />
                        </button>
                      </div>

                      <div style={{ display: 'grid', gap: '16px' }}>
                        <div style={{
                          padding: '20px',
                          borderRadius: '14px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '2px dashed var(--border)',
                          textAlign: 'center'
                        }}>
                          <Upload size={28} color="var(--text-muted)" style={{ marginBottom: '12px', opacity: 0.5 }} />
                          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                            File CSV cần có các cột:
                          </p>
                          <p style={{ fontSize: '0.75rem', color: 'var(--accent)', fontFamily: 'monospace', marginBottom: '16px' }}>
                            profile_name, group_name, account_id, pass, email, pass_email, cookies, music_search
                          </p>
                          <input
                            type="file"
                            accept=".csv"
                            onChange={handleFileSelect}
                            disabled={isImporting}
                            style={{
                              display: 'block',
                              width: '100%',
                              padding: '12px',
                              borderRadius: '10px',
                              background: 'rgba(0,0,0,0.3)',
                              color: 'white',
                              border: '1px solid var(--border)',
                              cursor: isImporting ? 'not-allowed' : 'pointer',
                              fontSize: '0.85rem'
                            }}
                          />
                          {importFileName && (
                            <p style={{ fontSize: '0.8rem', color: 'var(--success)', marginTop: '10px' }}>
                              Đã chọn: {importFileName}
                            </p>
                          )}
                        </div>

                        {importResults && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            style={{
                              padding: '16px',
                              borderRadius: '12px',
                              background: importResults.errors.length > 0
                                ? 'rgba(234, 179, 8, 0.08)'
                                : 'rgba(16, 185, 129, 0.08)',
                              border: `1px solid ${importResults.errors.length > 0
                                ? 'rgba(234, 179, 8, 0.25)'
                                : 'rgba(16, 185, 129, 0.25)'}`
                            }}
                          >
                            <div style={{ display: 'flex', gap: '20px', marginBottom: importResults.errors.length > 0 ? '12px' : 0 }}>
                              <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>
                                Đã import: <strong>{importResults.imported}</strong>
                              </span>
                              <span style={{ fontSize: '0.85rem', color: '#EAB308' }}>
                                Bỏ qua: <strong>{importResults.skipped}</strong>
                              </span>
                            </div>
                            {importResults.errors.length > 0 && (
                              <div style={{
                                maxHeight: '120px',
                                overflowY: 'auto',
                                fontSize: '0.75rem',
                                color: '#EAB308',
                                lineHeight: 1.5
                              }}>
                                {importResults.errors.slice(0, 10).map((err, i) => (
                                  <div key={i}>{err}</div>
                                ))}
                                {importResults.errors.length > 10 && (
                                  <div>... và {importResults.errors.length - 10} lỗi khác</div>
                                )}
                              </div>
                            )}
                          </motion.div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
                          <button type="button" className="btn btn-secondary" onClick={() => closeImportModal()} disabled={isImporting}>
                            Đóng
                          </button>
                          <button
                            className="btn btn-primary"
                            onClick={handleImportCsv}
                            disabled={isImporting || !importCsvText.trim()}
                            style={{ gap: '8px' }}
                          >
                            {isImporting ? (
                              <>
                                <RefreshCw size={16} className="animate-pulse" />
                                Đang import...
                              </>
                            ) : (
                              <>
                                <Upload size={16} />
                                Import
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Profile Edit Modal */}
              <AnimatePresence>
                {editingProfileId && (() => {
                  const p = profiles.find(pr => pr.id === editingProfileId);
                  if (!p) return null;
                  return (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                        padding: '24px'
                      }}
                      onClick={handleCloseEditProfile}
                    >
                      <motion.div
                        initial={{ opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.98 }}
                        className="glass"
                        style={{
                          width: '100%',
                          maxWidth: '520px',
                          maxHeight: '85vh',
                          padding: '24px',
                          borderRadius: '20px',
                          display: 'flex',
                          flexDirection: 'column',
                          overflow: 'hidden'
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexShrink: 0 }}>
                          <div>
                            <h3 style={{ fontSize: '1.15rem', fontWeight: '700' }}>{p.name}</h3>
                            <p style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '0.8rem' }}>Edit profile settings</p>
                          </div>
                          <button
                            type="button"
                            onClick={handleCloseEditProfile}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer'
                            }}
                            aria-label="Close edit modal"
                          >
                            <X size={18} />
                          </button>
                        </div>

                        <div className="modal-scroll" style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'grid', gap: '12px', minWidth: 0 }}>

                          {/* Group */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Group</label>
                            <select
                              className="input"
                              style={{ padding: '8px 12px', fontSize: '0.85rem', width: '100%' }}
                              value={p.group_id || ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                updateProfileGroup(p.id, v === '' ? null : v);
                              }}
                            >
                              <option value="">No group</option>
                              {groups.map((g) => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                              ))}
                            </select>
                          </div>

                          {/* Upload Folder */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Upload Folder</label>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <input
                                className="input"
                                style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
                                placeholder="Global Default"
                                value={p.video_folder || ''}
                                onChange={(e) => updateProfileFolder(p.id, e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => handleSelectFolder(p.id)}
                                style={{ padding: '0 12px', fontSize: '0.8rem' }}
                              >
                                <FolderOpen size={16} style={{ marginRight: '6px' }} />
                                Browse
                              </button>
                            </div>
                          </div>

                          {/* Avatar Image */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Avatar Image</label>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <input
                                className="input"
                                style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
                                placeholder="Select an image..."
                                value={avatarSelections[p.id] || p.avatar_image || ''}
                                readOnly
                              />
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => handleSelectAvatar(p.id)}
                                style={{ padding: '0 12px', fontSize: '0.8rem' }}
                              >
                                <FolderOpen size={16} style={{ marginRight: '6px' }} />
                                Browse
                              </button>
                            </div>
                          </div>

                          {/* Favorite Music */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Favorite Music (search)</label>
                            <input
                              className="input"
                              style={{ padding: '8px 12px', fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }}
                              placeholder="Search music to favorite..."
                              value={musicSearchTerms[p.id] || ''}
                              onChange={(e) => handleUpdateMusicSearchTerm(p.id, e.target.value)}
                            />
                          </div>

                          {/* Proxy Server */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Proxy Server</label>
                            <input
                              className="input"
                              style={{ padding: '8px 12px', fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }}
                              placeholder="http://user:pass@host:port"
                              value={p.proxy || ''}
                              onChange={(e) => updateProfileProxy(p.id, e.target.value)}
                            />
                          </div>

                          {/* Channel IDs */}
                          <div className="input-group">
                            <label style={{ fontSize: '0.8rem', marginBottom: '6px', display: 'block', fontWeight: '600', color: 'var(--text-muted)' }}>Channel IDs (comma separated)</label>
                            <textarea
                              className="input"
                              style={{ width: '100%', boxSizing: 'border-box', minHeight: '56px', resize: 'vertical', fontFamily: 'inherit', padding: '8px 12px', fontSize: '0.85rem' }}
                              placeholder="e.g. UC123, UC456"
                              value={p.channel_ids || ''}
                              onChange={(e) => updateProfileChannelIds(p.id, e.target.value)}
                              rows={2}
                            />
                          </div>

                          {/* Schedule */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.is_scheduled === 1}
                                onChange={(e) => updateProfileSchedule(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: '0.82rem', fontWeight: '700' }}>Schedule Public Video</span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Lên lịch công khai video</span>
                              </div>
                            </label>
                            {p.is_scheduled === 1 && (
                              <div style={{ marginTop: '8px', paddingLeft: '24px' }}>
                                <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>Daily Times (HH:mm, HH:mm)</label>
                                <input
                                  className="input"
                                  style={{ padding: '8px 12px', fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }}
                                  placeholder="e.g. 08:00, 18:00, 22:00"
                                  defaultValue={p.schedules?.join(', ') || ''}
                                  onBlur={(e) => updateProfileSchedules(p.id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      updateProfileSchedules(p.id, e.target.value);
                                      e.target.blur();
                                    }
                                  }}
                                />
                                <div style={{ marginTop: '8px' }}>
                                  <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>Số lượng video mỗi lần</label>
                                  <input
                                    type="number"
                                    className="input"
                                    style={{ padding: '8px 12px', fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }}
                                    min="1"
                                    placeholder="Default: 1"
                                    value={p.upload_count || 1}
                                    onChange={(e) => updateProfileUploadCount(p.id, parseInt(e.target.value) || 1)}
                                  />
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Auto Increment Schedule */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.auto_increment_schedule === 1}
                                onChange={(e) => updateProfileAutoIncrementSchedule(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontSize: '0.82rem', fontWeight: '700' }}>Lên lịch nối tiếp</span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>V1: Public, V2: Mặc định, V3+: +{(p.schedule_interval || 5)} phút</span>
                              </div>
                            </label>
                            {p.auto_increment_schedule === 1 && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', paddingLeft: '24px' }}>
                                <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)' }}>Khoảng cách:</span>
                                {[5, 10, 15, 20].map((mins) => (
                                  <label key={mins} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', cursor: 'pointer' }}>
                                    <input
                                      type="radio"
                                      name={`schedule_interval_${p.id}`}
                                      value={mins}
                                      checked={(p.schedule_interval || 5) === mins}
                                      onChange={() => updateProfileScheduleInterval(p.id, mins)}
                                      style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
                                    />
                                    {mins} phút
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Render video bypass */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.needs_render !== 0}
                                onChange={(e) => updateProfileNeedsRender(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '700' }}>
                                  <Zap size={14} color="var(--primary)" style={{ flexShrink: 0 }} />
                                  Render video bypass
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Bật: xử lý lách bản quyền qua render.py. Tắt: giữ nguyên video gốc.</span>
                              </div>
                            </label>
                          </div>

                          {/* Render concat video */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.render_concat_video !== 0 && p.render_concat_video !== undefined}
                                onChange={(e) => updateProfileRenderConcatVideo(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '700' }}>
                                  <Link size={14} color="var(--primary)" style={{ flexShrink: 0 }} />
                                  Render concat video
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Bật: nối video tải về với 1 video bất kỳ trong thư mục concat_videos.</span>
                              </div>
                            </label>
                          </div>

                          {/* Remove Title */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.remove_title !== 0}
                                onChange={(e) => updateProfileRemoveTitle(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '700' }}>
                                  <Trash2 size={14} color="var(--error)" style={{ flexShrink: 0 }} />
                                  Xóa tiêu đề khi upload
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Bật: tự động xóa tiêu đề mặc định khi đăng. Tắt: giữ tiêu đề gốc.</span>
                              </div>
                            </label>
                          </div>

                          {/* Set Nhạc */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.set_music === 1}
                                onChange={(e) => updateProfileSetMusic(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '700' }}>
                                  <Music size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
                                  Set nhạc khi upload
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Bật: mở Edit video, chọn nhạc từ Favorites rồi Save.</span>
                              </div>
                            </label>
                          </div>

                          {/* Content Check */}
                          <div className="input-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '8px 10px', borderRadius: '10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                              <input
                                type="checkbox"
                                checked={p.need_content_check !== 0}
                                onChange={(e) => updateProfileNeedContentCheck(p.id, e.target.checked)}
                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', fontWeight: '700' }}>
                                  <ShieldCheck size={14} color="var(--success)" style={{ flexShrink: 0 }} />
                                  Kiểm tra nội dung (Content Check)
                                </span>
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '1px' }}>Bật: tự động kiểm tra bản quyền / nội dung bằng Content Check Lite. Tắt: bỏ qua kiểm tra.</span>
                              </div>
                            </label>
                          </div>

                        </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                          <button type="button" className="btn btn-primary" onClick={handleDoneEditProfile} style={{ padding: '8px 20px', fontSize: '0.85rem' }}>
                            Done
                          </button>
                        </div>
                      </motion.div>
                    </motion.div>
                  );
                })()}
              </AnimatePresence>


              {/* Import Folder Modal */}
              <AnimatePresence>
                {isImportFolderModalOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{
                      position: 'fixed',
                      inset: 0,
                      background: 'rgba(15, 23, 42, 0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1000,
                      padding: '24px'
                    }}
                    onClick={() => closeImportFolderModal()}
                  >
                    <motion.div
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 12, scale: 0.98 }}
                      className="glass"
                      style={{ width: '100%', maxWidth: '520px', padding: '24px', borderRadius: '20px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                        <div>
                          <h3 style={{ fontSize: '1.2rem', fontWeight: '700' }}>Import Export Folder</h3>
                          <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                            Import danh sách tài khoản kèm cookie từ thư mục export
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => closeImportFolderModal()}
                          disabled={isImporting}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: isImporting ? 'not-allowed' : 'pointer',
                            opacity: isImporting ? 0.45 : 1
                          }}
                          aria-label="Close import folder modal"
                        >
                          <X size={18} />
                        </button>
                      </div>

                      <div style={{ display: 'grid', gap: '16px' }}>
                        <div style={{ display: 'grid', gap: '8px' }}>
                          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            Đường dẫn thư mục tuyệt đối trên server:
                          </label>
                          <input
                            type="text"
                            placeholder="Ví dụ: D:\TIKTOK\upload_tiktok\TikTok_Export_checked_1TK_20260724"
                            value={importFolderPath}
                            onChange={(e) => setImportFolderPath(e.target.value)}
                            disabled={isImporting}
                            style={{
                              padding: '12px',
                              borderRadius: '10px',
                              background: 'rgba(0,0,0,0.3)',
                              color: 'white',
                              border: '1px solid var(--border)',
                              fontSize: '0.85rem',
                              width: '100%',
                              boxSizing: 'border-box'
                            }}
                          />
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                            * Thư mục này phải chứa file <code>config.json</code> và thư mục con <code>cookies/</code> chứa các file <code>.json</code> cookie.<br/>
                            * Tài khoản nào không có cookie tương ứng sẽ bị tự động bỏ qua.
                          </p>
                        </div>

                        {importResults && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            style={{
                              padding: '16px',
                              borderRadius: '12px',
                              background: importResults.errors.length > 0
                                ? 'rgba(234, 179, 8, 0.08)'
                                : 'rgba(16, 185, 129, 0.08)',
                              border: `1px solid ${importResults.errors.length > 0
                                ? 'rgba(234, 179, 8, 0.25)'
                                : 'rgba(16, 185, 129, 0.25)'}`
                            }}
                          >
                            <div style={{ display: 'flex', gap: '20px', marginBottom: importResults.errors.length > 0 ? '12px' : 0 }}>
                              <span style={{ fontSize: '0.85rem', color: 'var(--success)' }}>
                                Đã import: <strong>{importResults.imported}</strong>
                              </span>
                              <span style={{ fontSize: '0.85rem', color: '#EAB308' }}>
                                Bỏ qua: <strong>{importResults.skipped}</strong>
                              </span>
                            </div>
                            {importResults.errors.length > 0 && (
                              <div style={{
                                maxHeight: '120px',
                                overflowY: 'auto',
                                fontSize: '0.75rem',
                                color: '#EAB308',
                                lineHeight: 1.5
                              }}>
                                {importResults.errors.slice(0, 15).map((err, i) => (
                                  <div key={i}>{err}</div>
                                ))}
                                {importResults.errors.length > 15 && (
                                  <div>... và {importResults.errors.length - 15} lỗi khác</div>
                                )}
                              </div>
                            )}
                          </motion.div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
                          <button type="button" className="btn btn-secondary" onClick={() => closeImportFolderModal()} disabled={isImporting}>
                            Đóng
                          </button>
                          <button
                            className="btn btn-primary"
                            onClick={handleImportFolder}
                            disabled={isImporting || !importFolderPath.trim()}
                            style={{ gap: '8px' }}
                          >
                            {isImporting ? (
                              <>
                                <RefreshCw size={16} className="animate-pulse" />
                                Đang import...
                              </>
                            ) : (
                              <>
                                <Upload size={16} />
                                Import
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Export Folder Modal */}
              <AnimatePresence>
                {isExportFolderModalOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{
                      position: 'fixed',
                      inset: 0,
                      background: 'rgba(15, 23, 42, 0.7)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 1000,
                      padding: '24px'
                    }}
                    onClick={() => closeExportFolderModal()}
                  >
                    <motion.div
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 12, scale: 0.98 }}
                      className="glass"
                      style={{ width: '100%', maxWidth: '540px', padding: '24px', borderRadius: '20px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                        <div>
                          <h3 style={{ fontSize: '1.2rem', fontWeight: '700' }}>Export Folder (Cookie Login)</h3>
                          <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                            Xuất {selectedForRun.size} profile đã chọn thành thư mục chuẩn format TikTok_Export
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => closeExportFolderModal()}
                          disabled={isExporting}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: isExporting ? 'not-allowed' : 'pointer',
                            opacity: isExporting ? 0.45 : 1
                          }}
                          aria-label="Close export folder modal"
                        >
                          <X size={18} />
                        </button>
                      </div>

                      <div style={{ display: 'grid', gap: '16px' }}>
                        <div style={{ display: 'grid', gap: '8px' }}>
                          <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            Đường dẫn thư mục xuất tuyệt đối (Tùy chọn, để trống sẽ tự tạo thư mục mới):
                          </label>
                          <input
                            type="text"
                            placeholder={`D:\\TIKTOK\\upload_tiktok\\TikTok_Export_selected_${selectedForRun.size}TK`}
                            value={exportFolderPath}
                            onChange={(e) => setExportFolderPath(e.target.value)}
                            disabled={isExporting}
                            style={{
                              padding: '12px',
                              borderRadius: '10px',
                              background: 'rgba(0,0,0,0.3)',
                              color: 'white',
                              border: '1px solid var(--border)',
                              fontSize: '0.85rem',
                              width: '100%',
                              boxSizing: 'border-box'
                            }}
                          />
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                            * Kết quả xuất bao gồm file <code>config.json</code>, <code>archive.json</code> và thư mục <code>cookies/</code> chứa cookie JSON từng tài khoản.<br/>
                            * Thư mục này dùng để import trực tiếp sang máy khác thông qua nút <b>Import Folder</b>.
                          </p>
                        </div>

                        {exportResults && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            style={{
                              padding: '16px',
                              borderRadius: '12px',
                              background: 'rgba(34, 197, 94, 0.08)',
                              border: '1px solid rgba(34, 197, 94, 0.25)',
                              fontSize: '0.85rem'
                            }}
                          >
                            <div style={{ fontWeight: '700', color: '#4ADE80', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <CheckCircle2 size={16} />
                              Export hoàn tất!
                            </div>
                            <div style={{ display: 'grid', gap: '4px', color: 'var(--text-muted)' }}>
                              <div>• Tổng profile đã chọn: <b>{exportResults.total}</b></div>
                              <div>• Cookie đã ghi ra file JSON: <b>{exportResults.exportedCookies}</b></div>
                              {exportResults.missingCookies > 0 && (
                                <div style={{ color: '#FBBF24' }}>
                                  • Profile chưa có cookie trong DB: <b>{exportResults.missingCookies}</b>
                                </div>
                              )}
                              <div style={{ marginTop: '6px', wordBreak: 'break-all' }}>
                                • Thư mục: <code style={{ color: '#60A5FA' }}>{exportResults.exportPath}</code>
                              </div>
                            </div>
                          </motion.div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '8px' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => closeExportFolderModal()}
                            disabled={isExporting}
                          >
                            Đóng
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleExportFolder(false)}
                            disabled={isExporting || selectedForRun.size === 0}
                            style={{ gap: '8px' }}
                          >
                            <FolderArchive size={16} />
                            {isExporting ? 'Đang export...' : 'Xuất ra Thư mục'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleExportFolder(true)}
                            disabled={isExporting || selectedForRun.size === 0}
                            style={{
                              gap: '8px',
                              background: 'linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)'
                            }}
                          >
                            <Download size={16} />
                            {isExporting ? 'Đang export...' : 'Xuất & Tải .ZIP'}
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

            </section>
          ) : activeTab === 'groups' ? (
            <section>
              <div style={{ marginBottom: '28px' }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: '700', marginBottom: '8px' }}>Groups</h2>
                <p style={{ color: 'var(--text-muted)', maxWidth: '640px', lineHeight: 1.5 }}>
                  Tạo và đổi tên nhóm để gom profile. Gán profile vào nhóm từ tab Profiles; xóa nhóm chỉ khi không còn profile gán.
                </p>
              </div>

              <div className="glass" style={{ padding: '20px 24px', borderRadius: '20px', marginBottom: '28px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
                  <input
                    className="input"
                    placeholder="Tên nhóm mới..."
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    style={{ flex: '1 1 220px', minWidth: '200px', padding: '10px 14px' }}
                    onKeyDown={(e) => e.key === 'Enter' && addGroup()}
                  />
                  <button type="button" className="btn btn-primary" onClick={addGroup} style={{ padding: '10px 20px', gap: '8px' }}>
                    <Plus size={18} />
                    Create
                  </button>
                </div>
              </div>

              {groups.length === 0 ? (
                <div
                  className="glass"
                  style={{
                    textAlign: 'center',
                    padding: '56px 32px',
                    borderRadius: '24px',
                    color: 'var(--text-muted)',
                    border: '2px dashed var(--border)'
                  }}
                >
                  <Users size={40} style={{ margin: '0 auto 16px', opacity: 0.35 }} />
                  <p style={{ color: 'white', fontWeight: '600', marginBottom: '8px' }}>Chưa có nhóm</p>
                  <p style={{ fontSize: '0.9rem' }}>Nhập tên và bấm Create để thêm nhóm đầu tiên.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {groups.map((g) => (
                    <div
                      key={g.id}
                      className="glass"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '14px',
                        flexWrap: 'wrap',
                        padding: '16px 20px',
                        borderRadius: '16px',
                        border: '1px solid var(--border)'
                      }}
                    >
                      {editingGroupId === g.id ? (
                        <>
                          <input
                            autoFocus
                            className="input"
                            style={{ flex: '1 1 240px', padding: '8px 12px' }}
                            value={editingGroupValue}
                            onChange={(e) => setEditingGroupValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') updateGroupName(g.id, editingGroupValue);
                              if (e.key === 'Escape') setEditingGroupId(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => updateGroupName(g.id, editingGroupValue)}
                            style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: '4px' }}
                            aria-label="Save name"
                          >
                            <Check size={18} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingGroupId(null)}
                            style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', padding: '4px' }}
                            aria-label="Cancel rename"
                          >
                            <X size={18} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: '1 1 180px', fontWeight: '700', fontSize: '1rem' }}>{g.name}</span>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {g.profile_count ?? 0} profile{g.profile_count === 1 ? '' : 's'}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingGroupId(g.id);
                              setEditingGroupValue(g.name);
                            }}
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '6px' }}
                            aria-label="Rename group"
                          >
                            <Edit3 size={18} />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteGroup(g.id)}
                            style={{ background: 'none', border: 'none', color: 'rgba(239, 68, 68, 0.65)', cursor: 'pointer', padding: '6px' }}
                            aria-label="Delete group"
                          >
                            <Trash2 size={18} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section>
              <div style={{ marginBottom: '32px' }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: '700', marginBottom: '4px' }}>System Configuration</h2>
                <p style={{ color: 'var(--text-muted)' }}>Fine-tune your automation engine</p>
              </div>

              <div className="glass" style={{ padding: '32px', borderRadius: '24px', maxWidth: '600px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '10px', fontSize: '0.95rem', fontWeight: '600' }}>
                      Video Source Folder
                    </label>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        value={config.videoFolder}
                        onChange={(e) => setConfig({ ...config, videoFolder: e.target.value })}
                        placeholder="/Users/path/to/videos"
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={async () => {
                          setIsSelectingFolder(true);
                          const selectedPath = await selectFolderPath();
                          setIsSelectingFolder(false);
                          if (selectedPath) {
                            const newConfig = { ...config, videoFolder: selectedPath };
                            setConfig(newConfig);
                            try {
                              await axios.post('/api/config', newConfig);
                              setMessage({ type: 'success', text: 'Video folder updated' });
                              setTimeout(() => setMessage(null), 3000);
                            } catch (err) {
                              setMessage({ type: 'error', text: 'Failed to save folder' });
                            }
                          }
                        }}
                        style={{ padding: '0 15px', whiteSpace: 'nowrap' }}
                      >
                        <FolderOpen size={18} style={{ marginRight: '8px' }} />
                        Browse
                      </button>
                    </div>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                      Specify the absolute path where your .mp4 files are located.
                    </p>
                  </div>

                  <div>
                    <label style={{ display: 'block', marginBottom: '10px', fontSize: '0.95rem', fontWeight: '600' }}>
                      Maximum Parallel Uploads
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        style={{ flex: 1, accentColor: 'var(--primary)' }}
                        value={config.maxConcurrency}
                        onChange={(e) => setConfig({ ...config, maxConcurrency: parseInt(e.target.value) })}
                      />
                      <div className="glass" style={{ padding: '8px 16px', borderRadius: '8px', fontWeight: '700', color: 'var(--primary)' }}>
                        {config.maxConcurrency}
                      </div>
                    </div>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                      Control how many browser instances run concurrently.
                    </p>
                  </div>

                  <div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={Number(config.postDelayEnabled) === 1}
                        onChange={(e) => setConfig({ ...config, postDelayEnabled: e.target.checked ? 1 : 0 })}
                        style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                      />
                      <span style={{ fontSize: '0.95rem', fontWeight: '600' }}>Hẹn giờ đăng video đầu</span>
                    </label>

                    {Number(config.postDelayEnabled) === 1 && (
                      <div style={{ marginTop: '12px', paddingLeft: '28px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <input
                            type="number"
                            className="input"
                            style={{ width: '120px' }}
                            min="15"
                            max="14400"
                            // Bậc 5 vì mọi mốc lịch đều rơi vào bội số 5 phút:
                            // ô giờ của TikTok là time picker và chỉ có bằng
                            // chứng nó nhận bội số 5. Nhận 27 ở đây chỉ tạo ra
                            // khoảng lệch mà người dùng không hiểu vì sao.
                            step="5"
                            value={config.postDelayMinutes ?? 60}
                            onChange={(e) => setConfig({ ...config, postDelayMinutes: e.target.value })}
                            onBlur={(e) => {
                              const minutes = Number(e.target.value);
                              const safe = Number.isFinite(minutes)
                                ? Math.min(Math.max(Math.ceil(minutes / 5) * 5, 15), 14400)
                                : 60;
                              setConfig({ ...config, postDelayMinutes: safe });
                            }}
                          />
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                            phút &mdash; bội số của 5, tối thiểu 15, tối đa 14400 (10 ngày)
                          </span>
                        </div>
                        {postDelayPreview() && (
                          <p style={{ fontSize: '0.8rem', color: 'var(--primary)', marginTop: '8px' }}>
                            Chạy bây giờ thì video đầu lên lịch khoảng {postDelayPreview()}.
                          </p>
                        )}
                      </div>
                    )}

                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                      Bật thì mọi lượt chạy (Start, Run All, lịch tự động, webhook) đều không đăng ngay:
                      video đầu được hẹn sau số giờ này, các video sau nối tiếp theo khoảng cách lịch của
                      từng profile. Kênh còn lịch cũ đang treo thì vẫn ưu tiên nối tiếp lịch cũ.
                    </p>
                  </div>

                  <div>
                    <label style={{ display: 'block', marginBottom: '10px', fontSize: '0.95rem', fontWeight: '600' }}>
                      Stats Date Limit
                    </label>
                    <div
                      className="input"
                      style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0', overflow: 'hidden' }}
                    >
                      <span style={{ flex: 1, padding: '12px 0 12px 16px', color: config.statsLimitDate ? 'white' : 'var(--text-muted)' }}>
                        {config.statsLimitDate
                          ? new Date(config.statsLimitDate + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
                          : 'Select date...'}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const hiddenInput = document.getElementById('stats-limit-date-hidden');
                          if (hiddenInput) hiddenInput.showPicker();
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: '12px 16px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          borderLeft: '1px solid var(--border)',
                        }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                          <line x1="16" y1="2" x2="16" y2="6" />
                          <line x1="8" y1="2" x2="8" y2="6" />
                          <line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                      </button>
                      {config.statsLimitDate && (
                        <button
                          type="button"
                          onClick={() => setConfig({ ...config, statsLimitDate: null })}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: '12px 16px 12px 4px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <input
                      id="stats-limit-date-hidden"
                      type="date"
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
                      value={config.statsLimitDate || ''}
                      onChange={(e) => setConfig({ ...config, statsLimitDate: e.target.value || null })}
                    />
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px' }}>
                      Only scan videos from newest to this date. Leave empty to scan all videos.
                    </p>
                  </div>

                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: '12px', justifyContent: 'center' }}
                    onClick={updateConfig}
                  >
                    Save Changes
                  </button>
                </div>
              </div>

              <div style={{ marginTop: '32px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px', maxWidth: '600px' }}>
                <div className="glass" style={{ padding: '20px', borderRadius: '16px' }}>
                  <AlertCircle size={20} color="var(--accent)" style={{ marginBottom: '12px' }} />
                  <h4 style={{ fontSize: '0.9rem', marginBottom: '6px' }}>Quick Tip</h4>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Each profile uses a separate browser context. Make sure you have enough RAM for parallel runs.
                  </p>
                </div>
                <div className="glass" style={{ padding: '20px', borderRadius: '16px' }}>
                  <ShieldCheck size={20} color="var(--success)" style={{ marginBottom: '12px' }} />
                  <h4 style={{ fontSize: '0.9rem', marginBottom: '6px' }}>Database Secure</h4>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    System is now powered by SQLite for high reliability and data persistence.
                  </p>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
      {/* Folder Selection Loading Overlay */}
      <AnimatePresence>
        {isSelectingFolder && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.7)',
              backdropFilter: 'blur(8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              flexDirection: 'column',
              gap: '20px'
            }}
          >
            <div className="glass" style={{ padding: '40px', borderRadius: '24px', textAlign: 'center', border: '1px solid var(--primary)' }}>
              <div style={{ position: 'relative', width: '80px', height: '80px', margin: '0 auto 24px' }}>
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  border: '4px solid rgba(255, 63, 182, 0.1)',
                  borderRadius: '50%'
                }} />
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    border: '4px solid transparent',
                    borderTopColor: 'var(--primary)',
                    borderRadius: '50%'
                  }}
                />
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FolderOpen size={32} color="var(--primary)" />
                </div>
              </div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '8px' }}>Select Folder...</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                Please select a folder in the native dialog that appeared.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats Modal */}
      <StatsModal
        isOpen={isStatsModalOpen}
        profileIds={statsProfileIds}
        onClose={() => setIsStatsModalOpen(false)}
      />

      {/* Flash Toast Message */}
      <AnimatePresence>
        {message && (
          <motion.div
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="glass"
            style={{
              position: 'fixed',
              top: '20px',
              right: '24px',
              padding: '14px 24px',
              borderRadius: '14px',
              background: message.type === 'error'
                ? 'rgba(239, 68, 68, 0.15)'
                : 'rgba(16, 185, 129, 0.15)',
              backdropFilter: 'blur(20px)',
              color: message.type === 'error' ? '#EF4444' : '#10B981',
              border: `1px solid ${message.type === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              zIndex: 2000,
              boxShadow: message.type === 'error'
                ? '0 8px 32px rgba(239, 68, 68, 0.15)'
                : '0 8px 32px rgba(16, 185, 129, 0.15)',
              maxWidth: '420px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {message.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>{message.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
