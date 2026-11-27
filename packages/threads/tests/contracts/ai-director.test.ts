import { describe, expect, it } from 'vitest';
import {
  AIDirectorOutputSchema,
  DEFAULT_VOICE_ID,
  EDGE_TTS_FALLBACK_VOICE_IDS,
  VIENEU_VOICE_IDS,
  VOICE_CATALOG,
  VoiceIdSchema,
  type AIDirectorOutput,
} from '../../src/contracts/index.js';

function makeValidDirectorOutput(overrides: Partial<AIDirectorOutput> = {}): AIDirectorOutput {
  return {
    id: 'script_01',
    postId: 'post_01',
    modelName: 'gemini-2.5-flash',
    hookLines: ['Đi làm lương 9tr2 mà sếp bắt OT vì đam mê 🤡', 'Cư dân mạng phản ứng cực gắt!'],
    selectedCommentIds: ['cmt_1', 'cmt_2'],
    segments: [
      {
        segmentId: 'post_p1',
        kind: 'MAIN_POST',
        authorHandle: 'uyentich19',
        pageIndicator: { current: 1, total: 1 },
        displayText: 'Lương 9tr2 ko trừ bhxh mà bắt làm tới 9h tối :))',
        ttsText: 'Lương chín triệu hai không trừ bảo hiểm xã hội mà bắt làm tới chín giờ tối',
        imageIndexes: [],
        audioCues: [{ cueId: 'ac_1', sfxSlug: 'vine_boom', triggerWord: 'tối', volumeDb: -6 }],
        visualCues: [
          {
            cueId: 'vc_1',
            stickerCode: 'clown',
            triggerWord: 'tối',
            position: 'TOP_RIGHT',
            animation: 'POP_BOUNCE',
          },
        ],
      },
      {
        segmentId: 'cmt_1_p1',
        kind: 'COMMENT',
        sourceCommentId: 'cmt_1',
        authorHandle: 'netizen_vn',
        replyingToHandle: 'uyentich19',
        displayText: 'Chạy ngay đi bạn ơi 💀',
        ttsText: 'Chạy ngay đi bạn ơi',
        imageIndexes: [],
        audioCues: [{ cueId: 'ac_2', sfxSlug: 'whoosh', triggerWord: 'Chạy' }],
        visualCues: [
          {
            cueId: 'vc_2',
            stickerCode: 'skull',
            triggerWord: 'ngay',
            position: 'BOTTOM_RIGHT',
            animation: 'SHAKE',
          },
        ],
      },
    ],
    promptTokens: 2100,
    completionTokens: 780,
    estimatedCostUsd: 0.0005,
    createdAt: 1764176400,
    ...overrides,
  };
}

describe('AI Director (No-Scoring) & VieNeu-TTS Voice Contracts', () => {
  it('validates a compliant no-scoring AIDirectorOutput payload', () => {
    const parsed = AIDirectorOutputSchema.safeParse(makeValidDirectorOutput());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('scores' in parsed.data).toBe(false);
      expect('verdict' in parsed.data).toBe(false);
    }
  });

  it('enforces hookLines max 2 lines and selectedCommentIds max 5 items', () => {
    const singleLine = makeValidDirectorOutput({ hookLines: ['Drama công sở cực căng 🔥'] });
    expect(AIDirectorOutputSchema.safeParse(singleLine).success).toBe(true);

    const tooManyComments = makeValidDirectorOutput({
      selectedCommentIds: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    });
    expect(AIDirectorOutputSchema.safeParse(tooManyComments).success).toBe(false);
  });

  it('exposes exactly 25 VieNeu-TTS voices (default Adam bựa) + 2 Edge-TTS fallbacks', () => {
    expect(VIENEU_VOICE_IDS).toHaveLength(25);
    expect(EDGE_TTS_FALLBACK_VOICE_IDS).toHaveLength(2);
    expect(VOICE_CATALOG).toHaveLength(27);
    expect(DEFAULT_VOICE_ID).toBe('Adam bựa');

    for (const voice of VIENEU_VOICE_IDS) {
      expect(VoiceIdSchema.safeParse(voice).success).toBe(true);
    }
    expect(VoiceIdSchema.safeParse('vi-VN-HoaiMyNeural').success).toBe(true);
    expect(VoiceIdSchema.safeParse('vi-VN-NamMinhNeural').success).toBe(true);
    expect(VoiceIdSchema.safeParse('UnknownVoice').success).toBe(false);
  });
});
