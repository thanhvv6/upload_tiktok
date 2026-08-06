import React from 'react';
import {
  X,
  FolderOpen,
  Video,
  Image,
  Search,
  Link,
  Users,
  Clock,
  Music,
  Zap,
  Trash2,
  ShieldCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const EditProfileModal = ({
  isOpen,
  onClose,
  profile,
  groups,
  getStatusColor,
  onUpdateGroup,
  onUpdateFolder,
  onSelectFolder,
  onUpdateProxy,
  onUpdateChannelIds,
  onUpdateSchedule,
  onUpdateSchedules,
  onUpdateSetMusic,
  onUpdateAutoIncrementSchedule,
  onUpdateScheduleInterval,
  onUpdateUploadCount,
  onUpdateNeedsRender,
  onUpdateRenderConcatVideo,
  onUpdateRemoveTitle,
  onUpdateNeedContentCheck,
  onUpdateRenderVideoLong,
  onSelectAvatar,
  selectedAvatarPath,
  musicSearchTerm,
  onUpdateMusicSearchTerm
}) => {
  if (!profile) return null;

  const handleBackdropClick = (e) => {
    onClose();
  };

  const handleCardClick = (e) => {
    e.stopPropagation();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
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
          onClick={handleBackdropClick}
          onKeyDown={handleKeyDown}
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
              flexDirection: 'column'
            }}
            onClick={handleCardClick}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
              flexShrink: 0
            }}>
              <div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: '700' }}>Edit Profile</h3>
                <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>{profile.name}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer'
                }}
                aria-label="Close edit profile modal"
              >
                <X size={18} />
              </button>
            </div>

            {/* Scrollable Body */}
            <div style={{
              overflowY: 'auto',
              flex: 1,
              paddingRight: '4px'
            }}>
              {/* Group */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <FolderOpen size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Group</span>
                </div>
                <select
                  className="input"
                  style={{ fontSize: '0.75rem', padding: '8px 12px', width: '100%' }}
                  value={profile.group_id || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    onUpdateGroup(profile.id, v === '' ? null : v);
                  }}
                >
                  <option value="">No group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>

              {/* Upload Folder */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Video size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Upload Folder</span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    className="input"
                    style={{ fontSize: '0.75rem', padding: '8px 12px', flex: 1 }}
                    placeholder="Global Default"
                    value={profile.video_folder || ''}
                    onChange={(e) => onUpdateFolder(profile.id, e.target.value)}
                  />
                  <button
                    onClick={() => onSelectFolder(profile.id)}
                    className="btn-secondary"
                    style={{ padding: '8px', minWidth: 'auto' }}
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              {/* Avatar Image */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Image size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Avatar Image</span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    className="input"
                    style={{ fontSize: '0.75rem', padding: '8px 12px', flex: 1 }}
                    placeholder="Select an image..."
                    value={selectedAvatarPath || ''}
                    readOnly
                  />
                  <button
                    onClick={() => onSelectAvatar(profile.id)}
                    className="btn-secondary"
                    style={{ padding: '8px', minWidth: 'auto' }}
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>

              {/* Favorite Music */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Search size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Favorite Music</span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    className="input"
                    style={{ fontSize: '0.75rem', padding: '8px 12px', flex: 1 }}
                    placeholder="Search music to favorite..."
                    value={musicSearchTerm || ''}
                    onChange={(e) => onUpdateMusicSearchTerm(profile.id, e.target.value)}
                  />
                </div>
              </div>

              {/* Proxy Server */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Link size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Proxy Server (Optional)</span>
                </div>
                <input
                  className="input"
                  style={{ fontSize: '0.75rem', padding: '8px 12px', width: '100%' }}
                  placeholder="http://user:pass@host:port"
                  value={profile.proxy || ''}
                  onChange={(e) => onUpdateProxy(profile.id, e.target.value)}
                />
              </div>

              {/* Channel IDs */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Users size={14} color="var(--text-muted)" />
                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Channel IDs (comma separated)</span>
                </div>
                <textarea
                  className="input"
                  style={{ fontSize: '0.75rem', padding: '8px 12px', width: '100%', minHeight: '60px', resize: 'vertical', fontFamily: 'inherit' }}
                  placeholder="e.g. UC123, UC456"
                  value={profile.channel_ids || ''}
                  onChange={(e) => onUpdateChannelIds(profile.id, e.target.value)}
                  rows={2}
                />
              </div>

              {/* Schedule Public Video */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.is_scheduled === 1}
                    onChange={(e) => onUpdateSchedule(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>Schedule Public Video</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Lên lịch công khai video</span>
                  </div>
                </label>

                {profile.is_scheduled === 1 && (
                  <div style={{ marginTop: '12px', paddingLeft: '38px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <Clock size={14} color="var(--text-muted)" />
                      <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Daily Times (HH:mm, HH:mm)</span>
                    </div>
                    <input
                      className="input"
                      style={{ fontSize: '0.75rem', padding: '8px 12px', width: '100%' }}
                      placeholder="e.g. 08:00, 18:00, 22:00"
                      defaultValue={profile.schedules?.join(', ') || ''}
                      onBlur={(e) => onUpdateSchedules(profile.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          onUpdateSchedules(profile.id, e.target.value);
                          e.target.blur();
                        }
                      }}
                    />

                    <div style={{ marginTop: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <Video size={14} color="var(--text-muted)" />
                        <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)' }}>Số lượng video mỗi lần</span>
                      </div>
                      <input
                        type="number"
                        className="input"
                        style={{ fontSize: '0.75rem', padding: '8px 12px', width: '100%' }}
                        min="1"
                        placeholder="Default: 1"
                        value={profile.upload_count || 1}
                        onChange={(e) => onUpdateUploadCount(profile.id, parseInt(e.target.value) || 1)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Auto Increment Schedule */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={profile.auto_increment_schedule === 1}
                      onChange={(e) => onUpdateAutoIncrementSchedule(profile.id, e.target.checked)}
                      style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>Lên lịch nối tiếp</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>V1: Public, V2: Mặc định, V3+: +{(profile.schedule_interval || 5)} phút</span>
                    </div>
                  </label>

                  {profile.auto_increment_schedule === 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingLeft: '28px' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)' }}>Khoảng cách:</span>
                      {[5, 10, 15, 20].map((mins) => (
                        <label key={mins} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name={`schedule_interval_${profile.id}`}
                            value={mins}
                            checked={(profile.schedule_interval || 5) === mins}
                            onChange={() => onUpdateScheduleInterval && onUpdateScheduleInterval(profile.id, mins)}
                            style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
                          />
                          {mins} phút
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Render bypass */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.needs_render !== 0}
                    onChange={(e) => onUpdateNeedsRender(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                       <Zap size={14} color="var(--primary)" style={{ flexShrink: 0 }} />
                      Render video bypass
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: xử lý lách bản quyền qua render.py. Tắt: giữ nguyên video gốc.
                    </span>
                  </div>
                </label>
              </div>

              {/* Render concat video */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.render_concat_video !== 0 && profile.render_concat_video !== undefined}
                    onChange={(e) => onUpdateRenderConcatVideo(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                      <Link size={14} color="var(--primary)" style={{ flexShrink: 0 }} />
                      Render concat video
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: nối video tải về với 1 video bất kỳ trong thư mục concat_videos.
                    </span>
                  </div>
                </label>
              </div>

              {/* Render video long */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.render_video_long !== 0}
                    onChange={(e) => onUpdateRenderVideoLong(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                      <Video size={14} color="var(--primary)" style={{ flexShrink: 0 }} />
                      Render video dài (&gt;3p cắt nhỏ, up tất cả ngay)
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: tự động cắt video dài thành nhiều phần, zoom 1.8x, làm nền mờ và upload liên tục toàn bộ.
                    </span>
                  </div>
                </label>
              </div>

              {/* Remove title */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.remove_title !== 0}
                    onChange={(e) => onUpdateRemoveTitle(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                      <Trash2 size={14} color="var(--error)" style={{ flexShrink: 0 }} />
                      Xóa tiêu đề khi upload
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: tự động xóa tiêu đề mặc định khi đăng. Tắt: giữ tiêu đề gốc.
                    </span>
                  </div>
                </label>
              </div>

              {/* Set music */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.set_music === 1}
                    onChange={(e) => onUpdateSetMusic(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                      <Music size={14} color="var(--accent)" style={{ flexShrink: 0 }} />
                      Set nhạc khi upload
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: mở Edit video, chọn nhạc từ Favorites rồi Save.
                    </span>
                  </div>
                </label>
              </div>

              {/* Content Check */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={profile.need_content_check !== 0}
                    onChange={(e) => onUpdateNeedContentCheck(profile.id, e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: '700' }}>
                      <ShieldCheck size={14} color="var(--success)" style={{ flexShrink: 0 }} />
                      Kiểm tra nội dung (Content Check)
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      Bật: tự động kiểm tra bản quyền / nội dung bằng Content Check Lite. Tắt: bỏ qua kiểm tra.
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Footer with status */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: '16px',
              borderTop: '1px solid var(--border)',
              flexShrink: 0
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: getStatusColor(profile.status)
                }} />
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: '700',
                  color: getStatusColor(profile.status),
                  textTransform: 'uppercase'
                }}>
                  {profile.status}
                </span>
              </div>
              <button
                className="btn btn-secondary"
                onClick={onClose}
                style={{ padding: '8px 20px' }}
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default EditProfileModal;
