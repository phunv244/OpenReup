"""Lưu trữ dự án lồng tiếng: SQLite câu thoại, file project, dự án truyện, danh sách bản lồng tiếng, kiểm job_id.

Hằng số đường dẫn ở đây là mặc định, không bị đổi lúc chạy; tham số --out-dir/--project-file/--index-file/--story-dir
được gói vào StorePaths và truyền vào từng hàm."""
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from pipeline.paths import DATA_DIR, MEDIA_ROOT
from pipeline.common import read_json, write_json_atomic

DUB_OUT_DIR = MEDIA_ROOT / "downloads" / "dubbed"

PROJECTS_DIR = DATA_DIR / "dub_projects"

STORY_PROJECTS_DIR = DATA_DIR / "projects"

DB_PATH = DATA_DIR / "openreup.db"  # câu thoại của mọi bản lồng tiếng (server.mjs đọc/sửa cùng file này)

DUBBED_INDEX_JSON = DATA_DIR / "dubbed.json"


@dataclass(frozen=True)
class StorePaths:
    """Nơi một lượt lồng tiếng đọc/ghi kết quả (server truyền qua tham số dòng lệnh; bỏ trống = mặc định ở trên)."""
    out_dir: Path = DUB_OUT_DIR  # <job>.mp4 / <job>.srt
    projects_dir: Path = PROJECTS_DIR  # file project lồng tiếng <job>.json
    story_dir: Path = STORY_PROJECTS_DIR  # dự án truyện (ngữ cảnh dịch, giọng nhân vật)
    index_json: Path = DUBBED_INDEX_JSON  # danh sách bản lồng tiếng


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


def story_project_path(project_id: str, story_dir: Path = STORY_PROJECTS_DIR) -> Path:
    """File dự án truyện: dạng thư mục <dir>/<id>/project.json (mới) hoặc <dir>/<id>.json (cũ)."""
    pid = Path(project_id).name
    folder = story_dir / pid / "project.json"
    return folder if folder.is_file() else story_dir / f"{pid}.json"


def load_story_context(project_id: str, story_dir: Path = STORY_PROJECTS_DIR) -> Dict:
    if not project_id:
        return {}
    return read_json(story_project_path(project_id, story_dir), {})


def update_dubbed_index(entry: Dict, index_json: Path = DUBBED_INDEX_JSON) -> None:
    items = read_json(index_json, {}).get("videos", [])
    by_id = {x["job_id"]: x for x in items if "job_id" in x}
    by_id[entry["job_id"]] = entry
    merged = sorted(by_id.values(), key=lambda x: x.get("updated_at", ""), reverse=True)
    write_json_atomic(
        index_json,
        {"updated_at": datetime.now().isoformat(timespec="seconds"), "total": len(merged), "videos": merged},
        indent=2,
    )


# ----------------------------------------------------------------------------
# Luồng chính
# ----------------------------------------------------------------------------

JOB_ID_RE = re.compile(r"^[0-9A-Za-z_-]+$")  # cùng quy tắc safeJobId (server/lib/util.mjs)


def check_job_id(given: str, existing: str, proj_path: Optional[Path] = None) -> str:
    """Kiểm --job-id: rỗng thì dùng id có sẵn; sai định dạng hoặc lệch với job_id trong file project thì báo lỗi, không ghi đè."""
    if not given:
        return existing
    if not JOB_ID_RE.match(given):
        raise RuntimeError(f"--job-id không hợp lệ (chỉ gồm chữ/số/_/-): {given!r}")
    if proj_path is not None and existing and existing != given:
        raise RuntimeError(f"--job-id {given} lệch với job_id {existing} trong {proj_path}")
    return given
