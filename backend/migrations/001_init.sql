-- 001_init.sql — Complete PostgreSQL schema (consolidates all SQLite migrations)
-- Run with: psql -U tiktok -d tiktok -f migrations/001_init.sql

CREATE TABLE IF NOT EXISTS profiles (
    id              TEXT PRIMARY KEY,
    name            TEXT UNIQUE,
    status          TEXT DEFAULT 'idle',
    video_folder    TEXT,
    proxy           TEXT,
    is_scheduled    BOOLEAN DEFAULT FALSE,
    last_run        TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    group_id        TEXT,
    set_music       BOOLEAN DEFAULT TRUE,
    auto_increment_schedule BOOLEAN DEFAULT FALSE,
    upload_count    INTEGER DEFAULT 1,
    channel_ids     TEXT,
    needs_render    BOOLEAN DEFAULT TRUE,
    render_concat_video BOOLEAN DEFAULT FALSE,
    remove_title    BOOLEAN DEFAULT TRUE,
    render_video_long BOOLEAN DEFAULT FALSE,
    need_content_check BOOLEAN DEFAULT TRUE,
    account_id      TEXT,
    pass            TEXT,
    email           TEXT,
    pass_email      TEXT,
    avatar_image    TEXT,
    music_search    TEXT,
    cookies         TEXT,
    schedule_interval INTEGER DEFAULT 5
);

CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile_schedules (
    id         SERIAL PRIMARY KEY,
    profile_id TEXT,
    time       TEXT,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_group_id ON profiles(group_id);
CREATE INDEX IF NOT EXISTS idx_profiles_is_scheduled ON profiles(is_scheduled);
CREATE INDEX IF NOT EXISTS idx_profile_schedules_profile_id ON profile_schedules(profile_id);
