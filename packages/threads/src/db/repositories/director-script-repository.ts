import type Database from 'better-sqlite3';
import { AIDirectorOutputSchema, type AIDirectorOutput } from '../../contracts/index.js';

interface DirectorScriptRow {
  id: string;
  post_id: string;
  model_name: string;
  hook_lines_json: string;
  selected_comment_ids_json: string;
  segments_json: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  created_at: number;
}

function mapRowToDirectorScript(row: DirectorScriptRow): AIDirectorOutput {
  return AIDirectorOutputSchema.parse({
    id: row.id,
    postId: row.post_id,
    modelName: row.model_name,
    hookLines: JSON.parse(row.hook_lines_json) as unknown,
    selectedCommentIds: JSON.parse(row.selected_comment_ids_json) as unknown,
    segments: JSON.parse(row.segments_json) as unknown,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    createdAt: row.created_at,
  });
}

export class DirectorScriptRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement<[string], DirectorScriptRow>;
  private readonly findLatestByPostIdStmt: Database.Statement<[string], DirectorScriptRow>;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO director_scripts (
        id, post_id, model_name, hook_lines_json,
        selected_comment_ids_json, segments_json,
        prompt_tokens, completion_tokens, estimated_cost_usd, created_at
      ) VALUES (
        @id, @post_id, @model_name, @hook_lines_json,
        @selected_comment_ids_json, @segments_json,
        @prompt_tokens, @completion_tokens, @estimated_cost_usd, @created_at
      )
    `);

    this.findByIdStmt = db.prepare<[string], DirectorScriptRow>(
      'SELECT * FROM director_scripts WHERE id = ?',
    );
    this.findLatestByPostIdStmt = db.prepare<[string], DirectorScriptRow>(
      'SELECT * FROM director_scripts WHERE post_id = ? ORDER BY created_at DESC LIMIT 1',
    );
  }

  create(input: AIDirectorOutput): AIDirectorOutput {
    const script = AIDirectorOutputSchema.parse(input);
    this.insertStmt.run({
      id: script.id,
      post_id: script.postId,
      model_name: script.modelName,
      hook_lines_json: JSON.stringify(script.hookLines),
      selected_comment_ids_json: JSON.stringify(script.selectedCommentIds),
      segments_json: JSON.stringify(script.segments),
      prompt_tokens: script.promptTokens,
      completion_tokens: script.completionTokens,
      estimated_cost_usd: script.estimatedCostUsd,
      created_at: script.createdAt,
    });
    return script;
  }

  findById(id: string): AIDirectorOutput | null {
    const row = this.findByIdStmt.get(id);
    return row ? mapRowToDirectorScript(row) : null;
  }

  findLatestByPostId(postId: string): AIDirectorOutput | null {
    const row = this.findLatestByPostIdStmt.get(postId);
    return row ? mapRowToDirectorScript(row) : null;
  }
}
