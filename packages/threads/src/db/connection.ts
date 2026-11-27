import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface DatabasePragmas {
  journalMode: string;
  foreignKeys: boolean;
}

export function openDatabase(dbPath: string = ':memory:'): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function getDatabasePragmas(db: Database.Database): DatabasePragmas {
  const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;

  return {
    journalMode,
    foreignKeys,
  };
}
