import type Database from 'better-sqlite3';
import {
  MediaAssetSchema,
  type MediaAsset,
  type MediaAssetCategory,
} from '../../contracts/index.js';

interface MediaAssetRow {
  id: string;
  category: string;
  file_path: string;
  duration_sec: number | null;
  tags_json: string;
  is_active: number;
}

function mapRowToMediaAsset(row: MediaAssetRow): MediaAsset {
  return MediaAssetSchema.parse({
    id: row.id,
    category: row.category,
    filePath: row.file_path,
    durationSec: row.duration_sec,
    tags: JSON.parse(row.tags_json) as unknown,
    isActive: row.is_active === 1,
  });
}

export class MediaAssetRepository {
  private readonly upsertStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement<[string], MediaAssetRow>;
  private readonly findActiveByCategoryStmt: Database.Statement<[string], MediaAssetRow>;
  private readonly setActiveStmt: Database.Statement<[number, string]>;

  constructor(db: Database.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO media_assets (id, category, file_path, duration_sec, tags_json, is_active)
      VALUES (@id, @category, @file_path, @duration_sec, @tags_json, @is_active)
      ON CONFLICT(id) DO UPDATE SET
        category = excluded.category,
        file_path = excluded.file_path,
        duration_sec = excluded.duration_sec,
        tags_json = excluded.tags_json,
        is_active = excluded.is_active
    `);

    this.findByIdStmt = db.prepare<[string], MediaAssetRow>(
      'SELECT * FROM media_assets WHERE id = ?',
    );
    this.findActiveByCategoryStmt = db.prepare<[string], MediaAssetRow>(
      'SELECT * FROM media_assets WHERE category = ? AND is_active = 1 ORDER BY id ASC',
    );
    this.setActiveStmt = db.prepare<[number, string]>(
      'UPDATE media_assets SET is_active = ? WHERE id = ?',
    );
  }

  upsert(input: MediaAsset): MediaAsset {
    const asset = MediaAssetSchema.parse(input);
    this.upsertStmt.run({
      id: asset.id,
      category: asset.category,
      file_path: asset.filePath,
      duration_sec: asset.durationSec,
      tags_json: JSON.stringify(asset.tags),
      is_active: asset.isActive ? 1 : 0,
    });
    return asset;
  }

  findById(id: string): MediaAsset | null {
    const row = this.findByIdStmt.get(id);
    return row ? mapRowToMediaAsset(row) : null;
  }

  findActiveByCategory(category: MediaAssetCategory): MediaAsset[] {
    return this.findActiveByCategoryStmt.all(category).map(mapRowToMediaAsset);
  }

  setActive(id: string, isActive: boolean): boolean {
    const result = this.setActiveStmt.run(isActive ? 1 : 0, id);
    return result.changes > 0;
  }
}
