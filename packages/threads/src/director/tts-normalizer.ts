export interface TtsReplacementRecord {
  from: string;
  to: string;
  category: 'currency' | 'date' | 'time' | 'measure' | 'percent' | 'slang' | 'emoji_strip';
}

export interface NormalizedTtsResult {
  displayText: string;
  ttsText: string;
  replacements: TtsReplacementRecord[];
}

const DIGITS = [
  'không',
  'một',
  'hai',
  'ba',
  'bốn',
  'năm',
  'sáu',
  'bảy',
  'tám',
  'chín',
] as const;

export function numberToVietnameseWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return String(n);
  }
  const num = Math.floor(n);
  if (num < 10) {
    return DIGITS[num]!;
  }
  if (num < 20) {
    const unit = num % 10;
    if (unit === 0) return 'mười';
    if (unit === 5) return 'mười lăm';
    return `mười ${DIGITS[unit]!}`;
  }
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const unit = num % 10;
    if (unit === 0) return `${DIGITS[tens]!} mươi`;
    if (unit === 1) return `${DIGITS[tens]!} mươi mốt`;
    if (unit === 4) return `${DIGITS[tens]!} mươi tư`;
    if (unit === 5) return `${DIGITS[tens]!} mươi lăm`;
    return `${DIGITS[tens]!} mươi ${DIGITS[unit]!}`;
  }
  if (num < 1000) {
    const hundreds = Math.floor(num / 100);
    const rest = num % 100;
    if (rest === 0) return `${DIGITS[hundreds]!} trăm`;
    if (rest < 10) return `${DIGITS[hundreds]!} trăm linh ${DIGITS[rest]!}`;
    return `${DIGITS[hundreds]!} trăm ${numberToVietnameseWords(rest)}`;
  }
  if (num < 10000) {
    const thousands = Math.floor(num / 1000);
    const rest = num % 1000;
    if (rest === 0) return `${DIGITS[thousands]!} nghìn`;
    if (rest < 10) return `${DIGITS[thousands]!} nghìn không trăm linh ${DIGITS[rest]!}`;
    if (rest < 100) return `${DIGITS[thousands]!} nghìn không trăm ${numberToVietnameseWords(rest)}`;
    return `${DIGITS[thousands]!} nghìn ${numberToVietnameseWords(rest)}`;
  }
  return String(num);
}

/**
 * Vietnamese social media slang, teencode, and abbreviation dictionary.
 * Ordered by specificity; matched on Unicode word boundaries.
 */
export const VN_SLANG_DICTIONARY: Readonly<Record<string, string>> = {
  bhxh: 'bảo hiểm xã hội',
  bhyt: 'bảo hiểm y tế',
  bhtn: 'bảo hiểm thất nghiệp',
  tncn: 'thu nhập cá nhân',
  cccd: 'căn cước công dân',
  cmnd: 'chứng minh nhân dân',
  cmts: 'bình luận',
  cmt: 'bình luận',
  nhma: 'nhưng mà',
  nm: 'nhưng mà',
  nyc: 'người yêu cũ',
  ny: 'người yêu',
  nvien: 'nhân viên',
  nv: 'nhân viên',
  ngta: 'người ta',
  mng: 'mọi người',
  mn: 'mọi người',
  ntn: 'như thế nào',
  kbt: 'không biết',
  kb: 'không biết',
  ko: 'không',
  khg: 'không',
  kh: 'không',
  hok: 'không',
  k: 'không',
  dc: 'được',
  đc: 'được',
  vs: 'với',
  cx: 'cũng',
  đag: 'đang',
  dg: 'đang',
  bth: 'bình thường',
  qtqđ: 'quá trời quá đất',
  ot: 'tăng ca',
  kpi: 'ca pê i',
  cv: 'công việc',
  gđ: 'gia đình',
  gd: 'gia đình',
  trc: 'trước',
  mik: 'mình',
  mk: 'mình',
  sp: 'sản phẩm',
  ib: 'nhắn tin riêng',
  rep: 'trả lời',
  ad: 'quản trị viên',
  t: 'tôi',
  m: 'mày',
  r: 'rồi',
  j: 'gì',
};

const SLANG_KEYS = Object.keys(VN_SLANG_DICTIONARY).sort((a, b) => b.length - a.length);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SLANG_REGEX = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${SLANG_KEYS.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`,
  'giu',
);

// Matches ASCII laugh/emoticons like :)), :))), =))), =]]], ^^, :v, :(, :<, :))
const ASCII_EMOTICON_REGEX = /(?::\)+|=\)+|=\]+|:\(+|:<|\^\^|:v\b|;-?\))/gi;

// Matches Unicode emoji & pictographs so VieNeu-TTS never stumbles on symbols
const UNICODE_EMOJI_REGEX =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)+/gu;

/**
 * Normalizes Vietnamese Threads text into natural spoken Vietnamese for `VieNeu-TTS`
 * while preserving 100% of the original `displayText` for UI rendering.
 */
export function normalizeVietnameseTtsText(rawText: string): NormalizedTtsResult {
  const displayText = rawText;
  const replacements: TtsReplacementRecord[] = [];
  let text = rawText;

  // 1. Dates: dd/mm/yyyy or dd/mm (only valid calendar day 1..31, month 1..12)
  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\p{L}\p{N}])/gu,
    (match, dStr: string, mStr: string, yStr: string | undefined) => {
      const day = Number(dStr);
      const month = Number(mStr);
      if (day < 1 || day > 31 || month < 1 || month > 12) {
        return match;
      }
      const spokenDay = numberToVietnameseWords(day);
      const spokenMonth = numberToVietnameseWords(month);
      const spoken = yStr
        ? `ngày ${spokenDay} tháng ${spokenMonth} năm ${numberToVietnameseWords(Number(yStr))}`
        : `ngày ${spokenDay} tháng ${spokenMonth}`;
      replacements.push({ from: match, to: spoken, category: 'date' });
      return spoken;
    },
  );

  // 2. Currency shorthand: 9tr2 -> chín triệu hai, 15tr -> mười lăm triệu, 500k -> năm trăm nghìn
  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,4})\s*(tr|triệu|trieu)\s*(\d{1,2})?(?![\p{L}\p{N}])/giu,
    (match, wholeStr: string, _unit: string, fracStr: string | undefined) => {
      const whole = Number(wholeStr);
      const base = `${numberToVietnameseWords(whole)} triệu`;
      const spoken = fracStr ? `${base} ${numberToVietnameseWords(Number(fracStr))}` : base;
      replacements.push({ from: match, to: spoken, category: 'currency' });
      return spoken;
    },
  );

  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,4})\s*k(?![\p{L}\p{N}])/giu,
    (match, numStr: string) => {
      const spoken = `${numberToVietnameseWords(Number(numStr))} nghìn`;
      replacements.push({ from: match, to: spoken, category: 'currency' });
      return spoken;
    },
  );

  // 3. Height / measure shorthand: 2m5 -> hai mét rưỡi, 1m75 -> một mét bảy mươi lăm
  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,2})m(\d{1,2})(?![\p{L}\p{N}])/giu,
    (match, wholeStr: string, fracStr: string) => {
      const whole = numberToVietnameseWords(Number(wholeStr));
      const spoken =
        fracStr === '5'
          ? `${whole} mét rưỡi`
          : `${whole} mét ${numberToVietnameseWords(Number(fracStr))}`;
      replacements.push({ from: match, to: spoken, category: 'measure' });
      return spoken;
    },
  );

  // 4. Time shorthand: 9h30 -> chín giờ ba mươi, 9h -> chín giờ
  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,2})h(\d{1,2})?(?![\p{L}\p{N}])/giu,
    (match, hourStr: string, minStr: string | undefined) => {
      const hour = Number(hourStr);
      if (hour > 24) return match;
      const base = `${numberToVietnameseWords(hour)} giờ`;
      const spoken =
        minStr && Number(minStr) > 0
          ? `${base} ${numberToVietnameseWords(Number(minStr))}`
          : base;
      replacements.push({ from: match, to: spoken, category: 'time' });
      return spoken;
    },
  );

  // 5. Percentages: 100% -> một trăm phần trăm
  text = text.replace(
    /(?<![\p{L}\p{N}])(\d{1,4})\s*%/gu,
    (match, numStr: string) => {
      const spoken = `${numberToVietnameseWords(Number(numStr))} phần trăm`;
      replacements.push({ from: match, to: spoken, category: 'percent' });
      return spoken;
    },
  );

  // 6. Vietnamese social media slang & teencode dictionary
  text = text.replace(SLANG_REGEX, (match) => {
    const key = match.toLowerCase();
    const mapped = VN_SLANG_DICTIONARY[key];
    if (!mapped) {
      return match;
    }
    replacements.push({ from: match, to: mapped, category: 'slang' });
    return mapped;
  });

  // 7. Strip ASCII emoticons & Unicode emojis from spoken TTS text
  text = text.replace(ASCII_EMOTICON_REGEX, (match) => {
    replacements.push({ from: match, to: '', category: 'emoji_strip' });
    return ' ';
  });

  text = text.replace(UNICODE_EMOJI_REGEX, (match) => {
    replacements.push({ from: match, to: '', category: 'emoji_strip' });
    return ' ';
  });

  // 8. Clean up redundant whitespace & punctuation spacing
  const ttsText = text
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    displayText,
    ttsText,
    replacements,
  };
}
