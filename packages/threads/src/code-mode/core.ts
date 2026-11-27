import path from 'node:path';
import { z } from 'zod';
import { resolveOpenReupDataDir } from '../paths.js';
import {
  VideoCompositionPropsSchema,
  type VideoCompositionProps,
} from '../contracts/index.js';
import {
  getDatabasePragmas,
  openDatabase,
  runMigrations,
  type DatabasePragmas,
} from '../db/index.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const ValidateCompositionPropsInputSchema = z.object({
  props: z.unknown(),
});
export type ValidateCompositionPropsInput = z.infer<
  typeof ValidateCompositionPropsInputSchema
>;

export interface ValidateCompositionPropsData {
  props: VideoCompositionProps;
}

export function validateCompositionProps(
  input: ValidateCompositionPropsInput,
): Promise<CodeModeResult<ValidateCompositionPropsData>> {
  return runCodeMode(() => {
    const parsedInput = ValidateCompositionPropsInputSchema.parse(input);
    const props = VideoCompositionPropsSchema.parse(parsedInput.props);
    return { props };
  });
}

export const InitLocalDatabaseInputSchema = z
  .object({
    dbPath: z.string().min(1).optional(),
  })
  .default({});
export type InitLocalDatabaseInput = z.input<typeof InitLocalDatabaseInputSchema>;

export interface InitLocalDatabaseData {
  dbPath: string;
  pragmas: DatabasePragmas;
  appliedMigrations: number[];
}

export function initLocalDatabase(
  input?: InitLocalDatabaseInput,
): Promise<CodeModeResult<InitLocalDatabaseData>> {
  return runCodeMode(() => {
    const parsed = InitLocalDatabaseInputSchema.parse(input ?? {});
    const resolvedPath =
      parsed.dbPath ?? path.join(resolveOpenReupDataDir(), 'threads_local.db');

    const db = openDatabase(resolvedPath);
    try {
      const appliedMigrations = runMigrations(db);
      const pragmas = getDatabasePragmas(db);
      return {
        dbPath: resolvedPath,
        pragmas,
        appliedMigrations,
      };
    } finally {
      db.close();
    }
  });
}
