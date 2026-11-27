"""Tiện ích dùng chung của pipeline: log, chạy lệnh/ffmpeg, đọc ghi JSON, đường dẫn tương đối, dọn VRAM."""
import gc
import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional

from pipeline.paths import BASE_DIR

VENV_BIN = BASE_DIR / ".venv" / "bin"

if VENV_BIN.is_dir() and str(VENV_BIN) not in os.environ.get("PATH", "").split(os.pathsep):
    os.environ["PATH"] = f"{VENV_BIN}{os.pathsep}{os.environ.get('PATH', '')}"

SAMPLE_RATE = 24000  # track lồng tiếng: PCM 16-bit mono

NARRATOR_ZH = "旁白"  # nhãn AI dùng cho lời dẫn truyện ở trường "who"

CHILDREN: set = set()  # các tiến trình ffmpeg chạy lâu, cần dừng khi người dùng bấm Dừng


# ----------------------------------------------------------------------------
# Tiện ích chung
# ----------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def free_gpu_memory(stage: str = "") -> None:
    """Giải phóng bộ nhớ đệm GPU giữa các công đoạn để thẻ VRAM nhỏ (4 GB) luân chuyển tuần tự."""
    gc.collect()
    torch_mod = sys.modules.get("torch")
    if torch_mod is not None:
        try:
            # is_initialized: Whisper chạy bằng ctranslate2, đừng bắt torch dựng CUDA context chỉ để xả cache rỗng
            if torch_mod.cuda.is_available() and torch_mod.cuda.is_initialized():
                torch_mod.cuda.synchronize()
                torch_mod.cuda.empty_cache()
                if hasattr(torch_mod.cuda, "ipc_collect"):
                    torch_mod.cuda.ipc_collect()
        except Exception:
            pass
    if stage:
        log(f"[GPU] Đã giải phóng VRAM sau công đoạn {stage}.")


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


def rel_to_base(p: Path) -> str:
    """Đường dẫn lưu vào JSON: tương đối với thư mục dự án nếu nằm trong đó, để chuyển thư mục không vỡ."""
    p = Path(p).resolve()
    try:
        return str(p.relative_to(BASE_DIR))
    except ValueError:
        return str(p)


def from_base(p: str) -> Path:
    q = Path(p)
    return (q if q.is_absolute() else BASE_DIR / q).resolve()


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
