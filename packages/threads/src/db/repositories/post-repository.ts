import type Database from 'better-sqlite3';
import {
  NormalizedThreadsPostSchema,
  type NormalizedThreadsPost,
} from '../../contracts/index.js';

interface PostRow {
  id: string;
  shortcode: string;
  source_url: string;
  author_handle: string;
  author_display_name: string | null;
  is_verified: number;
  author_avatar_path: string;
  posted_display_date: string;
  raw_text: string;
  images_json: string;
  stripped_video_count: number;
  metrics_json: string;
  top_replies_json: string;
  text_length_state: string;
  media_state: string;
  comment_state: string;
  expires_at: number;
  created_at: number;
}

function mapRowToPost(row: PostRow): NormalizedThreadsPost {
  return NormalizedThreadsPostSchema.parse({
    id: row.id,
    shortcode: row.shortcode,
    sourceUrl: row.source_url,
    authorHandle: row.author_handle,
    authorDisplayName: row.author_display_name ?? undefined,
    isVerified: row.is_verified === 1,
    authorAvatarPath: row.author_avatar_path,
    postedDisplayDate: row.posted_display_date,
    rawText: row.raw_text,
    images: JSON.parse(row.images_json) as unknown,
    strippedVideoCount: row.stripped_video_count,
    metrics: JSON.parse(row.metrics_json) as unknown,
    topReplies: JSON.parse(row.top_replies_json) as unknown,
    textLengthState: row.text_length_state,
    mediaState: row.media_state,
    commentState: row.comment_state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  });
}

export class PostRepository {
  private readonly upsertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement<[string], PostRow>;
  private readonly findByShortcodeStmt: Database.Statement<[string], PostRow>;
  private readonly findValidCacheStmt: Database.Statement<[string, number], PostRow>;
  private readonly deleteByIdStmt: Database.Statement<[string]>;

  constructor(db: Database.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO posts (
        id, shortcode, source_url, author_handle, author_display_name, is_verified,
        author_avatar_path, posted_display_date, raw_text, images_json,
        stripped_video_count, metrics_json, top_replies_json,
        text_length_state, media_state, comment_state, expires_at, created_at
      ) VALUES (
        @id, @shortcode, @source_url, @author_handle, @author_display_name, @is_verified,
        @author_avatar_path, @posted_display_date, @raw_text, @images_json,
        @stripped_video_count, @metrics_json, @top_replies_json,
        @text_length_state, @media_state, @comment_state, @expires_at, @created_at
      )
      ON CONFLICT(shortcode) DO UPDATE SET
        source_url = excluded.source_url,
        author_handle = excluded.author_handle,
        author_display_name = excluded.author_display_name,
        is_verified = excluded.is_verified,
        author_avatar_path = excluded.author_avatar_path,
        posted_display_date = excluded.posted_display_date,
        raw_text = excluded.raw_text,
        images_json = excluded.images_json,
        stripped_video_count = excluded.stripped_video_count,
        metrics_json = excluded.metrics_json,
        top_replies_json = excluded.top_replies_json,
        text_length_state = excluded.text_length_state,
        media_state = excluded.media_state,
        comment_state = excluded.comment_state,
        expires_at = excluded.expires_at
    `);

    this.findByIdStmt = db.prepare<[string], PostRow>('SELECT * FROM posts WHERE id = ?');
    this.findByShortcodeStmt = db.prepare<[string], PostRow>(
      'SELECT * FROM posts WHERE shortcode = ?',
    );
    this.findValidCacheStmt = db.prepare<[string, number], PostRow>(
      'SELECT * FROM posts WHERE shortcode = ? AND expires_at > ?',
    );
    this.deleteByIdStmt = db.prepare<[string]>('DELETE FROM posts WHERE id = ?');
  }

  upsert(input: NormalizedThreadsPost): NormalizedThreadsPost {
    const post = NormalizedThreadsPostSchema.parse(input);
    this.upsertStmt.run({
      id: post.id,
      shortcode: post.shortcode,
      source_url: post.sourceUrl,
      author_handle: post.authorHandle,
      author_display_name: post.authorDisplayName ?? null,
      is_verified: post.isVerified ? 1 : 0,
      author_avatar_path: post.authorAvatarPath,
      posted_display_date: post.postedDisplayDate,
      raw_text: post.rawText,
      images_json: JSON.stringify(post.images),
      stripped_video_count: post.strippedVideoCount,
      metrics_json: JSON.stringify(post.metrics),
      top_replies_json: JSON.stringify(post.topReplies),
      text_length_state: post.textLengthState,
      media_state: post.mediaState,
      comment_state: post.commentState,
      expires_at: post.expiresAt,
      created_at: post.createdAt,
    });

    return this.findByShortcode(post.shortcode) ?? post;
  }

  findById(id: string): NormalizedThreadsPost | null {
    const row = this.findByIdStmt.get(id);
    return row ? mapRowToPost(row) : null;
  }

  findByShortcode(shortcode: string): NormalizedThreadsPost | null {
    const row = this.findByShortcodeStmt.get(shortcode);
    return row ? mapRowToPost(row) : null;
  }

  findValidCacheByShortcode(
    shortcode: string,
    nowEpochSec: number = Math.floor(Date.now() / 1000),
  ): NormalizedThreadsPost | null {
    const row = this.findValidCacheStmt.get(shortcode, nowEpochSec);
    return row ? mapRowToPost(row) : null;
  }

  deleteById(id: string): boolean {
    const result = this.deleteByIdStmt.run(id);
    return result.changes > 0;
  }
}
