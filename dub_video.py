#!/usr/bin/env python3
"""
Dịch & lồng tiếng Việt tự động cho video tiếng Trung — chạy được với video 9, 10, 90 tiếng.

Thiết kế cho video siêu dài:
  - Không bao giờ nạp cả video / cả track âm thanh vào RAM: mọi thứ xử lý theo KHỐI ~10 phút.
  - Mỗi khối xong là ghi checkpoint xuống data/dub_work/<job_id>/ -> dừng, mất điện, lỗi mạng
    thì chạy lại sẽ TIẾP TỤC đúng chỗ đang dở chứ không làm lại từ đầu.
  - Nhận diện (CPU) chạy song song với dịch (Antigravity) và tạo giọng đọc (TTS) ở luồng nền.
  - Giọng đọc được cache theo nội dung câu; video in phụ đề được xuất theo từng phần 10 phút
    và cache theo nội dung phụ đề -> "Sửa lời & Xuất lại" chỉ làm lại đúng phần bị sửa.

Hai chế độ:
  - Chạy mới / tiếp tục:  dub_video.py --input <mp4> --speed 0.5 --voice vi-VN-NamMinhNeural
  - Xuất lại sau khi sửa: dub_video.py --project <job_id>   (bỏ qua nhận diện & dịch)
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
DUB_OUT_DIR = BASE_DIR / "downloads" / "dubbed"
PROJECTS_DIR = BASE_DIR / "data" / "dub_projects"
STORY_PROJECTS_DIR = BASE_DIR / "data" / "projects"
DUBBED_INDEX_JSON = BASE_DIR / "data" / "dubbed.json"
WORK_ROOT = BASE_DIR / "data" / "dub_work"
AGY_BIN = shutil.which("agy") or "/home/phu/.local/bin/agy"

SAMPLE_RATE = 24000  # track lồng tiếng: PCM 16-bit mono
STT_PAD_SEC = 30.0  # giải mã dư ra để tìm khoảng lặng mà cắt khối, không cắt giữa câu
PART_SEC = 600.0  # độ dài mỗi phần video khi phải mã hóa lại (in phụ đề / xóa logo)
TRANSLATE_BATCH = 45
AUDIO_PART_SEGS = 150  # số câu thoại trong 1 phần track tiếng = số input của 1 lệnh ffmpeg
SUB_STYLE = (
    "FontName=DejaVu Sans,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H22000000,"
    "BackColour=&H22000000,BorderStyle=3,Outline=5,Shadow=0,MarginV=18"
)
ENCODE_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]

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

CHILDREN: set = set()  # các tiến trình ffmpeg chạy lâu, cần dừng khi người dùng bấm Dừng
JOB: Optional["Job"] = None
RERENDER = False


# ----------------------------------------------------------------------------
# Tiện ích chung
# ----------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def fmt_clock(seconds: float) -> str:
    s = int(max(0.0, seconds))
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path: Path, data, indent: Optional[int] = None) -> None:
    """Ghi qua file tạm rồi đổi tên: bị ngắt giữa chừng cũng không làm hỏng checkpoint."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent), encoding="utf-8")
    os.replace(tmp, path)


def run_cmd(cmd: List[str], input_bytes: Optional[bytes] = None) -> bytes:
    proc = subprocess.run(cmd, input=input_bytes, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-600:]
        raise RuntimeError(f"Lệnh lỗi ({' '.join(cmd[:4])}): {err}")
    return proc.stdout


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


def build_delogo_filter(mode: str, w: int, h: int) -> str:
    """Giống buildDelogoFilter trong download_bilibili.mjs — để xóa logo ngay trong lượt xuất video."""
    if not mode or mode == "none":
        return ""
    if re.fullmatch(r"\d+,\d+,\d+,\d+", mode):
        x, y, bw, bh = mode.split(",")
        return f"delogo=x={x}:y={y}:w={bw}:h={bh}:show=0"
    rnd = lambda v: int(v + 0.5)
    portrait = h > w
    top_y = max(2, rnd(h * 0.015))
    box_h = rnd(h * (0.042 if portrait else 0.068))
    box_w = rnd(w * (0.39 if portrait else 0.25))
    left_x = max(2, rnd(w * 0.02))
    right_x = max(2, w - box_w - rnd(w * 0.015))
    left = f"delogo=x={left_x}:y={top_y}:w={box_w}:h={box_h}:show=0"
    right = f"delogo=x={right_x}:y={top_y}:w={box_w}:h={box_h}:show=0"
    return {"top-left": left, "top-right": right, "both-top": f"{left},{right}"}.get(mode, "")


# ----------------------------------------------------------------------------
# Job: thư mục làm việc + checkpoint + tiến độ
# ----------------------------------------------------------------------------
class Job:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.work = WORK_ROOT / job_id
        self.chunks_dir = self.work / "chunks"
        self.parts_dir = self.work / "parts"
        self.tts_dir = self.work / "tts"
        self.meta_path = self.work / "meta.json"
        self.meta: Dict = read_json(self.meta_path, {})
        self._lock = threading.Lock()

    def save_meta(self, **kw) -> None:
        with self._lock:
            self.meta.update(kw)
            self.meta["job_id"] = self.job_id
            self.meta["updated_at"] = datetime.now().isoformat(timespec="seconds")
            write_json_atomic(self.meta_path, self.meta, indent=2)

    def chunk_path(self, idx: int) -> Path:
        return self.chunks_dir / f"{idx:05d}.json"

    def load_chunks(self) -> List[Dict]:
        chunks = []
        for p in sorted(self.chunks_dir.glob("*.json")):
            c = read_json(p, None)
            # Chỉ nhận chuỗi khối liền mạch từ 0; khối hỏng/lẻ phía sau sẽ được nhận diện lại.
            if not c or c.get("idx") != len(chunks):
                break
            chunks.append(c)
        return chunks

    def save_chunk(self, chunk: Dict) -> None:
        write_json_atomic(self.chunk_path(chunk["idx"]), chunk)


class Progress:
    """Gộp tiến độ các công đoạn chạy song song thành 1 con số % + thời gian còn lại."""

    def __init__(self, job: Job, duration: float, encode: bool):
        self.job = job
        self.duration = max(1.0, duration)
        self.w = (
            {"stt": 0.40, "tr": 0.12, "tts": 0.08, "render": 0.30, "audio": 0.08, "mux": 0.02}
            if encode
            else {"stt": 0.55, "tr": 0.17, "tts": 0.13, "render": 0.0, "audio": 0.13, "mux": 0.02}
        )
        self.lock = threading.Lock()
        self.stage = "stt"
        self.stt = 0.0
        self.tr_done = self.tr_total = 0
        self.tts_done = self.tts_total = 0
        self.render = 0.0
        self.audio = 0.0
        self.mux = 0.0
        self.note = ""
        self.started = time.time()
        self.p0: Optional[float] = None
        self._last_emit = 0.0
        self._last_meta = 0.0

    def bump(self, field: str, n: int = 1) -> None:
        with self.lock:
            setattr(self, field, getattr(self, field) + n)
        self.emit()

    def pct(self) -> float:
        tr = self.stt * (min(1.0, self.tr_done / self.tr_total) if self.tr_total else 1.0)
        tts = self.stt * (min(1.0, self.tts_done / self.tts_total) if self.tts_total else 1.0)
        w = self.w
        p = (
            w["stt"] * self.stt + w["tr"] * tr + w["tts"] * tts
            + w["render"] * self.render + w["audio"] * self.audio + w["mux"] * self.mux
        )
        return round(min(100.0, 100.0 * p), 2)

    def label(self) -> str:
        if self.stage == "stt":
            base = f"Nhận diện lời thoại {fmt_clock(self.stt * self.duration)} / {fmt_clock(self.duration)}"
            if self.tr_total:
                base += f" · đã dịch {self.tr_done}/{self.tr_total} câu"
            return base
        if self.stage == "translate":
            return f"Antigravity đang dịch {self.tr_done}/{self.tr_total} câu"
        if self.stage == "tts":
            return f"Tạo giọng đọc tiếng Việt {self.tts_done}/{self.tts_total} câu"
        if self.stage == "render":
            return f"Xuất video {self.note}".strip() if self.note else f"Dựng & trộn track lồng tiếng {int(self.audio * 100)}%"
        if self.stage == "mux":
            return f"Ghép hình và tiếng {int(self.mux * 100)}%"
        return self.note

    def emit(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_emit < 2.0:
            return
        self._last_emit = now
        p = self.pct()
        if self.p0 is None:
            self.p0 = p
        eta = None
        elapsed = now - self.started
        if elapsed > 20 and p - self.p0 > 0.3 and p < 100:
            eta = int(elapsed * (100 - p) / (p - self.p0))
        stage_no = ["stt", "translate", "tts", "render", "mux"].index(self.stage) + 1
        label = self.label()
        log("@@PROGRESS " + json.dumps({"pct": p, "label": label, "stage": stage_no, "eta": eta}, ensure_ascii=False))
        if force or now - self._last_meta > 15:
            self._last_meta = now
            self.job.save_meta(pct=p, label=label, stage=stage_no)

    def set_stage(self, stage: str, note: str = "") -> None:
        self.stage = stage
        self.note = note
        self.emit(force=True)


# ----------------------------------------------------------------------------
# Bước 1+2: Nhận diện lời thoại theo khối (faster-whisper)
# ----------------------------------------------------------------------------
def decode_audio_window(input_mp4: Path, t0: float, dur: float, speed: float):
    """Giải mã [t0, t0+dur] của video thành PCM 16kHz đã làm chậm — chỉ 1 khối nằm trong RAM."""
    import numpy as np

    raw = run_cmd(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{t0:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            str(input_mp4),
            "-vn",
            "-af",
            build_atempo_chain(speed),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "s16le",
            "-",
        ]
    )
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def pick_cut(words: List[Dict], target: float, win_end: float) -> float:
    """Chọn điểm cắt khối tại khoảng lặng dài nhất quanh `target` để không cắt đôi câu thoại."""
    zone_lo, zone_hi = target - 20.0, win_end - 8.0
    if not words or words[-1]["e"] < zone_lo:
        return target
    best_gap, best_cut = -1.0, target
    for a, b in zip(words, words[1:]):
        if a["e"] >= zone_lo and b["s"] <= zone_hi and b["s"] - a["e"] > best_gap:
            best_gap, best_cut = b["s"] - a["e"], (a["e"] + b["s"]) / 2
    last_e = words[-1]["e"]
    if last_e < zone_hi and zone_hi - last_e > best_gap:
        best_cut = min(zone_hi, max(zone_lo, last_e + 0.3))
    return best_cut


def words_to_segments(words: List[Dict]) -> List[Dict]:
    """Gom từ thành câu thoại ngắn (dấu câu, khoảng lặng, độ dài) — mốc giờ theo video gốc 1.0x."""
    segments: List[Dict] = []
    buf_text, buf_start, buf_end = "", None, 0.0

    def flush():
        nonlocal buf_text, buf_start
        clean = buf_text.strip(" ，,、")
        if clean and buf_start is not None:
            # Whisper đôi khi lặp vô hạn 1 câu trên đoạn nhạc/im lặng: bỏ lần lặp thứ 3 trở đi.
            repeated = len(clean) >= 4 and len(segments) >= 2 and segments[-1]["zh"] == segments[-2]["zh"] == clean
            if not repeated:
                segments.append(
                    {
                        "start": round(buf_start, 2),
                        "end": round(max(buf_start + 0.3, buf_end), 2),
                        "zh": clean,
                        "vi": "",
                    }
                )
        buf_text, buf_start = "", None

    for i, item in enumerate(words):
        if buf_start is None:
            buf_start = item["s"]
        buf_text += item["w"]
        buf_end = item["e"]
        gap_after = (words[i + 1]["s"] - item["e"]) if i + 1 < len(words) else 9.0
        stripped = buf_text.strip()
        has_end_punct = bool(re.search(r"[。！？!?；;]$", stripped))
        has_comma = bool(re.search(r"[，,]$", stripped))
        if (
            has_end_punct
            or gap_after >= 0.25
            or (has_comma and len(buf_text) >= 10)
            or buf_end - buf_start >= 3.8
            or len(buf_text) >= 18
        ):
            flush()
    flush()
    return segments


def load_story_context(project_id: str) -> Dict:
    if not project_id:
        return {}
    return read_json(STORY_PROJECTS_DIR / f"{Path(project_id).name}.json", {})


def run_stt(
    job: Job,
    input_mp4: Path,
    duration: float,
    speed: float,
    model_size: str,
    story_ctx: Dict,
    chunk_sec: float,
    prog: Progress,
    on_chunk: Callable[[Dict], None],
) -> List[Dict]:
    chunks = job.load_chunks()
    t = chunks[-1]["t1"] if chunks else 0.0
    prog.stt = min(1.0, t / prog.duration)
    for c in chunks:
        on_chunk(c)
    if t >= duration - 0.5:
        log(f"[Nhận diện] Đã có sẵn {len(chunks)} khối từ lần chạy trước — bỏ qua bước nhận diện.")
        return chunks
    if chunks:
        log(f"[Nhận diện] Tiếp tục từ {fmt_clock(t)} (đã xong {len(chunks)} khối).")

    from faster_whisper import WhisperModel

    names = [c["zh"] for c in story_ctx.get("characters", []) if c.get("zh")]
    names += [g["zh"] for g in story_ctx.get("glossary", [])[:8] if g.get("zh")]
    prompt = ("普通话对白：" + "，".join(names[:40])) if names else "钓鱼动画楚新钓普通话对白"

    log(f"[Nhận diện] Nạp Whisper '{model_size}' — tách âm chậm {speed}x, quy đổi mốc giờ về tốc độ gốc 1.0x.")
    threads = max(2, min(8, (os.cpu_count() or 4) - 2))
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=threads)
    verbose = duration <= 900
    total_segs = sum(len(c["segments"]) for c in chunks)

    while t < duration - 0.5:
        win_end = min(duration, t + chunk_sec + STT_PAD_SEC)
        is_last = win_end >= duration - 0.01
        audio = decode_audio_window(input_mp4, t, win_end - t, speed)
        words: List[Dict] = []
        if len(audio) > 1600:
            seg_iter, _ = model.transcribe(
                audio,
                language="zh",
                initial_prompt=prompt,
                beam_size=4,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 280},
            )
            # Mốc giờ trên âm thanh chậm -> nhân speed và cộng t để về mốc giờ video gốc.
            for seg in seg_iter:
                if seg.words:
                    for w in seg.words:
                        words.append({"w": w.word, "s": t + float(w.start) * speed, "e": t + float(w.end) * speed})
                elif (seg.text or "").strip():
                    words.append({"w": seg.text.strip(), "s": t + float(seg.start) * speed, "e": t + float(seg.end) * speed})
                prog.stt = min(1.0, min(t + float(seg.end) * speed, t + chunk_sec) / prog.duration)
                prog.emit()
        del audio

        cut = duration if is_last else pick_cut(words, t + chunk_sec, win_end)
        segs = words_to_segments([w for w in words if w["s"] < cut])
        chunk = {"idx": len(chunks), "t0": round(t, 3), "t1": round(cut, 3), "segments": segs, "translated": not segs}
        job.save_chunk(chunk)
        chunks.append(chunk)
        total_segs += len(segs)
        if verbose:
            for s in segs:
                log(f"  [STT] {s['start']:7.2f}s -> {s['end']:7.2f}s | {s['zh']}")
        log(f"[Nhận diện] {fmt_clock(t)} → {fmt_clock(cut)} / {fmt_clock(duration)} | +{len(segs)} câu (tổng {total_segs})")
        t = cut
        prog.stt = min(1.0, t / prog.duration)
        on_chunk(chunk)
        prog.emit(force=True)

    del model
    return chunks


# ----------------------------------------------------------------------------
# Bước 3: Dịch theo ngữ cảnh dự án bằng Antigravity (chạy nền, có retry + checkpoint)
# ----------------------------------------------------------------------------
class Translator:
    MAX_CHARS, MAX_GLOSS = 200, 600

    def __init__(self, job: Job, story_ctx: Dict, project_id: str, workers: int, prog: Progress, on_chunk_done):
        self.job = job
        self.ctx = story_ctx or {}
        self.project_id = project_id
        self.prog = prog
        self.on_chunk_done = on_chunk_done
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="translate")
        self.lock = threading.Lock()
        self.chars: List[Dict] = list(self.ctx.get("characters") or [])
        self.gloss: List[Dict] = list(self.ctx.get("glossary") or [])
        self.new_chars: List[Dict] = []
        self.new_gloss: List[Dict] = []
        self.summaries: List[str] = list(job.meta.get("summaries") or [])
        self.fail_streak = 0
        self.failed_segs = 0
        self.fatal: Optional[str] = None
        self.futures: List = []
        self.verbose = prog.duration <= 900

    # --- ngữ cảnh gửi kèm mỗi lô: chỉ lấy phần liên quan để prompt không phình theo độ dài video
    def _context_block(self, batch_text: str) -> str:
        with self.lock:
            chars = self.chars if len(self.chars) <= 40 else (
                self.chars[:20] + [c for c in self.chars[20:] if c.get("zh") and c["zh"] in batch_text]
            )
            gloss = self.gloss if len(self.gloss) <= 40 else [g for g in self.gloss if g.get("zh") and g["zh"] in batch_text][:60]
            recent = self.summaries[-3:]
        chars_txt = "\n".join(
            f"- {c.get('zh')} -> {c.get('vi')} ({c.get('role', '')}; xưng hô: {c.get('pronouns', '')})" for c in chars
        )
        gloss_txt = "\n".join(f"- {g.get('zh')} -> {g.get('vi')}" for g in gloss)
        ep_notes = self.ctx.get("episode_notes") or {}
        prev_eps = "\n".join(f"- {k}: {str(v)[:300]}" for k, v in list(ep_notes.items())[-5:] if k != self.job.job_id)
        head = (
            f"Tên dự án: {self.ctx.get('name', '')} ({self.ctx.get('type', '')})\n"
            f"Phong cách dịch: {self.ctx.get('style', '')}\n"
            f"Cốt truyện chung: {self.ctx.get('synopsis', '')}\n"
            if self.ctx
            else "Không có dự án cụ thể (hãy tự suy luận bối cảnh từ lời thoại).\n"
        )
        return (
            f"{head}"
            f"Nhân vật & Xưng hô:\n{chars_txt or '(chưa có)'}\n"
            f"Từ điển thuật ngữ:\n{gloss_txt or '(chưa có)'}\n"
            f"Tóm tắt các tập trước:\n{prev_eps or '(chưa có)'}\n"
            f"Diễn biến ngay trước đoạn này trong video:\n{' '.join(recent) or '(đây là đoạn đầu)'}"
        )

    def _call_agy(self, prompt: str) -> Dict:
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
            timeout=240,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Antigravity CLI lỗi (code {proc.returncode}): {(proc.stderr or proc.stdout)[-300:]}")
        wrapper = json.loads(proc.stdout.strip())
        ai_out = wrapper.get("structured_output") or json.loads(wrapper.get("response") or "{}")
        if not isinstance(ai_out, dict) or not ai_out.get("translations"):
            raise RuntimeError("Antigravity trả về kết quả rỗng")
        return ai_out

    def _translate_batch(self, batch: List[Dict], prev_lines: List[str]) -> None:
        payload = json.dumps(
            [{"id": i + 1, "start": s["start"], "end": s["end"], "zh": s["zh"]} for i, s in enumerate(batch)],
            ensure_ascii=False,
        )
        prev_txt = ("\n".join(prev_lines) + "\n\n") if prev_lines else ""
        prompt = (
            "Bạn là biên dịch viên lồng tiếng phim/hoạt hình chuyên nghiệp. "
            "KHÔNG sử dụng bất kỳ tool nào, chỉ trả về đúng JSON theo schema.\n\n"
            f"=== NGỮ CẢNH DỰ ÁN ===\n{self._context_block(payload)}\n\n"
            "=== NHIỆM VỤ ===\n"
            "1. Đọc kỹ các câu thoại tiếng Trung do Whisper tách bên dưới (có thể bị nghe nhầm đồng âm, "
            "ví dụ 楚依旧->除意就, 老骨头->脑骨头, 出发->扶发, 去钓->去掉). Hãy tự sửa lỗi nghe nhầm dựa vào ngữ cảnh!\n"
            "2. Dịch sang tiếng Việt thật tự nhiên, ngắn gọn, súc tích để đọc lồng tiếng khớp tốc độ gốc 1.0x, đúng xưng hô.\n"
            "3. Trả về đúng đủ số lượng 'id' trong mảng 'translations'.\n"
            "4. Viết 'episode_summary' (1-2 câu tóm tắt diễn biến đoạn này để giữ mạch truyện).\n"
            "5. Nếu có nhân vật mới hoặc thuật ngữ mới quan trọng chưa có trong ngữ cảnh trên, điền vào "
            "'new_characters' / 'new_glossary' (nếu không có thì để mảng rỗng []).\n\n"
            + (f"=== CÁC CÂU NGAY TRƯỚC (chỉ để hiểu mạch, KHÔNG dịch lại) ===\n{prev_txt}" if prev_txt else "")
            + f"=== LỜI THOẠI CẦN DỊCH ===\n{payload}"
        )
        last_err: Optional[Exception] = None
        for attempt in range(3):
            if self.fatal:
                return
            try:
                ai_out = self._call_agy(prompt)
                vi_map = {}
                for item in ai_out.get("translations") or []:
                    try:
                        vi_map[int(item["id"])] = (item.get("vi") or "").strip()
                    except (KeyError, TypeError, ValueError):
                        continue
                got = 0
                for i, seg in enumerate(batch):
                    if vi_map.get(i + 1):
                        seg["vi"] = vi_map[i + 1]
                        got += 1
                if got < len(batch) * 0.6:
                    raise RuntimeError(f"chỉ nhận được {got}/{len(batch)} câu dịch")
                self._absorb(ai_out)
                with self.lock:
                    self.fail_streak = 0
                    self.failed_segs += len(batch) - got
                self.prog.bump("tr_done", got)
                if self.verbose:
                    for seg in batch:
                        log(f"  [Dịch] {seg['start']:7.2f}s | {seg['vi'] or '(chưa dịch được)'}")
                return
            except Exception as exc:  # mạng chập chờn / quá tải: thử lại rồi mới bỏ qua lô này
                last_err = exc
                time.sleep(5 * (attempt + 1) ** 2)
        with self.lock:
            self.fail_streak += 1
            self.failed_segs += len(batch)
            log(f"[Dịch] ⚠ Bỏ qua tạm 1 lô {len(batch)} câu sau 3 lần thử: {last_err}")
            if self.fail_streak >= 4:
                self.fatal = f"Antigravity lỗi liên tục, đã dừng để không tạo video thiếu lời dịch: {last_err}"

    def _absorb(self, ai_out: Dict) -> None:
        """Nạp nhân vật / thuật ngữ / tóm tắt mới vào ngữ cảnh để các lô sau dịch nhất quán."""
        with self.lock:
            summary = (ai_out.get("episode_summary") or "").strip()
            if summary:
                self.summaries.append(summary[:400])
            known = {c.get("zh", "").strip() for c in self.chars}
            for nc in (ai_out.get("new_characters") or [])[:3]:
                zh, vi = (nc.get("zh") or "").strip(), (nc.get("vi") or "").strip()
                if zh and vi and zh not in known and len(self.chars) < self.MAX_CHARS:
                    item = {"zh": zh, "vi": vi, "role": (nc.get("role") or "").strip(), "pronouns": (nc.get("pronouns") or "").strip()}
                    self.chars.append(item)
                    self.new_chars.append(item)
                    known.add(zh)
            known = {g.get("zh", "").strip() for g in self.gloss}
            for ng in (ai_out.get("new_glossary") or [])[:5]:
                zh, vi = (ng.get("zh") or "").strip(), (ng.get("vi") or "").strip()
                if zh and vi and zh not in known and len(self.gloss) < self.MAX_GLOSS:
                    item = {"zh": zh, "vi": vi}
                    self.gloss.append(item)
                    self.new_gloss.append(item)
                    known.add(zh)

    def submit_chunk(self, chunk: Dict) -> None:
        segs = chunk["segments"]
        todo = [s for s in segs if s.get("zh") and not s.get("vi")]
        with self.prog.lock:
            self.prog.tr_total += len(segs)
            self.prog.tr_done += len(segs) - len(todo)
        if not todo:
            self.on_chunk_done(chunk)
            return
        batches = [todo[i : i + TRANSLATE_BATCH] for i in range(0, len(todo), TRANSLATE_BATCH)]
        state = {"left": len(batches)}
        pos = {id(s): i for i, s in enumerate(segs)}

        def work(batch: List[Dict]) -> None:
            first = pos[id(batch[0])]
            prev = [s["zh"] for s in segs[max(0, first - 4) : first]]
            try:
                self._translate_batch(batch, prev)
            finally:
                with self.lock:
                    state["left"] -= 1
                    done = state["left"] == 0
                if done:
                    chunk["translated"] = all(s.get("vi") for s in segs if s.get("zh"))
                    self.job.save_chunk(chunk)
                    self.job.save_meta(summaries=self.summaries[-200:])
                    self.persist_memory(final=False)
                    self.on_chunk_done(chunk)

        for b in batches:
            self.futures.append(self.pool.submit(work, b))

    def wait(self) -> None:
        for f in self.futures:
            f.result()
        self.pool.shutdown()
        if self.fatal:
            raise RuntimeError(self.fatal)

    def persist_memory(self, final: bool) -> None:
        """Ghi nhân vật/thuật ngữ mới vào file Dự án. Đọc lại file trước khi ghi để không đè chỉnh sửa trên web."""
        if not self.project_id:
            return
        with self.lock:
            add_chars, add_gloss = self.new_chars, self.new_gloss
            self.new_chars, self.new_gloss = [], []
            summaries = list(self.summaries)
        if not (add_chars or add_gloss or final):
            return
        p = STORY_PROJECTS_DIR / f"{Path(self.project_id).name}.json"
        proj = read_json(p, None)
        if not proj:
            return
        have = {c.get("zh", "").strip() for c in proj.get("characters") or []}
        proj["characters"] = (proj.get("characters") or []) + [c for c in add_chars if c["zh"] not in have]
        have = {g.get("zh", "").strip() for g in proj.get("glossary") or []}
        proj["glossary"] = (proj.get("glossary") or []) + [g for g in add_gloss if g["zh"] not in have]
        if final and summaries:
            # Video dài có hàng nghìn tóm tắt lô: chỉ giữ ~8 mốc rải đều để ghi nhớ mạch truyện.
            step = max(1, math.ceil(len(summaries) / 8))
            notes = proj.get("episode_notes") or {}
            notes[self.job.job_id] = " ".join(summaries[::step])[:1500]
            proj["episode_notes"] = notes
        proj["updated_at"] = datetime.now().isoformat(timespec="seconds")
        write_json_atomic(p, proj, indent=2)
        if add_chars or add_gloss:
            log(f"[Dự án] Antigravity đã ghi nhớ thêm +{len(add_chars)} nhân vật, +{len(add_gloss)} thuật ngữ vào '{proj.get('name')}'.")


# ----------------------------------------------------------------------------
# Bước 4: Giọng đọc tiếng Việt (edge-tts, dự phòng Google) — cache theo nội dung câu
# ----------------------------------------------------------------------------
def google_tts_fallback(text: str, mp3_path: Path, is_male: bool) -> bool:
    import requests

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
    try:
        if raw_mp3.stat().st_size < 200:
            return False
        # Giọng nam: hạ tông cho trầm kiểu kể chuyện; giọng nữ: chỉ tăng nhẹ tốc độ.
        af = "asetrate=24000*0.86,aresample=24000,atempo=1.22" if is_male else "atempo=1.10"
        run_cmd(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw_mp3), "-af", af, "-f", "mp3", str(mp3_path)])
    finally:
        raw_mp3.unlink(missing_ok=True)
    return mp3_path.exists() and mp3_path.stat().st_size > 200


class TTS:
    def __init__(self, cache_dir: Path, voice: str, rate: str, workers: int, prog: Progress):
        self.cache_dir = cache_dir
        self.voice = voice
        self.rate = rate
        self.prog = prog
        self.is_male = "NamMinh" in (voice or "")
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="tts")
        self.lock = threading.Lock()
        self.edge_fail_streak = 0
        self.edge_blocked_until = 0.0
        self.failed = 0
        self.fallbacks = 0
        self.prewarmed: List = []

    def path(self, text: str) -> Path:
        h = hashlib.sha1(f"{self.voice}|{self.rate}|{text}".encode("utf-8")).hexdigest()
        return self.cache_dir / h[:2] / f"{h}.mp3"

    def ensure(self, text: str) -> Optional[Path]:
        """Trả về file mp3 của câu (tạo nếu chưa có). Gọi lại nhiều lần / từ nhiều luồng đều an toàn."""
        text = (text or "").strip()
        if not text or not re.search(r"\w", text):
            return None
        out = self.path(text)
        if out.exists() and out.stat().st_size > 200:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f"{out.stem}.{threading.get_ident()}.tmp.mp3")
        try:
            if time.time() >= self.edge_blocked_until:
                import edge_tts

                # Edge-TTS hay trả "No audio received" ngẫu nhiên từng lần (đo thực tế có lúc ~50%):
                # thử lại đủ nhiều để gần như mọi câu giữ đúng 1 giọng, thay vì lẫn giọng Google dự phòng.
                for attempt in range(6):
                    try:
                        asyncio.run(edge_tts.Communicate(text=text, voice=self.voice, rate=self.rate).save(str(tmp)))
                        if tmp.exists() and tmp.stat().st_size > 200:
                            os.replace(tmp, out)
                            self.edge_fail_streak = 0
                            return out
                    except Exception:
                        time.sleep(0.5 * (attempt + 1))
                with self.lock:
                    self.edge_fail_streak += 1
                    if self.edge_fail_streak >= 8:
                        # Edge đang sập/chặn: nghỉ 2 phút rồi thử lại, thay vì bỏ hẳn như trước.
                        self.edge_blocked_until = time.time() + 120
                        self.edge_fail_streak = 0
                        log("[Giọng đọc] Edge-TTS lỗi liên tục, tạm dùng giọng Google trong 2 phút.")
            try:
                if google_tts_fallback(text, tmp, self.is_male):
                    os.replace(tmp, out)
                    with self.lock:
                        self.fallbacks += 1
                    return out
            except Exception:
                pass
            with self.lock:
                self.failed += 1
            return None
        finally:
            tmp.unlink(missing_ok=True)

    def prewarm(self, texts: List[str]) -> None:
        """Tạo giọng đọc ở luồng nền ngay khi 1 khối vừa dịch xong, không chờ hết video."""
        texts = [t for t in texts if t]
        with self.prog.lock:
            self.prog.tts_total += len(texts)
        self.prewarmed += [self.pool.submit(self._ensure_counted, t) for t in texts]

    def _ensure_counted(self, text: str) -> Optional[Path]:
        try:
            return self.ensure(text)
        finally:
            self.prog.bump("tts_done")

    def ensure_all(self, texts: List[str]) -> List[Optional[Path]]:
        for f in self.prewarmed:  # chờ lượt chạy nền xong để không tạo trùng 1 câu 2 lần
            f.result()
        self.prewarmed = []
        with self.prog.lock:
            self.prog.tts_total, self.prog.tts_done = len(texts), 0
        return list(self.pool.map(self._ensure_counted, texts))


MP3_BITRATES = {
    True: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  # MPEG-1 Layer III
    False: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],  # MPEG-2 / 2.5 Layer III
}


def mp3_duration(path: Path) -> float:
    """Thời lượng 1 câu TTS. File edge-tts là luồng mp3 CBR thô nên tính được ngay từ header (không tốn 1 lần
    chạy ffprobe cho mỗi câu trong 100k câu); file có thẻ ID3/khung Info (giọng Google dự phòng) thì hỏi ffprobe."""
    try:
        with path.open("rb") as f:
            head = f.read(4)
        if len(head) == 4 and head[0] == 0xFF and (head[1] & 0xE6) == 0xE2:  # sync + Layer III
            kbps = MP3_BITRATES[(head[1] >> 3) & 3 == 3][head[2] >> 4]
            if kbps:
                return path.stat().st_size * 8 / (kbps * 1000)
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], text=True
        )
        return float(out.strip() or 0)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0.0


def sample_index(t: float) -> int:
    return int(round(t * SAMPLE_RATE))


def audio_part_bounds(segments: List[Dict], duration: float) -> List[float]:
    """Ranh giới các phần track tiếng: mỗi phần tối đa AUDIO_PART_SEGS câu, luôn cắt tại mốc bắt đầu 1 câu.
    Mỗi câu chỉ được phát tới mốc câu kế tiếp, nên không câu nào vắt qua ranh giới phần."""
    bounds = [0.0]
    for s in segments[AUDIO_PART_SEGS::AUDIO_PART_SEGS]:
        if s["start"] > bounds[-1]:
            bounds.append(s["start"])
    bounds.append(max(duration, bounds[-1] + 0.1))
    return bounds


def audio_part_graph(part_segs: List[Dict], mp3s: List[Optional[Path]], t0: float, t1: float):
    """Dựng lệnh ffmpeg cho 1 phần track tiếng: mỗi câu được cắt lặng đầu, tăng tốc (tối đa 1.95x) cho vừa
    khoảng trống, rồi đệm/cắt về ĐÚNG số mẫu tính tới câu kế tiếp — nên cả phần khớp timeline từng mẫu.
    Trả về (danh sách file input, nội dung filter_complex, tổng số mẫu)."""
    silence = f"anullsrc=r={SAMPLE_RATE}:cl=mono,aformat=sample_fmts=s16"
    base, end = sample_index(t0), sample_index(t1)
    inputs: List[str] = []
    chains: List[str] = []
    labels: List[str] = []

    def add(chain: str) -> None:
        labels.append(f"[a{len(labels)}]")
        chains.append(chain + labels[-1])

    pos = base
    for n, (seg, mp3) in enumerate(zip(part_segs, mp3s)):
        start = max(pos, sample_index(seg["start"]))
        nxt = min(end, sample_index(part_segs[n + 1]["start"])) if n + 1 < len(part_segs) else end
        length = nxt - start
        if length <= 0:
            continue
        if start > pos:  # khoảng lặng trước câu (chỉ có ở câu đầu tiên của phần)
            add(f"{silence},atrim=end_sample={start - pos}")
        if mp3:
            slot = max(0.35, length / SAMPLE_RATE - 0.03)
            dur = mp3_duration(mp3)
            tempo = f"{build_atempo_chain(min(1.95, dur / slot))}," if dur > slot * 1.02 else ""
            add(
                f"[{len(inputs)}:a]silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,{tempo}"
                f"aresample={SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono,"
                f"apad=whole_len={length},atrim=end_sample={length}"
            )
            inputs.append(str(mp3))
        else:
            add(f"{silence},atrim=end_sample={length}")
        pos = nxt
    if pos < end:
        add(f"{silence},atrim=end_sample={end - pos}")
    graph = ";".join(chains) + f";{''.join(labels)}concat=n={len(labels)}:v=0:a=1[out]"
    return inputs, graph, end - base


def build_audio_parts(job: "Job", segments: List[Dict], tts: "TTS", duration: float, prog: "Progress") -> Path:
    """Dựng track lồng tiếng theo từng phần FLAC (không mất dữ liệu, nối lại khít từng mẫu), mỗi phần chỉ
    1 lệnh ffmpeg, cache theo nội dung: chạy tiếp được, và sửa 1 câu chỉ phải dựng lại đúng 1 phần."""
    adir = job.work / "audio"
    adir.mkdir(parents=True, exist_ok=True)
    bounds = audio_part_bounds(segments, duration)
    jobs, i = [], 0
    for k in range(len(bounds) - 1):
        t0, t1 = bounds[k], bounds[k + 1]
        j = i
        while j < len(segments) and segments[j]["start"] < t1:
            j += 1
        part_segs, i = segments[i:j], j
        key = hashlib.sha1(
            json.dumps([tts.voice, tts.rate, t0, t1, [[s["start"], s.get("vi", "")] for s in part_segs]]).encode()
        ).hexdigest()[:12]
        jobs.append((k, t0, t1, part_segs, adir / f"a{k:05d}_{key}.flac"))
    done = 0

    def build(item) -> None:
        nonlocal done
        k, t0, t1, part_segs, part = item
        if not part.exists():
            for stale in adir.glob(f"a{k:05d}_*"):
                stale.unlink(missing_ok=True)
            inputs, graph, _ = audio_part_graph(part_segs, [tts.ensure(s.get("vi", "")) for s in part_segs], t0, t1)
            script = adir / f"a{k:05d}.filter.txt"
            script.write_text(graph, encoding="utf-8")
            tmp = part.with_suffix(".tmp.flac")
            cmd = ["ffmpeg", "-y", "-v", "error"]
            for f in inputs:
                cmd += ["-i", f]
            run_cmd(cmd + ["-filter_complex_script", str(script), "-map", "[out]", "-c:a", "flac", "-f", "flac", str(tmp)])
            os.replace(tmp, part)
            script.unlink(missing_ok=True)
        done += 1
        prog.audio = 0.2 * done / len(jobs)
        prog.emit()

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="audio") as pool:
        list(pool.map(build, jobs))
    keep = [item[4] for item in jobs]
    for f in adir.iterdir():
        if f not in keep:
            f.unlink(missing_ok=True)
    concat = job.work / "audio.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in keep), encoding="utf-8")
    return concat


# ----------------------------------------------------------------------------
# Bước 5: Xuất video
# ----------------------------------------------------------------------------
def fmt_srt_time(seconds: float) -> str:
    ms = int(round(max(0.0, seconds) * 1000))
    return f"{ms // 3_600_000:02d}:{ms % 3_600_000 // 60_000:02d}:{ms % 60_000 // 1000:02d},{ms % 1000:03d}"


def build_srt(segments: List[Dict], offset: float = 0.0, window: Optional[float] = None) -> str:
    """SRT của cả video, hoặc của 1 phần [offset, offset+window) với mốc giờ dời về 0."""
    lines = []
    n = 0
    for seg in segments:
        txt = (seg.get("vi") or seg.get("zh") or "").strip()
        start, end = seg["start"] - offset, seg["end"] - offset
        if not txt or (window is not None and (end <= 0 or start >= window)):
            continue
        if window is not None:
            start, end = max(0.0, start), min(window, end)
        n += 1
        lines += [str(n), f"{fmt_srt_time(start)} --> {fmt_srt_time(end)}", txt, ""]
    return "\n".join(lines)


def escape_subtitles_path(p: Path) -> str:
    s = str(p.resolve())
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def run_ffmpeg(cmd: List[str], total_sec: float, on_frac, err_path: Path) -> None:
    """Chạy ffmpeg có báo tiến độ thật (-progress)."""
    full = ["ffmpeg", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1"] + cmd
    with err_path.open("wb") as ef:
        proc = subprocess.Popen(full, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=ef)
    CHILDREN.add(proc)

    def reader():
        for raw in proc.stdout:
            if raw.startswith(b"out_time_us=") or raw.startswith(b"out_time_ms="):
                try:
                    on_frac(min(1.0, int(raw.split(b"=")[1]) / 1e6 / max(1.0, total_sec)))
                except ValueError:
                    pass

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    try:
        rc = proc.wait()
    finally:
        CHILDREN.discard(proc)
    th.join(timeout=5)
    if rc != 0:
        raise RuntimeError(f"ffmpeg lỗi (mã {rc}): {err_path.read_text('utf-8', 'replace')[-600:]}")


def render_parts(
    job: Job, input_mp4: Path, segments: List[Dict], duration: float, burn_sub: bool, delogo_vf: str, sig, prog: Progress
) -> Path:
    # CRF 21 trên nguồn bitrate thấp (Bilibili ~1 Mbps) cho ra file to gấp 3 mà không đẹp hơn:
    # chặn trần ở 1.3 lần bitrate nguồn để video 90 tiếng không ngốn ổ cứng vô ích.
    cap = max(600_000, int(sig[0] * 8 / max(1.0, duration) * 1.3))
    encode_args = ENCODE_ARGS + ["-maxrate", str(cap), "-bufsize", str(cap * 2)]
    """Mã hóa lại video theo từng phần 10 phút (in phụ đề / xóa logo). Phần nào xong được cache:
    dừng giữa chừng thì chạy tiếp, sửa lời thoại thì chỉ phần chứa câu bị sửa phải làm lại."""
    job.parts_dir.mkdir(parents=True, exist_ok=True)
    n_parts = max(1, math.ceil((duration - 0.05) / PART_SEC))
    threads = max(2, min(8, (os.cpu_count() or 4) - 2))
    keep, done_before = [], 0
    for k in range(n_parts):
        t0 = k * PART_SEC
        dur = min(PART_SEC, duration - t0)
        srt_txt = build_srt(segments, offset=t0, window=dur) if burn_sub else ""
        key = hashlib.sha1(json.dumps([sig, t0, dur, srt_txt, delogo_vf, SUB_STYLE, encode_args]).encode()).hexdigest()[:12]
        part = job.parts_dir / f"p{k:05d}_{key}.mp4"
        keep.append(part)
        if part.exists():
            done_before += 1
            prog.render = (k + 1) / n_parts
            continue
        for stale in job.parts_dir.glob(f"p{k:05d}_*"):
            stale.unlink(missing_ok=True)
        filters = [delogo_vf] if delogo_vf else []
        if srt_txt:
            srt_path = job.parts_dir / f"p{k:05d}.srt"
            srt_path.write_text(srt_txt, encoding="utf-8")
            filters.append(f"subtitles='{escape_subtitles_path(srt_path)}':force_style='{SUB_STYLE}'")
        tmp = part.with_suffix(".tmp.mp4")
        prog.note = f"phần {k + 1}/{n_parts} ({fmt_clock(t0)} → {fmt_clock(t0 + dur)})"

        def on_frac(f, k=k):
            prog.render = (k + f) / n_parts
            prog.emit()

        run_ffmpeg(
            ["-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", str(input_mp4), "-map", "0:v:0", "-an",
             "-vf", ",".join(filters) or "null", *encode_args, "-threads", str(threads), str(tmp)],
            dur, on_frac, job.work / "render_err.log",
        )
        os.replace(tmp, part)
        prog.render = (k + 1) / n_parts
        prog.emit(force=True)
        if n_parts > 1:
            log(f"[Xuất video] Xong phần {k + 1}/{n_parts}.")
    for f in job.parts_dir.iterdir():
        if f not in keep:
            f.unlink(missing_ok=True)
    if done_before:
        log(f"[Xuất video] Dùng lại {done_before}/{n_parts} phần đã mã hóa từ trước.")
    concat = job.work / "parts.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in keep), encoding="utf-8")
    return concat


def build_audio(
    job: Job, input_mp4: Path, segments: List[Dict], tts: "TTS", duration: float,
    bg_volume: float, has_orig_audio: bool, prog: Progress,
) -> Path:
    """Dựng các phần track lồng tiếng rồi trộn với âm nền gốc thành 1 file AAC hoàn chỉnh.
    Mã hóa AAC chỉ nhanh ~28 lần thời gian thực (video 90 tiếng mất ~3 giờ) nên việc này chạy ở luồng
    nền, song song với lúc luồng chính mã hóa video."""
    audio_list = build_audio_parts(job, segments, tts, duration + 0.5, prog)
    dub_in = ["-f", "concat", "-safe", "0", "-i", str(audio_list)]
    if bg_volume > 0.001 and has_orig_audio:
        cmd = ["-i", str(input_mp4)] + dub_in + [
            "-filter_complex",
            f"[0:a:0]volume={bg_volume:.3f}[bg];[1:a]volume=1.35[vo];"
            f"[bg][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]",
            "-map", "[aout]",
        ]
    else:
        cmd = dub_in + ["-map", "0:a:0"]
    mix = job.work / "mix.m4a"

    def on_frac(f):
        prog.audio = 0.2 + 0.8 * f
        prog.emit()

    run_ffmpeg(cmd + ["-c:a", "aac", "-b:a", "128k", "-f", "mp4", str(mix)], duration, on_frac, job.work / "mix_err.log")
    return mix


def mux_final(job: Job, input_mp4: Path, concat_list: Optional[Path], mix: Path, out_mp4: Path, duration: float, prog: Progress) -> None:
    """Ghép hình + tiếng đã trộn sẵn — cả hai đều copy, không mã hóa lại."""
    video_in = ["-f", "concat", "-safe", "0", "-i", str(concat_list)] if concat_list else ["-i", str(input_mp4)]
    tmp = out_mp4.with_suffix(".tmp.mp4")

    def on_frac(f):
        prog.mux = f
        prog.emit()

    try:
        run_ffmpeg(
            video_in + ["-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-shortest",
                        "-movflags", "+faststart", "-f", "mp4", str(tmp)],
            duration, on_frac, job.work / "mux_err.log",
        )
        os.replace(tmp, out_mp4)
    finally:
        tmp.unlink(missing_ok=True)
    mix.unlink(missing_ok=True)


def update_dubbed_index(entry: Dict) -> None:
    items = read_json(DUBBED_INDEX_JSON, {}).get("videos", [])
    by_id = {x["job_id"]: x for x in items if "job_id" in x}
    by_id[entry["job_id"]] = entry
    merged = sorted(by_id.values(), key=lambda x: x.get("updated_at", ""), reverse=True)
    write_json_atomic(
        DUBBED_INDEX_JSON,
        {"updated_at": datetime.now().isoformat(timespec="seconds"), "total": len(merged), "videos": merged},
        indent=2,
    )


def dir_size_mb(path: Path) -> float:
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return round(total / 1048576, 1)


def assert_disk_space(target_dir: Path, need_gb: float) -> None:
    free_gb = shutil.disk_usage(target_dir).free / 1024**3
    if free_gb < need_gb:
        raise RuntimeError(
            f"Ổ cứng chỉ còn trống {free_gb:.1f} GB, cần khoảng {need_gb:.1f} GB để xuất video này. "
            "Hãy xóa bớt video cũ (hoặc tắt in cứng phụ đề để không phải mã hóa lại) rồi bấm Tiếp tục."
        )


# ----------------------------------------------------------------------------
# Luồng chính
# ----------------------------------------------------------------------------
def main() -> int:
    global JOB, RERENDER
    parser = argparse.ArgumentParser(description="Dịch & Lồng tiếng Việt tự động cho video tiếng Trung")
    parser.add_argument("--input", help="Đường dẫn file MP4 gốc")
    parser.add_argument("--project", help="Job ID có sẵn để render lại sau khi sửa bản dịch")
    parser.add_argument("--story-project", default="", help="ID Dự án truyện/phim (data/projects/<id>.json)")
    parser.add_argument("--speed", type=float, default=0.5, help="Tốc độ làm chậm khi tách âm (mặc định 0.5)")
    parser.add_argument("--voice", default="vi-VN-NamMinhNeural", help="Giọng đọc edge-tts")
    parser.add_argument("--tts-rate", default="+5%", help="Tốc độ đọc TTS mặc định (vd: +0%%, +10%%)")
    parser.add_argument("--model", default="small", help="Whisper model: tiny | base | small")
    parser.add_argument("--bg-volume", type=float, default=0.06, help="Âm lượng âm thanh gốc giữ lại (0.0 = tắt hẳn)")
    parser.add_argument("--no-sub", action="store_true", help="Không in cứng phụ đề tiếng Việt lên video")
    parser.add_argument("--delogo", default="none", help="Xóa logo ngay khi xuất: none | top-right | top-left | both-top | x,y,w,h")
    parser.add_argument("--fresh", action="store_true", help="Bỏ kết quả dở dang, nhận diện & dịch lại từ đầu")
    parser.add_argument("--chunk-min", type=float, default=10.0, help="Độ dài mỗi khối nhận diện (phút)")
    parser.add_argument("--translate-workers", type=int, default=3, help="Số lô dịch chạy song song")
    parser.add_argument("--tts-workers", type=int, default=12, help="Số câu tạo giọng đọc song song")
    args = parser.parse_args()

    os.nice(8)  # chạy nền nhiều giờ: nhường CPU cho máy; ffmpeg/agy con được thừa hưởng
    DUB_OUT_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

    rerender = RERENDER = bool(args.project)
    if rerender:
        proj_path = PROJECTS_DIR / f"{Path(args.project).name}.json"
        proj = read_json(proj_path, None)
        if not proj:
            raise RuntimeError(f"Không tìm thấy project: {proj_path}")
        job_id = proj["job_id"]
        input_mp4 = Path(proj["input_path"])
        speed = float(proj.get("speed", args.speed))
        voice = proj.get("voice") or args.voice
        bg_volume = float(proj.get("bg_volume", 0.06))
        burn_sub = bool(proj.get("burn_sub", True))
        delogo = proj.get("delogo") or "none"
        tts_rate = proj.get("tts_rate") or args.tts_rate
        story_project_id = proj.get("project_id", "")
        segments = sorted(proj.get("segments", []), key=lambda s: s["start"])
        log(f"[Xuất lại] Đọc {len(segments)} câu đã chỉnh sửa từ project {job_id}...")
    else:
        if not args.input:
            raise RuntimeError("Cần truyền --input <mp4> hoặc --project <job_id>")
        input_mp4 = Path(args.input).resolve()
        speed = max(0.25, min(1.5, args.speed))
        voice, bg_volume, burn_sub, delogo, tts_rate = args.voice, args.bg_volume, not args.no_sub, args.delogo, args.tts_rate
        story_project_id = args.story_project or ""
        stem = re.sub(r"[^0-9a-zA-Z_-]+", "_", input_mp4.stem)[:32].strip("_") or "video"
        job_id = f"dub_{stem}_{str(speed).replace('.', 'p')}x"
        segments = []
    if not input_mp4.exists():
        raise RuntimeError(f"Không tìm thấy video đầu vào: {input_mp4}")

    job = JOB = Job(job_id)
    for leftover in job.work.rglob("*.tmp.*"):  # file ghi dở của lần chạy bị ngắt
        leftover.unlink(missing_ok=True)
    st = input_mp4.stat()
    sig = [st.st_size, int(st.st_mtime)]
    media = probe_media(input_mp4)
    duration = media["duration"]
    if duration <= 0:
        raise RuntimeError("Không đọc được thời lượng video (file hỏng hoặc tải chưa xong).")
    delogo_vf = build_delogo_filter(delogo, media["w"], media["h"])
    encode = burn_sub or bool(delogo_vf)

    if not rerender:
        if not media["has_audio"]:
            raise RuntimeError("Video này không có luồng âm thanh!")
        stt_params = {"speed": speed, "model": args.model, "sig": sig, "chunk_min": args.chunk_min}
        old = job.meta
        if args.fresh or old.get("status") == "done" or old.get("stt_params") != stt_params:
            # Chạy mới: bỏ khối nhận diện/dịch cũ. Cache giọng đọc được giữ vì khóa theo nội dung câu.
            shutil.rmtree(job.chunks_dir, ignore_errors=True)
            job.meta = {}
        job.chunks_dir.mkdir(parents=True, exist_ok=True)
        job.save_meta(
            status="running", error="", input_path=str(input_mp4), title=input_mp4.name, duration=round(duration, 1),
            stt_params=stt_params,
            params={"speed": speed, "voice": voice, "model": args.model, "bg_volume": bg_volume, "burn_sub": burn_sub,
                    "delogo": delogo, "project_id": story_project_id, "tts_rate": tts_rate},
        )
    else:
        # Xuất lại không đổi `status`: nếu lỗi/dừng, job vẫn là "done" và lời đã sửa trong project không bị
        # lượt "Tiếp tục" (dựng lại từ các khối nhận diện) ghi đè.
        job.work.mkdir(parents=True, exist_ok=True)
        job.save_meta(error="")

    in_gb = st.st_size / 1024**3
    assert_disk_space(DUB_OUT_DIR, in_gb * ((1.2 if rerender else 2.2) if encode else 1.15) + 0.5)

    story_ctx = load_story_context(story_project_id)
    if story_ctx:
        log(f"[Dự án] Đã nạp ngữ cảnh: {story_ctx.get('name')} ({len(story_ctx.get('characters', []))} nhân vật, {len(story_ctx.get('glossary', []))} từ điển)")
    log(f"[Video] {input_mp4.name} | {fmt_clock(duration)} | {media['w']}x{media['h']} | {in_gb:.2f} GB")

    prog = Progress(job, duration, encode)
    tts = TTS(job.tts_dir, voice, tts_rate, args.tts_workers, prog)
    out_mp4 = DUB_OUT_DIR / f"{job_id}.mp4"
    out_srt = DUB_OUT_DIR / f"{job_id}.srt"
    proj_path = PROJECTS_DIR / f"{job_id}.json"
    untranslated = 0

    if not rerender:
        translator = Translator(
            job, story_ctx, story_project_id, args.translate_workers, prog,
            on_chunk_done=lambda c: tts.prewarm([s.get("vi", "") for s in c["segments"]]),
        )
        chunks = run_stt(
            job, input_mp4, duration, speed, args.model, story_ctx, max(60.0, args.chunk_min * 60), prog,
            on_chunk=translator.submit_chunk,
        )
        prog.stt = 1.0
        prog.set_stage("translate")
        translator.wait()
        translator.persist_memory(final=True)
        for c in chunks:
            segments.extend(c["segments"])
        segments.sort(key=lambda s: s["start"])
        for i, s in enumerate(segments, start=1):
            s["id"] = i
        if not segments:
            raise RuntimeError(
                "Không nhận diện được câu thoại tiếng Trung nào — video này có vẻ chỉ có nhạc / tiếng động nên không có gì để lồng tiếng."
            )
        untranslated = sum(1 for s in segments if s.get("zh") and not s.get("vi"))
        if segments and untranslated > len(segments) * 0.2:
            raise RuntimeError(
                f"Còn {untranslated}/{len(segments)} câu chưa dịch được (Antigravity lỗi). "
                "Kết quả đã lưu — bấm Tiếp tục để dịch nốt phần còn thiếu."
            )
        log(f"[Dịch] Hoàn tất {len(segments) - untranslated}/{len(segments)} câu thoại.")
    else:
        prog.stt = 1.0

    out_srt.write_text(build_srt(segments), encoding="utf-8")
    write_json_atomic(
        proj_path,
        {
            "job_id": job_id,
            "project_id": story_project_id,
            "title": input_mp4.name,
            "input_path": str(input_mp4),
            "speed": speed,
            "voice": voice,
            "tts_rate": tts_rate,
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "orig_duration_sec": round(duration, 1),
            "dub_duration_sec": round(duration, 1),
            "resolution": f"{media['w']}x{media['h']}",
            "segments": segments,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )

    prog.set_stage("tts")
    log(f"[Giọng đọc] Tạo giọng tiếng Việt ({voice}) cho {len(segments)} câu (câu đã có trong cache được dùng lại)...")
    mp3_files = tts.ensure_all([s.get("vi", "") for s in segments])
    if tts.fallbacks:
        log(f"[Giọng đọc] {tts.fallbacks} câu phải dùng giọng Google dự phòng vì Edge-TTS lỗi.")
    if tts.failed:
        log(f"[Giọng đọc] ⚠ {tts.failed} câu không tạo được âm thanh (sẽ im lặng ở các câu đó).")

    # Track tiếng được dựng + trộn ở luồng nền trong lúc luồng chính mã hóa video.
    audio_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio")
    audio_future = audio_pool.submit(
        build_audio, job, input_mp4, segments, tts, duration, bg_volume, media["has_audio"], prog
    )
    concat_list = None
    prog.set_stage("render")
    if encode:
        what = " + ".join(x for x in ["in phụ đề" if burn_sub else "", "xóa logo" if delogo_vf else ""] if x)
        log(f"[Xuất video] Mã hóa lại theo từng phần {int(PART_SEC // 60)} phút ({what})...")
        concat_list = render_parts(job, input_mp4, segments, duration, burn_sub, delogo_vf, sig, prog)
    prog.render = 1.0
    prog.note = ""
    mix = audio_future.result()
    audio_pool.shutdown()
    prog.audio = 1.0
    prog.set_stage("mux")
    log("[Xuất video] Ghép hình và tiếng lồng (tốc độ gốc 1.0x)...")
    mux_final(job, input_mp4, concat_list, mix, out_mp4, duration, prog)
    tts.pool.shutdown()

    size_mb = round(out_mp4.stat().st_size / (1024 * 1024), 2)
    update_dubbed_index(
        {
            "job_id": job_id,
            "project_id": story_project_id,
            "title": input_mp4.name,
            "speed": speed,
            "voice": voice,
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "segment_count": len(segments),
            "untranslated": untranslated,
            "duration_sec": round(duration),
            "resolution": f"{media['w']}x{media['h']}",
            "size_mb": size_mb,
            "cache_mb": dir_size_mb(job.work),
            "mp4_file": out_mp4.name,
            "srt_file": out_srt.name,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
    )
    prog.mux = 1.0
    prog.emit(force=True)
    job.save_meta(status="done", pct=100, label="Hoàn tất", error="")
    if untranslated:
        log(f"[Lưu ý] {untranslated} câu chưa có lời dịch — mở 'Sửa lời' để bổ sung rồi xuất lại.")
    log(f"[HOÀN TẤT] Đã xuất bản lồng tiếng: {out_mp4.name} ({size_mb} MB | {len(segments)} câu thoại)")
    return 0


def _stop_children() -> None:
    for proc in list(CHILDREN):
        try:
            proc.kill()
        except OSError:
            pass


def _raise_interrupt(*_):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _raise_interrupt)
    code = 1
    try:
        code = main()
    except KeyboardInterrupt:
        log("[Đã dừng] Tiến độ đã được lưu — bấm Tiếp tục để chạy tiếp từ chỗ đang dở.")
        if JOB and not RERENDER:
            JOB.save_meta(status="stopped")
        code = 130
    except Exception as exc:
        log(f"[Lỗi] {exc}")
        if JOB:
            JOB.save_meta(error=str(exc)[:500], **({} if RERENDER else {"status": "error"}))
    _stop_children()
    sys.stdout.flush()
    os._exit(code)  # không chờ các luồng nền (dịch/TTS) đang dở khi dừng hoặc lỗi
