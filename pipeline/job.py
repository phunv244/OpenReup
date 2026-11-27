"""Job (thư mục làm việc + checkpoint meta.json) và Progress (dòng @@PROGRESS cho server)."""
import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from pipeline.paths import DATA_DIR
from pipeline.common import fmt_clock, log, read_json, write_json_atomic

WORK_ROOT = DATA_DIR / "dub_work"


# ----------------------------------------------------------------------------
# Job: thư mục làm việc + checkpoint + tiến độ
# ----------------------------------------------------------------------------
class Job:
    def __init__(self, job_id: str, work: Optional[Path] = None):
        self.job_id = job_id
        self.work = Path(work) if work else WORK_ROOT / job_id
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
