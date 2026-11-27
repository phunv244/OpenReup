import type Database from 'better-sqlite3';
import {
  LatencyBreakdownMsSchema,
  RenderJobSchema,
  type ErrorCode,
  type LatencyBreakdownMs,
  type RenderJob,
  type RenderJobStatus,
} from '../../contracts/index.js';

interface RenderJobRow {
  id: string;
  post_id: string | null;
  script_id: string | null;
  status: string;
  fps: number;
  theme: string;
  voice_id: string;
  output_video_path: string | null;
  video_duration_sec: number | null;
  latency_breakdown_ms: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  completed_at: number | null;
}

function mapRowToRenderJob(row: RenderJobRow): RenderJob {
  return RenderJobSchema.parse({
    id: row.id,
    postId: row.post_id,
    scriptId: row.script_id,
    status: row.status,
    fps: row.fps,
    theme: row.theme,
    voiceId: row.voice_id,
    outputVideoPath: row.output_video_path,
    videoDurationSec: row.video_duration_sec,
    latencyBreakdownMs: row.latency_breakdown_ms
      ? (JSON.parse(row.latency_breakdown_ms) as unknown)
      : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export class RenderJobRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement<[string], RenderJobRow>;
  private readonly listByStatusStmt: Database.Statement<[string, number], RenderJobRow>;
  private readonly updateStatusStmt: Database.Statement<[string, string]>;
  private readonly linkPostAndScriptStmt: Database.Statement<[string | null, string | null, string]>;
  private readonly markCompletedStmt: Database.Statement;
  private readonly markFailedStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO render_jobs (
        id, post_id, script_id, status, fps, theme, voice_id,
        output_video_path, video_duration_sec, latency_breakdown_ms,
        error_code, error_message, created_at, completed_at
      ) VALUES (
        @id, @post_id, @script_id, @status, @fps, @theme, @voice_id,
        @output_video_path, @video_duration_sec, @latency_breakdown_ms,
        @error_code, @error_message, @created_at, @completed_at
      )
    `);

    this.findByIdStmt = db.prepare<[string], RenderJobRow>(
      'SELECT * FROM render_jobs WHERE id = ?',
    );
    this.listByStatusStmt = db.prepare<[string, number], RenderJobRow>(
      'SELECT * FROM render_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    );
    this.updateStatusStmt = db.prepare<[string, string]>(
      'UPDATE render_jobs SET status = ? WHERE id = ?',
    );
    this.linkPostAndScriptStmt = db.prepare<[string | null, string | null, string]>(
      'UPDATE render_jobs SET post_id = COALESCE(?, post_id), script_id = COALESCE(?, script_id) WHERE id = ?',
    );
    this.markCompletedStmt = db.prepare(`
      UPDATE render_jobs
      SET status = 'COMPLETED',
          output_video_path = @output_video_path,
          video_duration_sec = @video_duration_sec,
          latency_breakdown_ms = @latency_breakdown_ms,
          error_code = NULL,
          error_message = NULL,
          completed_at = @completed_at
      WHERE id = @id
    `);
    this.markFailedStmt = db.prepare(`
      UPDATE render_jobs
      SET status = @status,
          error_code = @error_code,
          error_message = @error_message,
          latency_breakdown_ms = COALESCE(@latency_breakdown_ms, latency_breakdown_ms),
          completed_at = @completed_at
      WHERE id = @id
    `);
  }

  create(input: RenderJob): RenderJob {
    const job = RenderJobSchema.parse(input);
    this.insertStmt.run({
      id: job.id,
      post_id: job.postId,
      script_id: job.scriptId,
      status: job.status,
      fps: job.fps,
      theme: job.theme,
      voice_id: job.voiceId,
      output_video_path: job.outputVideoPath,
      video_duration_sec: job.videoDurationSec,
      latency_breakdown_ms: job.latencyBreakdownMs
        ? JSON.stringify(job.latencyBreakdownMs)
        : null,
      error_code: job.errorCode,
      error_message: job.errorMessage,
      created_at: job.createdAt,
      completed_at: job.completedAt,
    });
    return job;
  }

  findById(id: string): RenderJob | null {
    const row = this.findByIdStmt.get(id);
    return row ? mapRowToRenderJob(row) : null;
  }

  listByStatus(status: RenderJobStatus, limit: number = 50): RenderJob[] {
    return this.listByStatusStmt.all(status, limit).map(mapRowToRenderJob);
  }

  updateStatus(id: string, status: RenderJobStatus): boolean {
    const result = this.updateStatusStmt.run(status, id);
    return result.changes > 0;
  }

  linkPostAndScript(id: string, postId: string | null, scriptId: string | null): boolean {
    const result = this.linkPostAndScriptStmt.run(postId, scriptId, id);
    return result.changes > 0;
  }

  markCompleted(
    id: string,
    params: {
      outputVideoPath: string;
      videoDurationSec: number;
      latencyBreakdownMs: LatencyBreakdownMs;
      completedAt?: number;
    },
  ): boolean {
    const latency = LatencyBreakdownMsSchema.parse(params.latencyBreakdownMs);
    const result = this.markCompletedStmt.run({
      id,
      output_video_path: params.outputVideoPath,
      video_duration_sec: params.videoDurationSec,
      latency_breakdown_ms: JSON.stringify(latency),
      completed_at: params.completedAt ?? Math.floor(Date.now() / 1000),
    });
    return result.changes > 0;
  }

  markFailed(
    id: string,
    params: {
      errorCode: ErrorCode;
      errorMessage: string;
      latencyBreakdownMs?: LatencyBreakdownMs;
      completedAt?: number;
    },
  ): boolean {
    const latency = params.latencyBreakdownMs
      ? JSON.stringify(LatencyBreakdownMsSchema.parse(params.latencyBreakdownMs))
      : null;
    const result = this.markFailedStmt.run({
      id,
      status: 'FAILED',
      error_code: params.errorCode,
      error_message: params.errorMessage,
      latency_breakdown_ms: latency,
      completed_at: params.completedAt ?? Math.floor(Date.now() / 1000),
    });
    return result.changes > 0;
  }
}
