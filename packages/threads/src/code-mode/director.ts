import { z } from 'zod';
import {
  DEFAULT_VOICE_ID,
  NormalizedThreadsPostSchema,
  VOICE_CATALOG,
  type AIDirectorOutput,
  type VoiceCatalogEntry,
  type VoiceId,
} from '../contracts/index.js';
import {
  AIDirectorService,
  normalizeVietnameseTtsText as normalizeTextCore,
  type LlmDirectorAdapter,
  type NormalizedTtsResult,
} from '../director/index.js';
import { runCodeMode, type CodeModeResult } from './types.js';

export const NormalizeVietnameseTtsTextInputSchema = z.object({
  text: z.string().min(1),
});
export type NormalizeVietnameseTtsTextInput = z.infer<
  typeof NormalizeVietnameseTtsTextInputSchema
>;

export function normalizeVietnameseTtsText(
  input: NormalizeVietnameseTtsTextInput,
): Promise<CodeModeResult<NormalizedTtsResult>> {
  return runCodeMode(() => {
    const parsed = NormalizeVietnameseTtsTextInputSchema.parse(input);
    return normalizeTextCore(parsed.text);
  });
}

export const DirectVideoScriptInputSchema = z.object({
  post: NormalizedThreadsPostSchema,
  maxComments: z.number().int().min(0).max(5).default(5),
  scriptId: z.string().min(1).optional(),
  nowEpochSec: z.number().int().positive().optional(),
});
export type DirectVideoScriptInput = z.input<typeof DirectVideoScriptInputSchema>;

export interface DirectVideoScriptData {
  script: AIDirectorOutput;
}

export function directVideoScript(
  input: DirectVideoScriptInput & { llmAdapter?: LlmDirectorAdapter },
): Promise<CodeModeResult<DirectVideoScriptData>> {
  return runCodeMode(async () => {
    const parsed = DirectVideoScriptInputSchema.parse(input);
    const service = new AIDirectorService({ llmAdapter: input.llmAdapter });
    const script = await service.direct(parsed.post, {
      maxComments: parsed.maxComments,
      scriptId: parsed.scriptId,
      nowEpochSec: parsed.nowEpochSec,
    });
    return { script };
  });
}

export const ListAvailableVoicesInputSchema = z
  .object({
    engine: z.enum(['all', 'vieneu', 'edge-tts']).default('all'),
    gender: z.enum(['all', 'male', 'female']).default('all'),
  })
  .default({});
export type ListAvailableVoicesInput = z.input<typeof ListAvailableVoicesInputSchema>;

export interface ListAvailableVoicesData {
  voices: VoiceCatalogEntry[];
  totalCount: number;
  vieneuCount: number;
  edgeFallbackCount: number;
  defaultVoiceId: VoiceId;
}

export function listAvailableVoices(
  input?: ListAvailableVoicesInput,
): Promise<CodeModeResult<ListAvailableVoicesData>> {
  return runCodeMode(() => {
    const parsed = ListAvailableVoicesInputSchema.parse(input ?? {});
    const filtered = VOICE_CATALOG.filter((v) => {
      if (parsed.engine !== 'all' && v.engine !== parsed.engine) return false;
      if (parsed.gender !== 'all' && v.gender !== parsed.gender) return false;
      return true;
    });

    return {
      voices: filtered,
      totalCount: filtered.length,
      vieneuCount: VOICE_CATALOG.filter((v) => v.engine === 'vieneu').length,
      edgeFallbackCount: VOICE_CATALOG.filter((v) => v.engine === 'edge-tts').length,
      defaultVoiceId: DEFAULT_VOICE_ID,
    };
  });
}
