import { randomUUID } from 'node:crypto';
import {
  AIDirectorOutputSchema,
  paginatePostText,
  type AIDirectorOutput,
  type AudioCueDraft,
  type DirectorSegment,
  type HookLines,
  type NormalizedThreadsComment,
  type NormalizedThreadsPost,
  type SfxSlug,
  type StickerCode,
  type VisualCueDraft,
} from '../contracts/index.js';
import { assertContentPolicySafe } from './policy-guard.js';
import { normalizeVietnameseTtsText } from './tts-normalizer.js';

export const DEFAULT_DIRECTOR_MODEL = 'deterministic-rule-director-v1';
export const DEFAULT_MAX_SELECTED_COMMENTS = 5;
export const MIN_IDEAL_COMMENTS = 3;

export interface DirectPostOptions {
  maxComments?: number;
  nowEpochSec?: number;
  scriptId?: string;
}

export interface LlmDirectorDraft {
  modelName: string;
  hookLines: HookLines;
  selectedCommentIds: string[];
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export interface LlmDirectorAdapter {
  generateDraft(
    post: NormalizedThreadsPost,
    maxComments: number,
  ): Promise<LlmDirectorDraft>;
}

const CUE_KEYWORD_RULES: ReadonlyArray<{
  pattern: RegExp;
  sfx: SfxSlug;
  sticker: StickerCode;
  position: VisualCueDraft['position'];
  animation: VisualCueDraft['animation'];
}> = [
  {
    pattern:
      /(?<![\p{L}\p{N}_])(?:tăng ca|đam mê|bóc lột|lương|sếp|người yêu cũ|cắm sừng|lừa)(?![\p{L}\p{N}_])/iu,
    sfx: 'vine_boom',
    sticker: 'clown',
    position: 'TOP_RIGHT',
    animation: 'POP_BOUNCE',
  },
  {
    pattern:
      /(?<![\p{L}\p{N}_])(?:chạy ngay|nghỉ việc|toang|hết cứu|bó tay|xỉu|sốc|hoang mang)(?![\p{L}\p{N}_])/iu,
    sfx: 'vine_boom',
    sticker: 'skull',
    position: 'BOTTOM_RIGHT',
    animation: 'SHAKE',
  },
  {
    pattern:
      /(?<![\p{L}\p{N}_])(?:cười|hài|buồn cười|troll|cà khịa|mắc cười|đỉnh)(?![\p{L}\p{N}_])/iu,
    sfx: 'laughter',
    sticker: 'laugh_cry',
    position: 'TOP_RIGHT',
    animation: 'POP_BOUNCE',
  },
  {
    pattern:
      /(?<![\p{L}\p{N}_])(?:cháy|cực gắt|bão|drama|nóng|khét|gắt)(?![\p{L}\p{N}_])/iu,
    sfx: 'ding',
    sticker: 'fire',
    position: 'TOP_RIGHT',
    animation: 'PULSE',
  },
];

function extractFirstWord(text: string): string {
  const match = /[\p{L}\p{N}]+/u.exec(text);
  return match ? match[0] : 'này';
}

function buildCuesForSegment(
  segmentId: string,
  kind: DirectorSegment['kind'],
  ttsText: string,
  hasImages: boolean,
  isFirstSegment: boolean,
): { audioCues: AudioCueDraft[]; visualCues: VisualCueDraft[] } {
  const audioCues: AudioCueDraft[] = [];
  const visualCues: VisualCueDraft[] = [];

  // Automatic transition SFX for comments or image cards
  if (!isFirstSegment) {
    audioCues.push({
      cueId: `${segmentId}_ac_enter`,
      sfxSlug: kind === 'COMMENT' ? 'whoosh' : 'pop',
      triggerWord: extractFirstWord(ttsText),
      volumeDb: -6,
    });
  } else if (hasImages) {
    audioCues.push({
      cueId: `${segmentId}_ac_img`,
      sfxSlug: 'pop',
      triggerWord: extractFirstWord(ttsText),
      volumeDb: -6,
    });
  }

  // Contextual SFX & Sticker Meme matched on triggerWord inside ttsText
  for (const rule of CUE_KEYWORD_RULES) {
    const match = rule.pattern.exec(ttsText);
    if (match && match[0]) {
      const triggerWord = match[0];
      audioCues.push({
        cueId: `${segmentId}_ac_ctx`,
        sfxSlug: rule.sfx,
        triggerWord,
        volumeDb: -4,
      });
      visualCues.push({
        cueId: `${segmentId}_vc_ctx`,
        stickerCode: rule.sticker,
        triggerWord,
        position: rule.position,
        animation: rule.animation,
      });
      break;
    }
  }

  return { audioCues, visualCues };
}

function buildHookLines(post: NormalizedThreadsPost): HookLines {
  const cleanSnippet = post.rawText
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleanSnippet.split(/\s+/).filter(Boolean);
  const firstLineCore =
    words.length <= 12 ? cleanSnippet : `${words.slice(0, 12).join(' ')}...`;

  const hasConflict =
    /(?<![\p{L}\p{N}_])(?:lương|sếp|ot|tăng ca|nyc|người yêu cũ|drama|cãi|tranh cãi)(?![\p{L}\p{N}_])/iu.test(
      cleanSnippet,
    );
  const emoji = hasConflict ? '🤡' : post.topReplies.length >= 3 ? '🔥' : '😳';
  const line1 = `${firstLineCore} ${emoji}`.trim();

  if (post.topReplies.length >= 3) {
    return [line1, 'Cư dân mạng phản ứng cực gắt bên dưới 💀'];
  }
  if (post.topReplies.length > 0) {
    return [line1, 'Đọc bình luận mới thấy đỉnh cao!'];
  }
  return [line1];
}

/**
 * Selects 3-5 engaging comments from topReplies:
 * prioritizes high likes, distinct authors, and varied length for dialogue pacing.
 */
export function selectBestComments(
  replies: readonly NormalizedThreadsComment[],
  maxComments: number = DEFAULT_MAX_SELECTED_COMMENTS,
): NormalizedThreadsComment[] {
  const cap = Math.max(0, Math.min(maxComments, 5));
  if (cap === 0 || replies.length === 0) {
    return [];
  }

  const sorted = [...replies].sort((a, b) => {
    const textA = a.text ?? '';
    const textB = b.text ?? '';
    const likesA = typeof a.likes === 'number' ? a.likes : 0;
    const likesB = typeof b.likes === 'number' ? b.likes : 0;
    const scoreA = likesA + (textA.length >= 15 && textA.length <= 220 ? 25 : 0);
    const scoreB = likesB + (textB.length >= 15 && textB.length <= 220 ? 25 : 0);
    return scoreB - scoreA;
  });

  const selected: NormalizedThreadsComment[] = [];
  const seenAuthors = new Set<string>();

  for (const comment of sorted) {
    if (selected.length >= cap) break;
    const authorKey = comment.authorHandle.toLowerCase();
    if (!seenAuthors.has(authorKey)) {
      selected.push(comment);
      seenAuthors.add(authorKey);
    }
  }

  // Fill remaining slots if fewer unique authors than cap
  for (const comment of sorted) {
    if (selected.length >= cap) break;
    if (!selected.some((c) => c.id === comment.id)) {
      selected.push(comment);
    }
  }

  return selected;
}

export class AIDirectorService {
  private readonly llmAdapter?: LlmDirectorAdapter;

  constructor(options?: { llmAdapter?: LlmDirectorAdapter }) {
    this.llmAdapter = options?.llmAdapter;
  }

  async direct(
    post: NormalizedThreadsPost,
    options?: DirectPostOptions,
  ): Promise<AIDirectorOutput> {
    const nowEpochSec = options?.nowEpochSec ?? Math.floor(Date.now() / 1000);
    const maxComments = Math.max(
      0,
      Math.min(options?.maxComments ?? DEFAULT_MAX_SELECTED_COMMENTS, 5),
    );

    // 1. Content Moderation Gate (ST-ERR-06) before script generation & TTS
    assertContentPolicySafe(post.rawText);

    // 2. Obtain hook lines & comment selection (LLM if configured, otherwise deterministic)
    let modelName = DEFAULT_DIRECTOR_MODEL;
    let hookLines: HookLines;
    let selectedComments: NormalizedThreadsComment[];
    let promptTokens = 0;
    let completionTokens = 0;
    let estimatedCostUsd = 0;

    if (this.llmAdapter) {
      const draft = await this.llmAdapter.generateDraft(post, maxComments);
      modelName = draft.modelName;
      hookLines = draft.hookLines;
      promptTokens = draft.promptTokens;
      completionTokens = draft.completionTokens;
      estimatedCostUsd = draft.estimatedCostUsd;

      const byId = new Map(post.topReplies.map((c) => [c.id, c]));
      selectedComments = draft.selectedCommentIds
        .map((id) => byId.get(id))
        .filter((c): c is NormalizedThreadsComment => Boolean(c))
        .slice(0, maxComments);
    } else {
      hookLines = buildHookLines(post);
      selectedComments = selectBestComments(post.topReplies, maxComments);
    }

    // Filter out any policy-violating comments cleanly
    const safeComments: NormalizedThreadsComment[] = [];
    for (const comment of selectedComments) {
      try {
        assertContentPolicySafe(comment.text);
        safeComments.push(comment);
      } catch {
        // Drop offending comment without crashing the post
      }
    }

    const segments: DirectorSegment[] = [];
    const hasPostImages = post.images.length > 0;
    const postPages = paginatePostText(post.rawText, {
      hasImages: hasPostImages,
      maxPages: 3,
    });
    const effectivePostPages =
      postPages.length > 0 ? postPages : [post.rawText.trim() || 'Bài viết trên Threads'];

    // 3. Build MAIN_POST segments (paginated if long)
    for (let i = 0; i < effectivePostPages.length; i += 1) {
      const pageText = effectivePostPages[i]!;
      const normalized = normalizeVietnameseTtsText(pageText);
      const safeTtsText =
        normalized.ttsText.length > 0 ? normalized.ttsText : 'Xem ảnh bài viết trên Threads';
      const segmentId = `post_p${i + 1}`;
      const imageIndexes =
        i === 0 ? post.images.map((_, idx) => idx).slice(0, 3) : [];
      const { audioCues, visualCues } = buildCuesForSegment(
        segmentId,
        'MAIN_POST',
        safeTtsText,
        imageIndexes.length > 0,
        i === 0,
      );

      segments.push({
        segmentId,
        kind: 'MAIN_POST',
        authorHandle: post.authorHandle,
        pageIndicator:
          effectivePostPages.length > 1
            ? { current: i + 1, total: effectivePostPages.length }
            : undefined,
        displayText: normalized.displayText,
        ttsText: safeTtsText,
        imageIndexes,
        audioCues,
        visualCues,
      });
    }

    // 4. Build COMMENT segments (paginated if comment > 280 chars)
    for (let cIdx = 0; cIdx < safeComments.length; cIdx += 1) {
      const comment = safeComments[cIdx]!;
      const commentPages = paginatePostText(comment.text, {
        hasImages: Boolean(comment.image),
        maxPages: 2,
      });
      const effectiveCommentPages =
        commentPages.length > 0 ? commentPages : [comment.text];

      for (let pIdx = 0; pIdx < effectiveCommentPages.length; pIdx += 1) {
        const pageText = effectiveCommentPages[pIdx]!;
        const normalized = normalizeVietnameseTtsText(pageText);
        const safeTtsText =
          normalized.ttsText.length > 0 ? normalized.ttsText : 'Bình luận biểu cảm';
        const segmentId = `cmt_${cIdx + 1}_p${pIdx + 1}`;
        const { audioCues, visualCues } = buildCuesForSegment(
          segmentId,
          'COMMENT',
          safeTtsText,
          Boolean(comment.image) && pIdx === 0,
          false,
        );

        segments.push({
          segmentId,
          kind: 'COMMENT',
          sourceCommentId: comment.id,
          authorHandle: comment.authorHandle,
          replyingToHandle: post.authorHandle,
          pageIndicator:
            effectiveCommentPages.length > 1
              ? { current: pIdx + 1, total: effectiveCommentPages.length }
              : undefined,
          displayText: normalized.displayText,
          ttsText: safeTtsText,
          imageIndexes: [],
          audioCues,
          visualCues,
        });
      }
    }

    // 5. Auto CTA_OUTRO when post has 0 or fewer than MIN_IDEAL_COMMENTS (ST-COM-01 / ST-COM-02)
    if (safeComments.length < MIN_IDEAL_COMMENTS) {
      const ctaDisplay =
        'Còn bạn, bạn nghĩ sao về tình huống này? Hãy để lại bình luận phía dưới! 👇';
      const ctaNorm = normalizeVietnameseTtsText(ctaDisplay);
      segments.push({
        segmentId: 'cta_outro',
        kind: 'CTA_OUTRO',
        authorHandle: post.authorHandle,
        displayText: ctaNorm.displayText,
        ttsText: ctaNorm.ttsText,
        imageIndexes: [],
        audioCues: [
          {
            cueId: 'cta_outro_ac_ding',
            sfxSlug: 'ding',
            triggerWord: extractFirstWord(ctaNorm.ttsText),
            volumeDb: -5,
          },
        ],
        visualCues: [
          {
            cueId: 'cta_outro_vc_q',
            stickerCode: 'question',
            triggerWord: extractFirstWord(ctaNorm.ttsText),
            position: 'TOP_RIGHT',
            animation: 'PULSE',
          },
        ],
      });
    }

    return AIDirectorOutputSchema.parse({
      id: options?.scriptId ?? randomUUID(),
      postId: post.id,
      modelName,
      hookLines,
      selectedCommentIds: safeComments.map((c) => c.id),
      segments,
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      createdAt: nowEpochSec,
    });
  }
}
