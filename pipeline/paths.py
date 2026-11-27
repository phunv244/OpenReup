"""Thư mục dữ liệu dùng chung cho các script Python, khớp với server/config.mjs.

REUP_DATA_DIR   (mặc định <repo>/data): DB, JSON, asr_models/, voices/, fonts/, dub_work/...
REUP_MEDIA_ROOT (mặc định <repo>):      chứa downloads/ (video tải về + bản xuất downloads/dubbed)
Chỉ test mới đặt 2 biến này; server thật không đặt nên đường dẫn y như cũ.
Server Node chạy script con với ...process.env nên script tự nhận biến của server."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # gốc repo (pipeline/ nằm ngay dưới)


def _env_dir(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(os.path.abspath(v)) if v else default  # như path.resolve của Node: không theo symlink


DATA_DIR = _env_dir("REUP_DATA_DIR", BASE_DIR / "data")
MEDIA_ROOT = _env_dir("REUP_MEDIA_ROOT", BASE_DIR)
