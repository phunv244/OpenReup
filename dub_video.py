#!/usr/bin/env python3
"""
Automatic Chinese -> Vietnamese Video Translation & Dubbing Pipeline
Specifically tuned for fast-paced Chinese fishing animations (楚新钓 / 沙雕动画):
  1. Slows source audio (e.g. 0.5x) BEFORE speech recognition so fast speech is clear
     and Vietnamese dubbing has natural breathing room.
  2. Transcribes Chinese dialogue via faster-whisper (INT8 CPU, VAD enabled).
  3. Translates to natural Vietnamese with a custom fishing-animation glossary,
     saving editable segments JSON + SRT.
  4. Synthesizes Vietnamese neural voiceover (edge-tts: NamMinh / HoaiMy) and
     time-aligns every segment without overlap.
  5. Renders final slowed video + Vietnamese voiceover (+ optional burned subtitles).

Supports two modes:
  - Full run from video:   dub_video.py --input <path> --speed 0.5 --voice vi-VN-NamMinhNeural
  - Re-dub from edited UI: dub_video.py --project <job_id>   (skips STT & translation, uses edited text!)
"""

import argparse
import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
DUB_OUT_DIR = BASE_DIR / "downloads" / "dubbed"
PROJECTS_DIR = BASE_DIR / "data" / "dub_projects"
STORY_PROJECTS_DIR = BASE_DIR / "data" / "projects"
DUBBED_INDEX_JSON = BASE_DIR / "data" / "dubbed.json"
AGY_BIN = shutil.which("agy") or "/home/phu/.local/bin/agy"

AGY_TRANSLATION_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "vi": {"type": "string"},
                },
                "required": ["id", "vi"],
            },
        },
        "episode_summary": {"type": "string"},
        "new_characters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "zh": {"type": "string"},
                    "vi": {"type": "string"},
                    "role": {"type": "string"},
                    "pronouns": {"type": "string"},
                },
                "required": ["zh", "vi"],
            },
        },
        "new_glossary": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "zh": {"type": "string"},
                    "vi": {"type": "string"},
                },
                "required": ["zh", "vi"],
            },
        },
    },
    "required": ["translations", "episode_summary", "new_characters", "new_glossary"],
}


def log(msg: str) -> None:
    print(msg, flush=True)


def run_cmd(cmd: List[str], nice: int = 10) -> None:
    full_cmd = ["nice", "-n", str(nice)] + cmd if nice > 0 else cmd
    proc = subprocess.run(full_cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Lệnh lỗi ({' '.join(cmd[:4])}): {proc.stderr[-600:]}")


def probe_media(path: Path) -> Dict:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height:format=duration",
            "-of",
            "json",
            str(path),
        ],
        text=True,
    )
    data = json.loads(out)
    w, h, has_audio = 1280, 720, False
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            w = int(s.get("width") or w)
            h = int(s.get("height") or h)
        elif s.get("codec_type") == "audio":
            has_audio = True
    dur = float(data.get("format", {}).get("duration") or 0.0)
    return {"w": w, "h": h, "duration": dur, "has_audio": has_audio}


def build_atempo_chain(speed: float) -> str:
    """Build chained atempo filters for arbitrary speed in [0.25, 2.0]."""
    filters = []
    rem = speed
    while rem < 0.5:
        filters.append("atempo=0.5")
        rem /= 0.5
    while rem > 2.0:
        filters.append("atempo=2.0")
        rem /= 2.0
    filters.append(f"atempo={rem:.4f}")
    return ",".join(filters)


def extract_slowed_wav(input_mp4: Path, out_wav: Path, speed: float) -> None:
    atempo = build_atempo_chain(speed)
    log(f"[1/5] Làm chậm âm thanh về {speed}x & tách WAV 16kHz ({atempo})...")
    run_cmd(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(input_mp4),
            "-vn",
            "-af",
            atempo,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ]
    )


def load_story_context(project_id: str) -> Dict:
    if not project_id:
        return {}
    p = STORY_PROJECTS_DIR / f"{Path(project_id).name}.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def transcribe_chinese(
    wav_path: Path,
    stt_speed: float = 0.5,
    model_size: str = "small",
    story_ctx: Optional[Dict] = None,
) -> List[Dict]:
    import numpy as np
    from faster_whisper import WhisperModel

    ctx_names = []
    if story_ctx:
        for ch in story_ctx.get("characters", []):
            if ch.get("zh"):
                ctx_names.append(ch["zh"])
        for g in story_ctx.get("glossary", [])[:8]:
            if g.get("zh"):
                ctx_names.append(g["zh"])
    prompt = ("普通话对白：" + "，".join(ctx_names)) if ctx_names else "钓鱼动画楚新钓普通话对白"

    log(f"[2/5] Nhận diện lời thoại trên âm thanh chậm {stt_speed}x rồi quy đổi mốc giờ về tốc độ gốc 1.0x (model={model_size})...")
    with wave.open(str(wav_path), "rb") as wf:
        pcm_bytes = wf.readframes(wf.getnframes())
    audio_np = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=6)
    segments_iter, info = model.transcribe(
        audio_np,
        language="zh",
        initial_prompt=prompt,
        beam_size=4,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 280},
    )

    # Map timestamps from slowed audio back to ORIGINAL 1.0x video timeline (* stt_speed)
    raw_words = []
    for seg in segments_iter:
        if seg.words:
            for w in seg.words:
                raw_words.append({"w": w.word, "s": float(w.start) * stt_speed, "e": float(w.end) * stt_speed})
        elif (seg.text or "").strip():
            raw_words.append({"w": seg.text.strip(), "s": float(seg.start) * stt_speed, "e": float(seg.end) * stt_speed})

    segments = []
    buf_text = ""
    buf_start = None
    buf_end = 0.0

    def flush_clause():
        nonlocal buf_text, buf_start, buf_end
        clean = buf_text.strip(" ，,、")
        if clean and buf_start is not None:
            idx = len(segments) + 1
            segments.append({
                "id": idx,
                "start": round(buf_start, 2),
                "end": round(max(buf_start + 0.3, buf_end), 2),
                "zh": clean,
                "vi": "",
            })
            log(f"  [STT #{idx:02d} @ 1.0x] {buf_start:6.2f}s -> {buf_end:6.2f}s | {clean}")
        buf_text = ""
        buf_start = None

    for i, item in enumerate(raw_words):
        if buf_start is None:
            buf_start = item["s"]
        buf_text += item["w"]
        buf_end = item["e"]
        gap_after = (raw_words[i + 1]["s"] - item["e"]) if i + 1 < len(raw_words) else 9.0
        has_end_punct = bool(re.search(r"[。！？!?；;]$", buf_text.strip()))
        has_comma = bool(re.search(r"[，,]$", buf_text.strip()))
        dur = buf_end - buf_start
        if has_end_punct or gap_after >= 0.25 or (has_comma and len(buf_text) >= 10) or dur >= 3.8 or len(buf_text) >= 18:
            flush_clause()
    flush_clause()

    log(f"[2/5] Tách được {len(segments)} câu thoại (đã quy chuẩn về tốc độ gốc 1.0x).")
    return segments


def merge_story_memory(project_id: str, job_id: str, ai_out: Dict) -> None:
    """Auto-save newly discovered characters, glossary terms, and episode summary into the Project."""
    if not project_id:
        return
    p = STORY_PROJECTS_DIR / f"{Path(project_id).name}.json"
    if not p.exists():
        return
    try:
        proj = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return

    chars = proj.get("characters") or []
    existing_char_zh = {c.get("zh", "").strip() for c in chars}
    added_chars = 0
    for nc in ai_out.get("new_characters") or []:
        zh = (nc.get("zh") or "").strip()
        vi = (nc.get("vi") or "").strip()
        if zh and vi and zh not in existing_char_zh:
            chars.append({
                "zh": zh,
                "vi": vi,
                "role": (nc.get("role") or "").strip(),
                "pronouns": (nc.get("pronouns") or "").strip(),
            })
            existing_char_zh.add(zh)
            added_chars += 1
    proj["characters"] = chars

    gloss = proj.get("glossary") or []
    existing_gloss_zh = {g.get("zh", "").strip() for g in gloss}
    added_gloss = 0
    for ng in ai_out.get("new_glossary") or []:
        zh = (ng.get("zh") or "").strip()
        vi = (ng.get("vi") or "").strip()
        if zh and vi and zh not in existing_gloss_zh:
            gloss.append({"zh": zh, "vi": vi})
            existing_gloss_zh.add(zh)
            added_gloss += 1
    proj["glossary"] = gloss

    ep_summary = (ai_out.get("episode_summary") or "").strip()
    if ep_summary:
        notes = proj.get("episode_notes") or {}
        notes[job_id] = ep_summary
        proj["episode_notes"] = notes

    proj["updated_at"] = datetime.now().isoformat(timespec="seconds")
    p.write_text(json.dumps(proj, ensure_ascii=False, indent=2), encoding="utf-8")
    log(
        f"[Dự án] Antigravity đã tự cập nhật bộ nhớ dự án '{proj.get('name')}': "
        f"+{added_chars} nhân vật mới, +{added_gloss} thuật ngữ mới, đã lưu tóm tắt tập."
    )


def translate_with_antigravity(
    segments: List[Dict],
    story_ctx: Dict,
    project_id: str,
    job_id: str,
) -> List[Dict]:
    if not segments:
        return segments
    if not Path(AGY_BIN).exists():
        raise RuntimeError(f"Không tìm thấy Antigravity CLI tại {AGY_BIN}")

    log(f"[3/5] Đang chạy Antigravity AI (agy) để dịch {len(segments)} câu theo ngữ cảnh dự án...")

    ctx_block = "Không có dự án cụ thể (hãy tự suy luận bối cảnh từ lời thoại)."
    if story_ctx:
        chars_txt = "\n".join(
            f"- {c.get('zh')} -> {c.get('vi')} ({c.get('role', '')}; xưng hô: {c.get('pronouns', '')})"
            for c in (story_ctx.get("characters") or [])
        )
        gloss_txt = "\n".join(
            f"- {g.get('zh')} -> {g.get('vi')}"
            for g in (story_ctx.get("glossary") or [])
        )
        ep_notes = story_ctx.get("episode_notes") or {}
        recent_notes = "\n".join(f"- {k}: {v}" for k, v in list(ep_notes.items())[-5:])
        ctx_block = (
            f"Tên dự án: {story_ctx.get('name', '')} ({story_ctx.get('type', '')})\n"
            f"Phong cách dịch: {story_ctx.get('style', '')}\n"
            f"Cốt truyện chung: {story_ctx.get('synopsis', '')}\n"
            f"Nhân vật & Xưng hô:\n{chars_txt or '(chưa có)'}\n"
            f"Từ điển thuật ngữ:\n{gloss_txt or '(chưa có)'}\n"
            f"Tóm tắt các tập gần nhất:\n{recent_notes or '(chưa có)'}"
        )

    # Translate in chunks of up to 45 segments to keep prompts fast & accurate
    all_new_chars = []
    all_new_gloss = []
    summaries = []
    chunk_size = 45

    for start_idx in range(0, len(segments), chunk_size):
        chunk = segments[start_idx : start_idx + chunk_size]
        seg_payload = json.dumps(
            [{"id": s["id"], "start": s["start"], "end": s["end"], "zh": s["zh"]} for s in chunk],
            ensure_ascii=False,
        )
        prompt = (
            "Bạn là biên dịch viên lồng tiếng phim/hoạt hình chuyên nghiệp. "
            "KHÔNG sử dụng bất kỳ tool nào, chỉ trả về đúng JSON theo schema.\n\n"
            f"=== NGỮ CẢNH DỰ ÁN ===\n{ctx_block}\n\n"
            "=== NHIỆM VỤ ===\n"
            "1. Đọc kỹ các câu thoại tiếng Trung do Whisper tách bên dưới (có thể bị nghe nhầm đồng âm, "
            "ví dụ 楚依旧->除意就, 老骨头->脑骨头, 出发->扶发, 去钓->去掉). Hãy tự sửa lỗi nghe nhầm dựa vào ngữ cảnh!\n"
            "2. Dịch sang tiếng Việt thật tự nhiên, ngắn gọn, súc tích để đọc lồng tiếng khớp tốc độ gốc 1.0x, đúng xưng hô.\n"
            "3. Trả về đúng đủ số lượng 'id' trong mảng 'translations'.\n"
            "4. Viết 'episode_summary' (1-2 câu tóm tắt diễn biến đoạn này để giữ mạch truyện).\n"
            "5. Nếu có nhân vật mới hoặc thuật ngữ mới quan trọng chưa có trong ngữ cảnh trên, điền vào 'new_characters' / 'new_glossary' (nếu không có thì để mảng rỗng []).\n\n"
            f"=== LỜI THOẠI CẦN DỊCH ===\n{seg_payload}"
        )

        proc = subprocess.run(
            [
                AGY_BIN,
                "--disable-slash-commands",
                "--effort",
                "low",
                "--output-format",
                "json",
                "--json-schema",
                json.dumps(AGY_TRANSLATION_SCHEMA, ensure_ascii=False),
                "-p",
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Antigravity CLI lỗi (code {proc.returncode}): {(proc.stderr or proc.stdout)[-400:]}")

        raw_out = proc.stdout.strip()
        parsed_wrapper = json.loads(raw_out)
        ai_out = parsed_wrapper.get("structured_output")
        if not ai_out:
            ai_out = json.loads(parsed_wrapper.get("response", "{}"))

        vi_map = {int(item["id"]): (item.get("vi") or "").strip() for item in (ai_out.get("translations") or [])}
        for seg in chunk:
            seg["vi"] = vi_map.get(seg["id"]) or seg["zh"]
            log(f"  [Antigravity #{seg['id']:02d}] {seg['vi']}")

        if ai_out.get("episode_summary"):
            summaries.append(ai_out["episode_summary"].strip())
        all_new_chars.extend(ai_out.get("new_characters") or [])
        all_new_gloss.extend(ai_out.get("new_glossary") or [])

    if project_id:
        merge_story_memory(
            project_id,
            job_id,
            {
                "episode_summary": " ".join(summaries),
                "new_characters": all_new_chars,
                "new_glossary": all_new_gloss,
            },
        )
    return segments


def fmt_srt_time(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1000
    ms %= 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments: List[Dict], srt_path: Path) -> None:
    lines = []
    for idx, seg in enumerate(segments, start=1):
        txt = (seg.get("vi") or seg.get("zh") or "").strip()
        if not txt:
            continue
        lines.append(f"{idx}")
        lines.append(f"{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}")
        lines.append(txt)
        lines.append("")
    srt_path.write_text("\n".join(lines), encoding="utf-8")


def google_tts_fallback(text: str, mp3_path: Path, is_male: bool) -> bool:
    import requests

    # Split text into <= 180 char chunks if needed
    chunks = [text[i : i + 180] for i in range(0, len(text), 180)] or [text]
    raw_mp3 = mp3_path.with_suffix(".gtts_raw.mp3")
    with raw_mp3.open("wb") as f:
        for ch in chunks:
            r = requests.get(
                "https://translate.googleapis.com/translate_tts",
                params={"ie": "UTF-8", "tl": "vi", "client": "tw-ob", "q": ch},
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=12,
            )
            if r.status_code == 200 and len(r.content) > 200:
                f.write(r.content)
    if not raw_mp3.exists() or raw_mp3.stat().st_size < 200:
        return False

    if is_male:
        # Deeper male storyteller tone while keeping crisp tempo
        run_cmd(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(raw_mp3),
                "-af",
                "asetrate=24000*0.86,aresample=24000,atempo=1.22",
                str(mp3_path),
            ],
            nice=5,
        )
        raw_mp3.unlink(missing_ok=True)
    else:
        run_cmd(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(raw_mp3),
                "-af",
                "atempo=1.10",
                str(mp3_path),
            ],
            nice=5,
        )
        raw_mp3.unlink(missing_ok=True)
    return mp3_path.exists() and mp3_path.stat().st_size > 200


async def synthesize_tts_segments(
    segments: List[Dict],
    voice: str,
    tts_rate: str,
    tmp_dir: Path,
) -> List[Optional[Path]]:
    import edge_tts

    sem = asyncio.Semaphore(3)
    results: List[Optional[Path]] = [None] * len(segments)
    is_male = "NamMinh" in (voice or "")
    edge_broken = False

    async def worker(idx: int, seg: Dict) -> None:
        nonlocal edge_broken
        text = (seg.get("vi") or "").strip()
        if not text:
            return
        mp3_path = tmp_dir / f"seg_{idx:04d}.mp3"
        async with sem:
            if not edge_broken:
                try:
                    comm = edge_tts.Communicate(text=text, voice=voice, rate=tts_rate)
                    await comm.save(str(mp3_path))
                    if mp3_path.exists() and mp3_path.stat().st_size > 200:
                        results[idx] = mp3_path
                        return
                except Exception:
                    edge_broken = True

            # Reliable fallback to Google Vietnamese TTS
            ok = await asyncio.to_thread(google_tts_fallback, text, mp3_path, is_male)
            if ok:
                results[idx] = mp3_path
            else:
                log(f"  [Warn] Không tạo được âm thanh cho câu #{seg['id']}")

    await asyncio.gather(*(worker(i, s) for i, s in enumerate(segments)))
    return results


def wav_duration(wav_path: Path) -> float:
    with wave.open(str(wav_path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def build_aligned_dub_track(
    segments: List[Dict],
    mp3_files: List[Optional[Path]],
    total_duration: float,
    out_wav: Path,
    tmp_dir: Path,
) -> None:
    sample_rate = 24000
    total_samples = int(math.ceil((total_duration + 1.5) * sample_rate))
    timeline = bytearray(total_samples * 2)  # 16-bit mono PCM initialized to silence

    for i, (seg, mp3_path) in enumerate(zip(segments, mp3_files)):
        if not mp3_path or not mp3_path.exists():
            continue

        raw_wav = tmp_dir / f"seg_{i:04d}_raw.wav"
        run_cmd(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(mp3_path),
                # Trim leading/trailing silence generated by TTS
                "-af",
                "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB",
                "-ar",
                str(sample_rate),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(raw_wav),
            ],
            nice=5,
        )
        if not raw_wav.exists():
            continue

        clip_dur = wav_duration(raw_wav)
        next_start = segments[i + 1]["start"] if i + 1 < len(segments) else total_duration
        slot_dur = max(0.35, next_start - seg["start"] - 0.03)

        use_wav = raw_wav
        if clip_dur > slot_dur * 1.02:
            # Speed up Vietnamese clip cleanly (up to 1.95x review-anime style) so it fits original 1.0x video timing!
            ratio = min(1.95, clip_dur / slot_dur)
            fit_wav = tmp_dir / f"seg_{i:04d}_fit.wav"
            run_cmd(
                [
                    "ffmpeg",
                    "-y",
                    "-loglevel",
                    "error",
                    "-i",
                    str(raw_wav),
                    "-af",
                    build_atempo_chain(ratio),
                    "-ar",
                    str(sample_rate),
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(fit_wav),
                ],
                nice=5,
            )
            if fit_wav.exists():
                use_wav = fit_wav

        with wave.open(str(use_wav), "rb") as wf:
            pcm = wf.readframes(wf.getnframes())

        start_sample = max(0, int(seg["start"] * sample_rate))
        byte_offset = start_sample * 2
        end_byte = min(len(timeline), byte_offset + len(pcm))
        if end_byte > byte_offset:
            timeline[byte_offset:end_byte] = pcm[: end_byte - byte_offset]

    with wave.open(str(out_wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(timeline)


def escape_subtitles_path(p: Path) -> str:
    s = str(p.resolve())
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def render_final_video(
    input_mp4: Path,
    dub_wav: Path,
    srt_path: Path,
    out_mp4: Path,
    bg_volume: float,
    burn_sub: bool,
    has_orig_audio: bool,
) -> None:
    """Render output at ORIGINAL 1.0x video speed!"""
    vf_str = ""
    if burn_sub and srt_path.exists() and srt_path.stat().st_size > 0:
        esc_srt = escape_subtitles_path(srt_path)
        vf_str = (
            f"subtitles='{esc_srt}':force_style='FontName=DejaVu Sans,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H22000000,BackColour=&H22000000,BorderStyle=3,Outline=5,Shadow=0,MarginV=18'"
        )

    cmd = ["ffmpeg", "-y", "-loglevel", "warning", "-stats", "-i", str(input_mp4), "-i", str(dub_wav)]

    if bg_volume > 0.001 and has_orig_audio:
        af_complex = (
            f"[0:a]volume={bg_volume:.3f}[bg];"
            f"[1:a]volume=1.35[vo];"
            f"[bg][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        if vf_str:
            cmd += ["-filter_complex", f"[0:v]{vf_str}[vout];{af_complex}", "-map", "[vout]", "-map", "[aout]"]
        else:
            cmd += ["-filter_complex", af_complex, "-map", "0:v:0", "-map", "[aout]"]
    else:
        if vf_str:
            cmd += ["-vf", vf_str, "-map", "0:v:0", "-map", "1:a:0"]
        else:
            cmd += ["-map", "0:v:0", "-map", "1:a:0"]

    if vf_str:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-threads", "6"]
    else:
        # No subtitle burn -> stream copy original video in 1 second with 0 quality loss!
        cmd += ["-c:v", "copy"]

    cmd += [
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(out_mp4),
    ]
    log(f"[5/5] Đang trả về tốc độ gốc 1.0x & ghép lồng tiếng Việt (phụ đề={'BẬT' if burn_sub else 'TẮT - Copy gốc siêu nhanh'})...")
    run_cmd(cmd, nice=12)


def update_dubbed_index(entry: Dict) -> None:
    DUBBED_INDEX_JSON.parent.mkdir(parents=True, exist_ok=True)
    items = []
    if DUBBED_INDEX_JSON.exists():
        try:
            items = json.loads(DUBBED_INDEX_JSON.read_text(encoding="utf-8")).get("videos", [])
        except Exception:
            items = []
    by_id = {x["job_id"]: x for x in items if "job_id" in x}
    by_id[entry["job_id"]] = entry
    merged = sorted(by_id.values(), key=lambda x: x.get("updated_at", ""), reverse=True)
    DUBBED_INDEX_JSON.write_text(
        json.dumps({"updated_at": datetime.now().isoformat(timespec="seconds"), "total": len(merged), "videos": merged}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Dịch & Lồng tiếng Việt tự động cho video tiếng Trung")
    parser.add_argument("--input", help="Đường dẫn file MP4 gốc")
    parser.add_argument("--project", help="Job ID có sẵn để render lại sau khi sửa bản dịch")
    parser.add_argument("--story-project", default="", help="ID Dự án truyện/phim (data/projects/<id>.json)")
    parser.add_argument("--speed", type=float, default=0.5, help="Tốc độ làm chậm video (mặc định 0.5)")
    parser.add_argument("--voice", default="vi-VN-NamMinhNeural", help="Giọng đọc edge-tts")
    parser.add_argument("--tts-rate", default="+5%", help="Tốc độ đọc TTS mặc định (vd: +0%%, +10%%)")
    parser.add_argument("--model", default="small", help="Whisper model: tiny | base | small")
    parser.add_argument("--bg-volume", type=float, default=0.06, help="Âm lượng âm thanh gốc giữ lại (0.0 = tắt hẳn)")
    parser.add_argument("--no-sub", action="store_true", help="Không in cứng phụ đề tiếng Việt lên video")
    args = parser.parse_args()

    DUB_OUT_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

    if args.project:
        proj_path = PROJECTS_DIR / f"{args.project}.json"
        if not proj_path.exists():
            raise RuntimeError(f"Không tìm thấy project: {proj_path}")
        proj = json.loads(proj_path.read_text(encoding="utf-8"))
        job_id = proj["job_id"]
        input_mp4 = Path(proj["input_path"])
        speed = float(proj.get("speed", args.speed))
        voice = args.voice or proj.get("voice", "vi-VN-NamMinhNeural")
        bg_volume = args.bg_volume if "--bg-volume" in sys.argv else float(proj.get("bg_volume", 0.06))
        burn_sub = not args.no_sub if "--no-sub" in sys.argv else bool(proj.get("burn_sub", True))
        story_project_id = proj.get("project_id", args.story_project or "")
        segments = proj.get("segments", [])
        log(f"[Re-render] Đọc {len(segments)} câu đã chỉnh sửa từ project {job_id}...")
    else:
        if not args.input:
            raise RuntimeError("Cần truyền --input <mp4> hoặc --project <job_id>")
        input_mp4 = Path(args.input).resolve()
        if not input_mp4.exists():
            raise RuntimeError(f"Không tìm thấy video đầu vào: {input_mp4}")
        speed = max(0.25, min(1.5, args.speed))
        voice = args.voice
        bg_volume = args.bg_volume
        burn_sub = not args.no_sub
        story_project_id = args.story_project or ""
        stem = re.sub(r"[^0-9a-zA-Z_-]+", "_", input_mp4.stem)[:32].strip("_") or "video"
        job_id = f"dub_{stem}_{str(speed).replace('.', 'p')}x"
        proj = None
        segments = []

    story_ctx = load_story_context(story_project_id)
    if story_ctx:
        log(f"[Dự án] Đã nạp ngữ cảnh: {story_ctx.get('name')} ({len(story_ctx.get('characters', []))} nhân vật, {len(story_ctx.get('glossary', []))} từ điển)")

    media = probe_media(input_mp4)
    orig_duration = media["duration"]

    out_mp4 = DUB_OUT_DIR / f"{job_id}.mp4"
    out_srt = DUB_OUT_DIR / f"{job_id}.srt"
    proj_path = PROJECTS_DIR / f"{job_id}.json"

    with tempfile.TemporaryDirectory(prefix="dub_work_") as tmp:
        tmp_dir = Path(tmp)

        if not args.project:
            if not media["has_audio"]:
                raise RuntimeError("Video này không có luồng âm thanh!")
            slow_wav = tmp_dir / "slow_16k.wav"
            extract_slowed_wav(input_mp4, slow_wav, speed)
            segments = transcribe_chinese(slow_wav, stt_speed=speed, model_size=args.model, story_ctx=story_ctx)
            segments = translate_with_antigravity(segments, story_ctx, story_project_id, job_id)

        write_srt(segments, out_srt)

        proj_data = {
            "job_id": job_id,
            "project_id": story_project_id,
            "title": input_mp4.name,
            "input_path": str(input_mp4),
            "speed": speed,
            "voice": voice,
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "orig_duration_sec": round(orig_duration, 1),
            "dub_duration_sec": round(orig_duration, 1),
            "resolution": f"{media['w']}x{media['h']}",
            "segments": segments,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        proj_path.write_text(json.dumps(proj_data, ensure_ascii=False, indent=2), encoding="utf-8")

        log(f"[4/5] Tạo giọng đọc tiếng Việt ({voice}) & khớp về tốc độ gốc 1.0x cho {len(segments)} câu...")
        mp3_files = asyncio.run(synthesize_tts_segments(segments, voice, args.tts_rate, tmp_dir))
        dub_wav = tmp_dir / "dub_aligned.wav"
        build_aligned_dub_track(segments, mp3_files, orig_duration, dub_wav, tmp_dir)

        render_final_video(
            input_mp4=input_mp4,
            dub_wav=dub_wav,
            srt_path=out_srt,
            out_mp4=out_mp4,
            bg_volume=bg_volume,
            burn_sub=burn_sub,
            has_orig_audio=media["has_audio"],
        )

    size_mb = round(out_mp4.stat().st_size / (1024 * 1024), 2)
    summary = {
        "job_id": job_id,
        "project_id": story_project_id,
        "title": input_mp4.name,
        "speed": speed,
        "voice": voice,
        "bg_volume": bg_volume,
        "burn_sub": burn_sub,
        "segment_count": len(segments),
        "duration_sec": round(orig_duration),
        "resolution": f"{media['w']}x{media['h']}",
        "size_mb": size_mb,
        "mp4_file": out_mp4.name,
        "srt_file": out_srt.name,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }
    update_dubbed_index(summary)
    log(f"[HOÀN TẤT] Đã xuất bản lồng tiếng: {out_mp4.name} ({size_mb} MB | {len(segments)} câu thoại)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"[Lỗi] {exc}")
        sys.exit(1)
