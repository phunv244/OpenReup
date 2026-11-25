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
  - Chạy mới / tiếp tục:  dub_video.py --input <mp4> --speed 0.5 --voice "vieneu:Thiện Minh"
  - Xuất lại sau khi sửa: dub_video.py --project <job_id>   (bỏ qua nhận diện & dịch)
"""

import argparse
import bisect
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
from typing import Callable, Dict, List, Optional, Tuple

from subtitles import build_ass, build_subcover_filter, clean_style, sub_events, subtitles_filter  # noqa: F401 (tests dùng d.build_subcover_filter)

BASE_DIR = Path(__file__).resolve().parent
DUB_OUT_DIR = BASE_DIR / "downloads" / "dubbed"
PROJECTS_DIR = BASE_DIR / "data" / "dub_projects"
STORY_PROJECTS_DIR = BASE_DIR / "data" / "projects"
DB_PATH = BASE_DIR / "data" / "openreup.db"  # câu thoại của mọi bản lồng tiếng (server.mjs đọc/sửa cùng file này)
DUBBED_INDEX_JSON = BASE_DIR / "data" / "dubbed.json"
WORK_ROOT = BASE_DIR / "data" / "dub_work"
AGY_BIN = shutil.which("agy") or str(Path.home() / ".local" / "bin" / "agy")

SAMPLE_RATE = 24000  # track lồng tiếng: PCM 16-bit mono
STT_PAD_SEC = 30.0  # giải mã dư ra để tìm khoảng lặng mà cắt khối, không cắt giữa câu
PART_SEC = 600.0  # độ dài mỗi phần video khi phải mã hóa lại (in phụ đề / xóa logo)
TRANSLATE_BATCH = 45
AUDIO_PART_SEGS = 150  # số câu thoại trong 1 phần track tiếng = số input của 1 lệnh ffmpeg
ENCODE_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]

NARRATOR_ZH = "旁白"  # nhãn AI dùng cho lời dẫn truyện ở trường "who"
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
                    "who": {"type": "string"},
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
                    "personality": {"type": "string"},
                },
                "required": ["zh", "vi"],
            },
        },
        "character_notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"zh": {"type": "string"}, "personality": {"type": "string"}},
                "required": ["zh", "personality"],
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


def open_db():
    """SQLite cho câu thoại: video 90 tiếng (>100k câu) sửa 1 câu không phải ghi lại cả file JSON.
    Lược đồ phải khớp với server.mjs (openDb)."""
    import sqlite3

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")  # server đọc được trong lúc tiến trình này ghi
    db.execute(
        """CREATE TABLE IF NOT EXISTS segments (
             job_id TEXT NOT NULL, id INTEGER NOT NULL, start_s REAL NOT NULL, end_s REAL NOT NULL,
             zh TEXT NOT NULL DEFAULT '', vi TEXT NOT NULL DEFAULT '', speaker TEXT NOT NULL DEFAULT '',
             PRIMARY KEY (job_id, id)) WITHOUT ROWID"""
    )
    return db


def save_segments(job_id: str, segments: List[Dict]) -> None:
    """Thay toàn bộ câu thoại của 1 job trong 1 giao dịch (lỗi giữa chừng thì bản cũ còn nguyên)."""
    db = open_db()
    try:
        with db:
            db.execute("DELETE FROM segments WHERE job_id = ?", (job_id,))
            db.executemany(
                "INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(job_id, s.get("id") or i, s["start"], s["end"], s.get("zh", ""), s.get("vi", ""), s.get("speaker", ""))
                 for i, s in enumerate(segments, start=1)],
            )
    finally:
        db.close()


def load_segments(job_id: str) -> List[Dict]:
    db = open_db()
    try:
        rows = db.execute(
            "SELECT id, start_s, end_s, zh, vi, speaker FROM segments WHERE job_id = ? ORDER BY start_s, id", (job_id,)
        ).fetchall()
    finally:
        db.close()
    out = []
    for i, a, b, zh, vi, spk in rows:
        seg = {"id": i, "start": a, "end": b, "zh": zh, "vi": vi}
        if spk:
            seg["speaker"] = spk
        out.append(seg)
    return out


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

    import asr

    spec = asr.get(model_size)
    if not asr.installed(spec):
        raise RuntimeError(f"Chưa tải mô hình nhận diện '{spec['name']}'. Mở mục 'Mô hình nhận diện' để tải về.")
    sherpa = spec["engine"] == "sherpa"
    if sherpa:
        speed = 1.0  # SenseVoice/Paraformer/FireRed nghe được thoại nhanh, không cần làm chậm

    names = [c["zh"] for c in story_ctx.get("characters", []) if c.get("zh")]
    names += [g["zh"] for g in story_ctx.get("glossary", [])[:8] if g.get("zh")]
    prompt = ("普通话对白：" + "，".join(names[:40])) if names else "钓鱼动画楚新钓普通话对白"

    if sherpa:
        log(f"[Nhận diện] Nạp {spec['name']} (sherpa-onnx, CPU) — lọc giọng nói bằng {asr.VAD_BY_ID[asr.vad_choice()]['name']}.")
        model = None
    else:
        from faster_whisper import WhisperModel

        gpu = asr.cuda_devices() > 0
        log(f"[Nhận diện] Nạp {spec['name']} trên {'GPU' if gpu else 'CPU'} — tách âm chậm {speed}x, quy đổi mốc giờ về tốc độ gốc 1.0x.")
        threads = max(2, min(8, (os.cpu_count() or 4) - 2))
        model = WhisperModel(spec["repo"], device="cuda" if gpu else "cpu",
                             compute_type="int8_float16" if gpu else "int8", cpu_threads=threads)
    verbose = duration <= 900
    total_segs = sum(len(c["segments"]) for c in chunks)

    while t < duration - 0.5:
        win_end = min(duration, t + chunk_sec + STT_PAD_SEC)
        is_last = win_end >= duration - 0.01
        audio = decode_audio_window(input_mp4, t, win_end - t, speed)
        words: List[Dict] = []
        if sherpa and len(audio) > 1600:
            def on_progress(tt: float) -> None:
                prog.stt = min(1.0, min(tt, t + chunk_sec) / prog.duration)
                prog.emit()

            words = asr.sherpa_words(model_size, audio, t, on_progress)
        elif len(audio) > 1600:
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
        # Bỏ "câu" chỉ có dấu câu (SenseVoice đôi khi tách riêng dấu "。")
        segs = [x for x in words_to_segments([w for w in words if w["s"] < cut]) if re.search(r"\w", x["zh"])]
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

    def __init__(self, job: Job, story_ctx: Dict, project_id: str, workers: int, prog: Progress, on_chunk_done, agy_model: str = "",
                 ask_who: bool = False):
        self.job = job
        self.ask_who = ask_who  # chỉ hỏi AI "ai nói câu này" khi lồng tiếng nhiều giọng (bước phân vai cần)
        self.agy_model = agy_model  # "" = model mặc định của Antigravity (id đã gồm mức suy nghĩ, vd gemini-4-neon-high)
        self.ctx = story_ctx or {}
        self.project_id = project_id
        self.prog = prog
        self.on_chunk_done = on_chunk_done or (lambda chunk: None)
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="translate")
        self.lock = threading.Lock()
        self.chars: List[Dict] = list(self.ctx.get("characters") or [])
        self.gloss: List[Dict] = list(self.ctx.get("glossary") or [])
        self.new_chars: List[Dict] = []
        self.new_gloss: List[Dict] = []
        self.new_notes: Dict[str, str] = {}  # {tên gốc: tính cách} AI vừa rút ra, chờ ghi vào dự án
        self.summaries: List[str] = list(job.meta.get("summaries") or [])
        self.fail_streak = 0
        self.failed_segs = 0
        self.fatal: Optional[str] = None
        self.futures: List = []
        self.memory_lock = threading.Lock()
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
            f"- {c.get('zh')} -> {c.get('vi')} ({c.get('role', '')}; xưng hô: {c.get('pronouns', '')}"
            + (f"; tính cách: {c['personality']}" if c.get("personality") else "") + ")" for c in chars
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
                # Model chọn tay: id đã chứa mức suy nghĩ. Chưa chọn thì giữ cách cũ: model mặc định, suy nghĩ thấp (nhanh).
                *(["--model", self.agy_model] if self.agy_model else ["--effort", "low"]),
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
            "'new_characters' / 'new_glossary' (nếu không có thì để mảng rỗng []).\n"
            + ("6. Với mỗi câu, điền 'who' = tên gốc tiếng Trung của nhân vật ĐANG NÓI câu đó, viết đúng như trong danh sách "
               f"Nhân vật (hoặc như trong 'new_characters' nếu là nhân vật mới). Lời dẫn truyện điền '{NARRATOR_ZH}'. Không chắc thì để ''.\n"
               if self.ask_who else "6. KHÔNG điền trường 'who'.\n")
            + "7. 'character_notes': tính cách / cách nói của nhân vật thể hiện qua lời thoại đoạn này (tối đa 15 từ mỗi nhân vật), "
            "chỉ ghi cho nhân vật CHƯA có 'tính cách' ở ngữ cảnh trên; nhân vật mới thì điền luôn 'personality'.\n\n"
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
                        vi_map[int(item["id"])] = ((item.get("vi") or "").strip(), str(item.get("who") or "").strip())
                    except (KeyError, TypeError, ValueError):
                        continue
                got = 0
                for i, seg in enumerate(batch):
                    if vi_map.get(i + 1, ("",))[0]:
                        seg["vi"] = vi_map[i + 1][0]
                        if self.ask_who:
                            seg["who"] = vi_map[i + 1][1]
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
                    item = {"zh": zh, "vi": vi, "role": (nc.get("role") or "").strip(), "pronouns": (nc.get("pronouns") or "").strip(),
                            "personality": (nc.get("personality") or "").strip()[:160]}
                    self.chars.append(item)
                    self.new_chars.append(item)
                    known.add(zh)
            # Tính cách AI rút ra từ lời thoại: chỉ điền khi nhân vật chưa có ghi chú (không đè lời người dùng viết).
            by_zh = {c.get("zh", "").strip(): c for c in self.chars}
            for note in (ai_out.get("character_notes") or [])[:6]:
                c, txt = by_zh.get(str(note.get("zh") or "").strip()), str(note.get("personality") or "").strip()[:160]
                if c and txt and not c.get("personality"):
                    c["personality"] = txt
                    self.new_notes[c["zh"]] = txt
            known = {g.get("zh", "").strip() for g in self.gloss}
            for ng in (ai_out.get("new_glossary") or [])[:5]:
                zh, vi = (ng.get("zh") or "").strip(), (ng.get("vi") or "").strip()
                if zh and vi and zh not in known and len(self.gloss) < self.MAX_GLOSS:
                    item = {"zh": zh, "vi": vi}
                    self.gloss.append(item)
                    self.new_gloss.append(item)
                    known.add(zh)

    def submit_chunk(self, chunk: Dict) -> None:
        if self.fatal:  # đừng để Whisper chạy tiếp hàng giờ khi phần dịch đã hỏng hẳn
            raise RuntimeError(self.fatal)
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
        with self.memory_lock:  # 2 luồng dịch xong cùng lúc không được đọc-ghi file dự án chồng nhau
            self._persist_memory(final)

    def _persist_memory(self, final: bool) -> None:
        with self.lock:
            add_chars, add_gloss, notes_add = self.new_chars, self.new_gloss, self.new_notes
            self.new_chars, self.new_gloss, self.new_notes = [], [], {}
            summaries = list(self.summaries)
        if not (add_chars or add_gloss or notes_add or final):
            return
        p = STORY_PROJECTS_DIR / f"{Path(self.project_id).name}.json"
        proj = read_json(p, None)
        if not proj:
            return
        have = {c.get("zh", "").strip() for c in proj.get("characters") or []}
        proj["characters"] = (proj.get("characters") or []) + [c for c in add_chars if c["zh"] not in have]
        for c in proj["characters"]:
            if notes_add.get(c.get("zh", "").strip()) and not c.get("personality"):
                c["personality"] = notes_add[c["zh"].strip()]
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
# Bước 4: Giọng đọc tiếng Việt (VieNeu-TTS chạy trên máy) — cache theo nội dung câu
# ----------------------------------------------------------------------------
VOICES_DIR = BASE_DIR / "data" / "voices"


class VieNeuEngine:
    """VieNeu-TTS v3 Turbo chạy offline trên CPU (ONNX). Giọng:
    - "vieneu:<tên preset>"   vd vieneu:Hải Đăng
    - "vieneu-clone:<slug>"   clone từ data/voices/<slug>.wav (clip 3–8 giây, 1 người nói)
    Mô hình chiếm hết nhân CPU nên chỉ chạy 1 câu tại 1 thời điểm (khóa bên dưới)."""

    _model = None
    _load_lock = threading.Lock()
    _infer_lock = threading.Lock()  # 1 mô hình dùng chung cho mọi giọng, chạy lần lượt từng câu

    def __init__(self, voice: str):
        try:
            import vieneu  # noqa: F401 — báo lỗi ngay từ đầu thay vì lỗi lặp lại ở từng câu
        except ImportError:
            raise RuntimeError("Chưa cài VieNeu-TTS: chạy  uv pip install --python .venv/bin/python vieneu")
        kind, _, name = voice.partition(":")
        self.ref_audio: Optional[str] = None
        self.preset: Optional[str] = None
        if kind == "vieneu-clone":
            if not re.fullmatch(r"[a-z0-9_-]+", name):
                raise ValueError(f"Tên giọng clone không hợp lệ: {name!r}")
            ref = VOICES_DIR / f"{name}.wav"
            if not ref.exists():
                raise FileNotFoundError(f"Không thấy file giọng mẫu {ref}")
            self.ref_audio = str(ref)
        elif kind == "vieneu" and name:
            self.preset = name
        else:
            raise ValueError(f"Giọng không hợp lệ: {voice!r} (chỉ dùng vieneu:<preset> hoặc vieneu-clone:<slug>)")

    @classmethod
    def model(cls):
        with cls._load_lock:
            if cls._model is None:
                from vieneu import Vieneu

                log("[Giọng đọc] Đang nạp mô hình VieNeu-TTS (lần đầu ~10–20 giây)...")
                cls._model = Vieneu()
        return cls._model

    def synth_mp3(self, text: str, out: Path) -> bool:
        tts = self.model()
        with self._infer_lock:
            # Giọng clone: lần đầu lọc nhiễu + trích đặc trưng giọng, sau đó VieNeu tự nhớ (cache theo nội dung file).
            wav = tts.infer(text, ref_audio=self.ref_audio) if self.ref_audio else tts.infer(text, voice=self.preset)
        if wav is None or len(wav) < tts.sample_rate * 0.1:
            return False
        # mp3 CBR không thẻ ID3: mp3_duration() đọc được thời lượng ngay từ header, không cần ffprobe.
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(tts.sample_rate), "-ac", "1", "-i", "-",
             "-ar", str(SAMPLE_RATE), "-b:a", "64k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", str(out)],
            input=wav.astype("float32").tobytes(), check=True,
        )
        return out.exists() and out.stat().st_size > 200


# Giọng VieNeu tự gán cho các nhân vật phụ (nhân vật nói nhiều nhất dùng giọng người dùng chọn).
AUTO_VOICES = {
    "male": ["vieneu:Thiện Minh", "vieneu:Hải Đăng", "vieneu:Quang Sơn", "vieneu:Thái Sơn",
             "vieneu:Thiền Tâm Đức", "vieneu:Đức Trí", "vieneu:Minh Đức", "vieneu:Phạm Tuyên"],
    "female": ["vieneu:Ngọc Huyền", "vieneu:Trúc Ly", "vieneu:Quỳnh Anh", "vieneu:Ngọc Trân",
               "vieneu:Mai Anh", "vieneu:Mỹ Duyên", "vieneu:Thùy Dung", "vieneu:Đoan Trang"],
}
DIAR_WINDOW_SEC = 600.0     # đọc audio gốc từng cửa sổ 10 phút: video 90 tiếng cũng không tràn RAM
DIAR_MAX_FIT = 3000         # gom nhóm trên tối đa 3000 câu dài nhất, các câu còn lại gán theo tâm nhóm
DIAR_DISTANCE = 0.62        # khoảng cách cosine tối đa trong 1 nhóm (đo trên video thử: 0.6–0.7 tách đúng 2 người)
DIAR_MAX_SPEAKERS = 8


def cluster_speakers(emb, durs):
    """Gom câu thành nhân vật theo đặc trưng giọng (vector đã chuẩn hóa). Trả mảng nhãn 0..k-1,
    nhãn 0 là người nói nhiều nhất. Câu < 1 giây (đặc trưng kém) chỉ được gán theo nhóm gần nhất."""
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering

    n = len(emb)
    if n == 0:
        return np.zeros(0, dtype=int)
    order = np.argsort(-durs)
    fit = [i for i in order[:DIAR_MAX_FIT] if durs[i] >= 1.0] or list(order[:DIAR_MAX_FIT])
    if len(fit) < 2:
        return np.zeros(n, dtype=int)
    lab = AgglomerativeClustering(
        n_clusters=None, metric="cosine", linkage="average", distance_threshold=DIAR_DISTANCE
    ).fit_predict(emb[fit])
    groups = [np.array(fit)[lab == k] for k in range(lab.max() + 1)]
    # Bỏ nhóm vụn (< 4% thời lượng lời và < 3 câu: thường là tiếng hét/cười/nhạc), giữ tối đa N nhân vật.
    total = durs[fit].sum()
    groups.sort(key=lambda g: -durs[g].sum())
    keep = [g for g in groups if durs[g].sum() >= total * 0.04 or len(g) >= 3][:DIAR_MAX_SPEAKERS] or groups[:1]
    cents = np.stack([emb[g].mean(axis=0) for g in keep])
    cents /= np.linalg.norm(cents, axis=1, keepdims=True) + 1e-9
    return np.argmax(emb @ cents.T, axis=1)


def diarize(input_mp4: Path, segments: List[Dict], prog: "Progress") -> int:
    """Ghi s["speaker"] = "NV1".."NVk" cho từng câu và s["_f0"] (cao độ trung vị, Hz). Trả số nhân vật."""
    import numpy as np

    enc = VieNeuEngine.model().engine._ensure_speaker_encoder()
    sr = 16000
    emb = np.zeros((len(segments), 0), dtype=np.float32)
    rows, f0s = [], []
    i = 0
    t = 0.0
    end_all = segments[-1]["end"] if segments else 0
    while i < len(segments):
        w0 = segments[i]["start"]
        j = i
        while j < len(segments) and segments[j]["end"] - w0 <= DIAR_WINDOW_SEC:
            j += 1
        j = max(j, i + 1)
        w1 = segments[j - 1]["end"]
        raw = run_cmd(["ffmpeg", "-v", "error", "-ss", f"{w0:.3f}", "-to", f"{w1 + 0.05:.3f}", "-i", str(input_mp4),
                       "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"])
        y = np.frombuffer(raw, dtype=np.float32)
        for s in segments[i:j]:
            clip = y[int((s["start"] - w0) * sr): int((s["end"] - w0) * sr)]
            if len(clip) < sr * 0.8:  # câu rất ngắn: lặp lại cho đủ độ dài tối thiểu của bộ trích giọng
                clip = np.tile(clip, int(np.ceil(sr * 0.8 / max(1, len(clip)))))[: int(sr * 0.8)] if len(clip) else np.zeros(int(sr * 0.8), np.float32)
            e = np.asarray(enc.embed(clip.astype(np.float32), sr), dtype=np.float32).reshape(-1)
            rows.append(e / (np.linalg.norm(e) + 1e-9))
            f0s.append(_median_f0(clip, sr))
        i = j
        t = w1
        prog.note = f"Phân biệt nhân vật {fmt_clock(t)} / {fmt_clock(end_all)}"
        prog.emit()
    emb = np.stack(rows)
    durs = np.array([s["end"] - s["start"] for s in segments])
    labels = cluster_speakers(emb, durs)
    for s, lab, f0 in zip(segments, labels, f0s):
        s["speaker"] = f"NV{lab + 1}"
        s["_f0"] = f0
    prog.note = ""
    return int(labels.max()) + 1 if len(labels) else 0


def _median_f0(clip, sr: int) -> float:
    import numpy as np
    import librosa

    if len(clip) < sr * 0.2:
        return 0.0
    f0 = librosa.yin(clip, fmin=70, fmax=450, sr=sr, frame_length=1024)
    f0 = f0[(f0 > 72) & (f0 < 445)]  # yin trả biên khi khung không có giọng
    return float(np.median(f0)) if len(f0) else 0.0


# Ranh giới nam/nữ theo cao độ trung vị. Giọng nam lồng hoạt hình hay lên 170–180 Hz (đo trên video thử), nữ thường > 200.
FEMALE_F0 = 185


def voice_gender(voice: str) -> str:
    """"male" / "female" / "" (không rõ) của 1 giọng: giọng clone đọc từ data/voices.json, preset theo danh sách."""
    if voice.startswith("vieneu-clone:"):
        slug = voice.split(":", 1)[1]
        return next((v.get("gender", "") for v in read_json(VOICES_DIR.parent / "voices.json", []) if v.get("slug") == slug), "")
    if voice in AUTO_VOICES["male"]:
        return "male"
    if voice in AUTO_VOICES["female"]:
        return "female"
    return ""


def match_characters(segments: List[Dict], characters: List[Dict], known_zh) -> Dict[str, Dict]:
    """Phân vai: nhóm giọng NVk (máy tách theo âm sắc) là nhân vật nào trong truyện? Bỏ phiếu theo thời lượng các câu
    AI đã ghi 'who' lúc dịch. Trả {"NV1": {"zh", "name", "is_new", "voice"}} — chỉ gồm nhóm đoán được (>= 2 câu và
    >= 50% thời lượng có ghi tên). "is_new": nhân vật chưa có trong ngữ cảnh dự án trước video này."""
    by_zh = {c.get("zh", "").strip(): c for c in characters if c.get("zh")}
    votes: Dict[str, Dict[str, List[float]]] = {}
    for s in segments:
        who = str(s.get("who") or "").strip()
        if who:
            v = votes.setdefault(s.get("speaker", "NV1"), {}).setdefault(who, [0.0, 0])
            v[0] += s["end"] - s["start"]
            v[1] += 1
    out: Dict[str, Dict] = {}
    for spk, tally in votes.items():
        who, (dur, n) = max(tally.items(), key=lambda kv: kv[1][0])
        if n < 2 or dur < 0.5 * sum(v[0] for v in tally.values()):
            continue
        if who == NARRATOR_ZH:
            out[spk] = {"zh": who, "name": "Dẫn truyện", "is_new": False, "voice": ""}
        elif who in by_zh:
            c = by_zh[who]
            voice = c.get("voice") or ""
            out[spk] = {"zh": who, "name": c.get("vi") or who, "is_new": who not in known_zh,
                        "voice": voice if voice.startswith(("vieneu:", "vieneu-clone:")) else ""}
    return out


def save_character_voices(project_id: str, voices: Dict[str, str]) -> None:
    """Ghi giọng máy vừa tự chọn vào nhân vật chưa có giọng trong dự án, để các video sau dùng lại đúng giọng đó."""
    p = STORY_PROJECTS_DIR / f"{Path(project_id).name}.json"
    proj = read_json(p, None) if project_id and voices else None
    if not proj:
        return
    n = 0
    for c in proj.get("characters") or []:
        v = voices.get(c.get("zh", "").strip())
        if v and not c.get("voice"):
            c["voice"] = v
            n += 1
    if n:
        write_json_atomic(p, proj, indent=2)
        log(f"[Nhân vật] Đã ghi giọng tự chọn cho {n} nhân vật vào ngữ cảnh dự án (đổi được trong Ngữ cảnh AI).")


def auto_voice_map(segments: List[Dict], main_voice: str, project_voices: Optional[List[str]] = None,
                   fixed: Optional[Dict[str, str]] = None) -> Dict[str, Dict]:
    """{"NV1": {"voice", "gender", "f0", "lines"}, ...}: NV1 (nói nhiều nhất) giữ giọng đã chọn. Nhân vật khác
    nhận giọng chưa dùng, cùng giới tính đoán từ cao độ (> FEMALE_F0 Hz: nữ/trẻ em): ưu tiên giọng của dự án
    (để đồng bộ với kênh), hết mới lấy giọng VieNeu có sẵn."""
    import numpy as np

    mine = [v for v in project_voices or [] if v != main_voice]

    stats: Dict[str, Dict] = {}
    for s in segments:
        st = stats.setdefault(s.get("speaker", "NV1"), {"f0": [], "lines": 0, "dur": 0.0})
        st["lines"] += 1
        st["dur"] += s["end"] - s["start"]
        if s.get("_f0"):
            st["f0"].append(s["_f0"])
    fixed = fixed or {}  # {"NV2": giọng đã cấu hình cho nhân vật trong ngữ cảnh dự án}
    used = {main_voice, *fixed.values()}
    out: Dict[str, Dict] = {}
    for spk in sorted(stats, key=lambda k: -stats[k]["dur"]):
        st = stats[spk]
        f0 = round(float(np.median(st["f0"]))) if st["f0"] else 0
        gender = "female" if f0 > FEMALE_F0 else "male"
        if spk in fixed:
            voice = fixed[spk]
        elif not out:
            voice = main_voice
        else:
            other = "male" if gender == "female" else "female"
            pool = (
                [v for v in mine if v not in used and voice_gender(v) in (gender, "")]
                or [v for v in AUTO_VOICES[gender] if v not in used]
                or [v for v in mine + AUTO_VOICES[other] if v not in used]
                or [main_voice]
            )
            voice = pool[0]
        used.add(voice)
        out[spk] = {"voice": voice, "gender": gender, "f0": f0, "lines": st["lines"]}
    return out


class TTS:
    def __init__(self, cache_dir: Path, voice: str, workers: int, prog: Progress):
        self.cache_dir = cache_dir
        self.voice = voice
        self.prog = prog
        self.voice_map: Dict[str, str] = {}  # nhân vật -> giọng; trống = mọi câu dùng `voice`
        self.engines: Dict[str, VieNeuEngine] = {}
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="tts")
        self.lock = threading.Lock()
        self.engine(voice)  # báo lỗi cài đặt / tên giọng ngay từ đầu
        self.failed = 0
        self.prewarmed: List = []

    def engine(self, voice: str) -> "VieNeuEngine":
        with self.lock:
            if voice not in self.engines:
                self.engines[voice] = VieNeuEngine(voice)
            return self.engines[voice]

    def voice_for(self, seg: Dict) -> str:
        return self.voice_map.get(seg.get("speaker", ""), self.voice)

    def item(self, seg: Dict):
        """(lời Việt, giọng) của 1 câu — đơn vị mà cache giọng đọc làm khóa."""
        return seg.get("vi", ""), self.voice_for(seg)

    def path(self, text: str, voice: Optional[str] = None) -> Path:
        h = hashlib.sha1(f"{voice or self.voice}|{text}".encode("utf-8")).hexdigest()
        return self.cache_dir / h[:2] / f"{h}.mp3"

    def ensure(self, text: str, voice: Optional[str] = None) -> Optional[Path]:
        """Trả về file mp3 của câu (tạo nếu chưa có). Gọi lại nhiều lần / từ nhiều luồng đều an toàn."""
        text = (text or "").strip()
        voice = voice or self.voice
        if not text or not re.search(r"\w", text):
            return None
        out = self.path(text, voice)
        if out.exists() and out.stat().st_size > 200:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f"{out.stem}.{threading.get_ident()}.tmp.mp3")
        try:
            for attempt in range(3):
                try:
                    if self.engine(voice).synth_mp3(text, tmp):
                        os.replace(tmp, out)
                        return out
                except Exception as e:
                    log(f"[Giọng đọc] VieNeu lỗi câu \"{text[:40]}\" (lần {attempt + 1}): {e}")
            with self.lock:
                self.failed += 1
            return None
        finally:
            tmp.unlink(missing_ok=True)

    def cached(self, text: str, voice: Optional[str] = None) -> Optional[Path]:
        """File mp3 đã có của câu, không thử tạo lại (ensure_all đã thử đủ số lần rồi)."""
        text = (text or "").strip()
        out = self.path(text, voice) if text else None
        return out if out and out.exists() else None

    def prewarm(self, items) -> None:
        """Tạo giọng đọc ở luồng nền ngay khi 1 khối vừa dịch xong, không chờ hết video. items: [(lời, giọng)]."""
        items = [it for it in items if it[0]]
        with self.prog.lock:
            self.prog.tts_total += len(items)
        self.prewarmed += [self.pool.submit(self._ensure_counted, it) for it in items]

    def _ensure_counted(self, item) -> Optional[Path]:
        try:
            return self.ensure(*item)
        finally:
            self.prog.bump("tts_done")

    def ensure_all(self, items) -> List[Optional[Path]]:
        for f in self.prewarmed:  # chờ lượt chạy nền xong để không tạo trùng 1 câu 2 lần
            f.result()
        self.prewarmed = []
        with self.prog.lock:
            self.prog.tts_total, self.prog.tts_done = len(items), 0
        return list(self.pool.map(self._ensure_counted, items))


MP3_BITRATES = {
    True: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  # MPEG-1 Layer III
    False: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],  # MPEG-2 / 2.5 Layer III
}


def mp3_duration(path: Path) -> float:
    """Thời lượng 1 câu TTS. File VieNeu là luồng mp3 CBR thô nên tính được ngay từ header (không tốn 1 lần
    chạy ffprobe cho mỗi câu trong 100k câu); file mp3 khác (có thẻ ID3/khung Info) thì hỏi ffprobe."""
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
            # có/không có giọng cũng nằm trong khóa: câu từng tạo giọng lỗi sẽ được dựng lại khi đã có giọng
            json.dumps(
                [t0, t1, [[s["start"], *tts.item(s), bool(tts.cached(*tts.item(s)))] for s in part_segs]]
            ).encode()
        ).hexdigest()[:12]
        jobs.append((k, t0, t1, part_segs, adir / f"a{k:05d}_{key}.flac"))
    done = 0

    def build(item) -> None:
        nonlocal done
        k, t0, t1, part_segs, part = item
        if not part.exists():
            for stale in adir.glob(f"a{k:05d}_*"):
                stale.unlink(missing_ok=True)
            inputs, graph, _ = audio_part_graph(part_segs, [tts.cached(*tts.item(s)) for s in part_segs], t0, t1)
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
    for n, (start, end, txt) in enumerate(sub_events(segments, offset, window), 1):
        lines += [str(n), f"{fmt_srt_time(start)} --> {fmt_srt_time(end)}", txt, ""]
    return "\n".join(lines)


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
    job: Job, input_mp4: Path, segments: List[Dict], duration: float, burn_sub: bool, delogo_vf: str, sig, prog: Progress,
    cover_vf: str = "", subcover: str = "none", sub_style: Optional[Dict] = None, size: Tuple[int, int] = (0, 0),
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
    starts = [s["start"] for s in segments]
    for k in range(n_parts):
        t0 = k * PART_SEC
        dur = min(PART_SEC, duration - t0)
        # chỉ xét các câu quanh phần này (câu dài nhất vài giây) thay vì quét cả 100k câu cho mỗi phần
        near = segments[bisect.bisect_left(starts, t0 - 60) : bisect.bisect_left(starts, t0 + dur)]
        ass_txt = build_ass(sub_events(near, offset=t0, window=dur), size[0], size[1], subcover, sub_style) if burn_sub else ""
        key = hashlib.sha1(json.dumps([sig, t0, dur, ass_txt, delogo_vf, encode_args] + ([cover_vf] if cover_vf else [])).encode()).hexdigest()[:12]
        part = job.parts_dir / f"p{k:05d}_{key}.mp4"
        keep.append(part)
        if part.exists():
            done_before += 1
            prog.render = (k + 1) / n_parts
            continue
        for stale in job.parts_dir.glob(f"p{k:05d}_*"):
            stale.unlink(missing_ok=True)
        filters = [f for f in (delogo_vf, cover_vf) if f]
        if ass_txt:
            ass_path = job.parts_dir / f"p{k:05d}.ass"
            ass_path.write_text(ass_txt, encoding="utf-8")
            filters.append(subtitles_filter(ass_path))
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
    parser.add_argument("--voice", default="vieneu:Thiện Minh", help="Giọng VieNeu: vieneu:<preset> hoặc vieneu-clone:<slug>")
    parser.add_argument("--model", default="sensevoice-small", help="Mô hình nhận diện (xem: asr.py list)")
    parser.add_argument("--bg-volume", type=float, default=0.06, help="Âm lượng âm thanh gốc giữ lại (0.0 = tắt hẳn)")
    parser.add_argument("--no-sub", action="store_true", help="Không in cứng phụ đề tiếng Việt lên video")
    parser.add_argument("--delogo", default="none", help="Xóa logo ngay khi xuất: none | top-right | top-left | both-top | x,y,w,h")
    parser.add_argument("--subcover", default="none", help="Che phụ đề gốc (làm mờ) ở vùng x,y,w,h; phụ đề Việt hiện trong vùng này")
    parser.add_argument("--sub-style", default="", help="Kiểu phụ đề Việt (JSON: font, color, bg, bg_opacity, outline, outline_width...); rỗng = mặc định")
    parser.add_argument("--agy-model", default="", help="Model Antigravity dùng để dịch (xem: agy models); rỗng = mặc định")
    parser.add_argument("--multi-voice", action="store_true",
                        help="Tự phân biệt nhân vật theo giọng nói gốc, mỗi nhân vật một giọng VieNeu")
    parser.add_argument("--only", choices=["video", "audio"], default="",
                        help="Chỉ với --project: 'video' = chỉ mã hóa lại hình (giữ nguyên tiếng đã xuất), 'audio' = chỉ dựng lại tiếng (giữ nguyên hình đã xuất)")
    parser.add_argument("--fresh", action="store_true", help="Bỏ kết quả dở dang, nhận diện & dịch lại từ đầu")
    parser.add_argument("--chunk-min", type=float, default=10.0, help="Độ dài mỗi khối nhận diện (phút)")
    parser.add_argument("--translate-workers", type=int, default=3, help="Số lô dịch chạy song song")
    # VieNeu chạy lần lượt từng câu (1 mô hình dùng hết CPU); luồng thứ 2 chỉ để nối phần mã hóa mp3 của câu trước.
    parser.add_argument("--tts-workers", type=int, default=2, help="Số luồng tạo giọng đọc")
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
        subcover = proj.get("subcover") or "none"
        agy_model = proj.get("agy_model") or ""
        sub_style = clean_style(proj.get("sub_style"))
        story_project_id = proj.get("project_id", "")
        multi_voice = bool(proj.get("multi_voice"))
        speakers = proj.get("speakers") or {}
        # File project đời cũ còn chứa "segments" (server chuyển sang SQLite lúc khởi động; đây là đường dự phòng khi chạy tay).
        segments = load_segments(job_id) or sorted(proj.get("segments", []), key=lambda s: s["start"])
        log(f"[Xuất lại] Đọc {len(segments)} câu đã chỉnh sửa từ project {job_id}...")
    else:
        if not args.input:
            raise RuntimeError("Cần truyền --input <mp4> hoặc --project <job_id>")
        input_mp4 = Path(args.input).resolve()
        speed = max(0.25, min(1.5, args.speed))
        voice, bg_volume, burn_sub, delogo = args.voice, args.bg_volume, not args.no_sub, args.delogo
        subcover = args.subcover
        agy_model = args.agy_model
        try:
            sub_style = clean_style(json.loads(args.sub_style)) if args.sub_style else None
        except json.JSONDecodeError:
            raise RuntimeError("--sub-style không phải JSON hợp lệ")
        story_project_id = args.story_project or ""
        multi_voice = args.multi_voice
        speakers = {}
        stem = re.sub(r"[^0-9a-zA-Z_-]+", "_", input_mp4.stem)[:32].strip("_") or "video"
        if stem != input_mp4.stem:
            # Tên có chữ Trung / quá dài bị rút gọn: thêm mã băm để 2 video khác nhau không đè job của nhau.
            stem += "_" + hashlib.sha1(input_mp4.name.encode("utf-8")).hexdigest()[:6]
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
    cover_vf = build_subcover_filter(subcover, media["w"], media["h"])
    encode = burn_sub or bool(delogo_vf) or bool(cover_vf)

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
                    "delogo": delogo, "subcover": subcover, "project_id": story_project_id,
                    "multi_voice": multi_voice, "agy_model": agy_model, "sub_style": sub_style},
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
    tts = TTS(job.tts_dir, voice, args.tts_workers, prog)
    tts.voice_map = {k: v["voice"] for k, v in speakers.items()}
    out_mp4 = DUB_OUT_DIR / f"{job_id}.mp4"
    out_srt = DUB_OUT_DIR / f"{job_id}.srt"
    proj_path = PROJECTS_DIR / f"{job_id}.json"
    untranslated = 0
    # Xuất lại một nửa: lấy nửa còn lại từ bản đã xuất (copy, không mã hóa) — cần bản đã xuất còn nguyên.
    only = args.only if rerender and out_mp4.exists() else ""
    if args.only and not only:
        log("[Xuất lại] Không có bản đã xuất để tái sử dụng — chạy lại đầy đủ.")
    if only:
        log(f"[Xuất lại] Chỉ làm lại {'phần HÌNH' if only == 'video' else 'phần TIẾNG'}; {'tiếng' if only == 'video' else 'hình'} lấy lại từ bản đã xuất.")

    if not rerender:
        translator = Translator(
            job, story_ctx, story_project_id, args.translate_workers, prog, agy_model=agy_model, ask_who=multi_voice,
            # Nhiều giọng: chưa biết câu nào của ai cho tới khi nghe hết video, nên không tạo giọng trước.
            on_chunk_done=None if multi_voice else lambda c: tts.prewarm([tts.item(s) for s in c["segments"]]),
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
        if multi_voice:
            try:
                prog.set_stage("tts")
                log("[Nhân vật] Đang phân biệt người nói theo giọng gốc...")
                n = diarize(input_mp4, segments, prog)
                # Phân vai: nhóm giọng nào là nhân vật nào trong truyện; nhân vật đã cấu hình giọng thì dùng đúng giọng đó.
                cast = match_characters(segments, translator.chars, {c.get("zh", "").strip() for c in story_ctx.get("characters") or []})
                speakers = auto_voice_map(segments, voice, story_ctx.get("voices"), {k: c["voice"] for k, c in cast.items() if c["voice"]})
                # Máy hay tách 1 người thành 2 nhóm giọng (giọng thường / giọng hét): cùng 1 nhân vật thì dùng chung 1 giọng,
                # lấy theo nhóm nói nhiều nhất (speakers đã xếp theo thời lượng giảm dần).
                char_voice: Dict[str, str] = {}
                for k in speakers:
                    if k in cast:
                        c = cast[k]
                        speakers[k].update(zh=c["zh"], name=c["name"], is_new=c["is_new"])
                        speakers[k]["voice"] = char_voice.setdefault(c["zh"], speakers[k]["voice"])
                save_character_voices(story_project_id, {c["zh"]: speakers[k]["voice"] for k, c in cast.items() if not c["voice"] and c["zh"] != NARRATOR_ZH})
                tts.voice_map = {k: v["voice"] for k, v in speakers.items()}
                for k, v in speakers.items():
                    who = f" = {v['name']}{' (NHÂN VẬT MỚI)' if v.get('is_new') else ''}" if v.get("name") else " (chưa rõ là ai)"
                    log(f"[Nhân vật] {k}{who}: {v['lines']} câu, ~{v['f0']} Hz ({'nữ/trẻ' if v['gender'] == 'female' else 'nam'}) → {v['voice']}")
                log(f"[Nhân vật] Tìm thấy {n} nhân vật. Đổi giọng từng nhân vật trong 'Sửa lời' rồi xuất lại nếu cần.")
            except Exception as e:  # thiếu VieNeu / lỗi đọc audio: vẫn lồng tiếng được bằng 1 giọng
                log(f"[Nhân vật] ⚠ Không phân biệt được nhân vật ({e}) — dùng 1 giọng cho cả video.")
                multi_voice, speakers = False, {}
            for s in segments:
                s.pop("_f0", None)
                s.pop("who", None)
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
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "subcover": subcover,
            "agy_model": agy_model,
            "sub_style": sub_style,
            "multi_voice": multi_voice,
            "speakers": speakers,
            "orig_duration_sec": round(duration, 1),
            "dub_duration_sec": round(duration, 1),
            "resolution": f"{media['w']}x{media['h']}",
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    save_segments(job_id, segments)

    if only != "video":
        prog.set_stage("tts")
        log(f"[Giọng đọc] Tạo giọng tiếng Việt ({voice}) cho {len(segments)} câu (câu đã có trong cache được dùng lại)...")
        mp3_files = tts.ensure_all([tts.item(s) for s in segments])
        if tts.failed:
            log(f"[Giọng đọc] ⚠ {tts.failed} câu không tạo được âm thanh (sẽ im lặng ở các câu đó).")

    # Track tiếng được dựng + trộn ở luồng nền trong lúc luồng chính mã hóa video.
    audio_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio")
    if only == "video":
        mix_keep = job.work / "mix.m4a"

        def reuse_audio() -> Path:
            run_ffmpeg(["-i", str(out_mp4), "-vn", "-map", "0:a:0", "-c:a", "copy", "-f", "mp4", str(mix_keep)],
                       duration, lambda f: None, job.work / "mix_err.log")
            return mix_keep

        audio_future = audio_pool.submit(reuse_audio)
    else:
        audio_future = audio_pool.submit(
            build_audio, job, input_mp4, segments, tts, duration, bg_volume, media["has_audio"], prog
        )
    concat_list = None
    prog.set_stage("render")
    if only == "audio":
        concat_list = job.work / "parts.txt"
        concat_list.write_text(f"file '{out_mp4}'\n", encoding="utf-8")
    elif encode:
        what = " + ".join(x for x in ["in phụ đề" if burn_sub else "", "xóa logo" if delogo_vf else "",
                                      "che phụ đề gốc" if cover_vf else ""] if x)
        log(f"[Xuất video] Mã hóa lại theo từng phần {int(PART_SEC // 60)} phút ({what})...")
        concat_list = render_parts(
            job, input_mp4, segments, duration, burn_sub, delogo_vf, sig, prog, cover_vf, subcover, sub_style, (media["w"], media["h"])
        )
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
            "multi_voice": multi_voice,
            "speaker_count": len(speakers),
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "subcover": subcover,
            "agy_model": agy_model,
            "sub_style": sub_style,
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
