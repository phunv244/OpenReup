import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        shortcode TEXT NOT NULL UNIQUE,
        source_url TEXT NOT NULL,
        author_handle TEXT NOT NULL,
        author_display_name TEXT,
        is_verified INTEGER NOT NULL DEFAULT 0,
        author_avatar_path TEXT NOT NULL,
        posted_display_date TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        images_json TEXT NOT NULL,
        stripped_video_count INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL,
        top_replies_json TEXT NOT NULL,
        text_length_state TEXT NOT NULL,
        media_state TEXT NOT NULL,
        comment_state TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS director_scripts (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        model_name TEXT NOT NULL,
        humor_score REAL NOT NULL,
        controversy_score REAL NOT NULL,
        relatability_score REAL NOT NULL,
        viral_score REAL NOT NULL,
        verdict TEXT NOT NULL,
        verdict_reason TEXT NOT NULL,
        hook_lines_json TEXT NOT NULL,
        selected_comment_ids_json TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_assets (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        file_path TEXT NOT NULL,
        duration_sec REAL,
        tags_json TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS render_jobs (
        id TEXT PRIMARY KEY,
        post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
        script_id TEXT REFERENCES director_scripts(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        fps INTEGER NOT NULL DEFAULT 60,
        theme TEXT NOT NULL DEFAULT 'dark',
        voice_id TEXT NOT NULL DEFAULT 'vi-VN-HoaiMyNeural',
        min_viral_score REAL NOT NULL DEFAULT 7.0,
        output_video_path TEXT,
        video_duration_sec REAL,
        latency_breakdown_ms TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_posts_shortcode ON posts(shortcode);
      CREATE INDEX IF NOT EXISTS idx_posts_expires_at ON posts(expires_at);
      CREATE INDEX IF NOT EXISTS idx_director_scripts_post_id ON director_scripts(post_id);
      CREATE INDEX IF NOT EXISTS idx_media_assets_category_active ON media_assets(category, is_active);
      CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_render_jobs_post_id ON render_jobs(post_id);
    `,
  },
  {
    version: 2,
    name: '002_director_no_scoring_and_vieneu',
    sql: `
      CREATE TABLE director_scripts_v2 (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        model_name TEXT NOT NULL,
        hook_lines_json TEXT NOT NULL,
        selected_comment_ids_json TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );

      INSERT INTO director_scripts_v2 (
        id, post_id, model_name, hook_lines_json, selected_comment_ids_json,
        segments_json, prompt_tokens, completion_tokens, estimated_cost_usd, created_at
      )
      SELECT
        id, post_id, model_name, hook_lines_json, selected_comment_ids_json,
        segments_json, prompt_tokens, completion_tokens, estimated_cost_usd, created_at
      FROM director_scripts;

      DROP TABLE director_scripts;
      ALTER TABLE director_scripts_v2 RENAME TO director_scripts;
      CREATE INDEX IF NOT EXISTS idx_director_scripts_post_id ON director_scripts(post_id);

      CREATE TABLE render_jobs_v2 (
        id TEXT PRIMARY KEY,
        post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
        script_id TEXT REFERENCES director_scripts(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        fps INTEGER NOT NULL DEFAULT 60,
        theme TEXT NOT NULL DEFAULT 'dark',
        voice_id TEXT NOT NULL DEFAULT 'Adam bựa',
        output_video_path TEXT,
        video_duration_sec REAL,
        latency_breakdown_ms TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      INSERT INTO render_jobs_v2 (
        id, post_id, script_id, status, fps, theme, voice_id,
        output_video_path, video_duration_sec, latency_breakdown_ms,
        error_code, error_message, created_at, completed_at
      )
      SELECT
        id, post_id, script_id,
        CASE
          WHEN status = 'SCORING' THEN 'DIRECTING'
          WHEN status = 'REJECTED' THEN 'FAILED'
          ELSE status
        END,
        fps, theme, voice_id,
        output_video_path, video_duration_sec, latency_breakdown_ms,
        error_code, error_message, created_at, completed_at
      FROM render_jobs;

      DROP TABLE render_jobs;
      ALTER TABLE render_jobs_v2 RENAME TO render_jobs;
      CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_render_jobs_post_id ON render_jobs(post_id);
    `,
  },
];

export function runMigrations(db: Database.Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const appliedRows = db
    .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
    .all();
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const newlyApplied: number[] = [];
  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyTx = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, Math.floor(Date.now() / 1000));
    });

    applyTx();
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}
