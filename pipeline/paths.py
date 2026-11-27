"""Thư mục dữ liệu và đường dẫn binary dùng chung cho các script Python, khớp với server/config.mjs.

REUP_DATA_DIR   (mặc định <repo>/data): DB, JSON, asr_models/, voices/, fonts/, dub_work/...
REUP_MEDIA_ROOT (mặc định <repo>):      chứa downloads/ (video tải về + bản xuất downloads/dubbed)
REUP_FFMPEG / REUP_FFPROBE:             ghi đè binary ffmpeg/ffprobe (mặc định ưu tiên <repo>/.local/bin/)
Chỉ test mới đặt 2 biến đầu; server thật không đặt nên đường dẫn y như cũ.
Server Node chạy script con với ...process.env nên script tự nhận biến của server."""
import os
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # gốc repo (pipeline/ nằm ngay dưới)
LOCAL_BIN = BASE_DIR / ".local" / "bin"

if LOCAL_BIN.is_dir():
    _parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    _local = str(LOCAL_BIN)
    if not _parts or _parts[0] != _local:
        os.environ["PATH"] = os.pathsep.join([_local] + [p for p in _parts if p != _local])


def resolve_bin(name: str, env_key: str = "") -> str:
    """Ưu tiên biến môi trường (REUP_FFMPEG/REUP_FFPROBE) → <repo>/.local/bin/<name> → PATH."""
    if env_key:
        override = os.environ.get(env_key, "").strip()
        if override:
            return override
    local = LOCAL_BIN / name
    if local.is_file() and os.access(local, os.X_OK):
        return str(local)
    return shutil.which(name) or name


FFMPEG_BIN = resolve_bin("ffmpeg", "REUP_FFMPEG")
FFPROBE_BIN = resolve_bin("ffprobe", "REUP_FFPROBE")


def _env_dir(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(os.path.abspath(v)) if v else default  # như path.resolve của Node: không theo symlink


DATA_DIR = _env_dir("REUP_DATA_DIR", BASE_DIR / "data")
MEDIA_ROOT = _env_dir("REUP_MEDIA_ROOT", BASE_DIR)
