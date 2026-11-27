"""Bước 5: xuất video — phụ đề SRT, mã hóa lại theo phần 10 phút (in phụ đề / xóa logo / che phụ đề gốc), ghép hình + tiếng."""
import bisect
import hashlib
import json
import math
import os
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pipeline.common import FFMPEG_BIN, cpu_forced, fmt_clock, log, run_ffmpeg
from pipeline.subtitles import build_ass, sub_events, subtitles_filter
from pipeline.job import Job, Progress

PART_SEC = 600.0  # độ dài mỗi phần video khi phải mã hóa lại (in phụ đề / xóa logo)

ENCODE_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"]

NVENC_ENCODE_ARGS = ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"]


_nvenc_ok: Optional[bool] = None
_nvenc_reason: str = ""


def probe_nvenc(force: bool = False) -> Tuple[bool, str]:
    """Thử mã hóa thật 0.2s bằng h264_nvenc. Trả (ok, reason tiếng Việt ngắn gọn kèm hướng khắc phục)."""
    global _nvenc_ok, _nvenc_reason
    if cpu_forced():
        return False, "Đang ép chạy CPU (REUP_FORCE_CPU=1). Bỏ biến môi trường này để bật lại NVENC."
    if _nvenc_ok is not None and not force:
        return _nvenc_ok, _nvenc_reason
    try:
        proc = subprocess.run(
            [FFMPEG_BIN, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=0.2:size=640x360:rate=10",
             "-pix_fmt", "yuv420p", "-c:v", "h264_nvenc", "-f", "null", "-"],
            capture_output=True, text=True, timeout=8,
        )
        if proc.returncode == 0:
            _nvenc_ok, _nvenc_reason = True, ""
        else:
            err = (proc.stderr or "").strip()
            err_l = err.lower()
            if "minimum required nvidia driver" in err_l or "api version" in err_l or "does not support the required nvenc" in err_l:
                reason = "FFmpeg lệch phiên bản NVENC API với driver NVIDIA. Cập nhật FFmpeg trong .local/bin/ hoặc đặt REUP_FFMPEG."
            elif "unknown encoder" in err_l or "encoder 'h264_nvenc'" in err_l:
                reason = "Bản FFmpeg hiện tại không hỗ trợ h264_nvenc. Cài bản FFmpeg có NVENC vào .local/bin/."
            elif "cannot load libcuda" in err_l or "no nvenc capable" in err_l or "no capable devices" in err_l:
                reason = "Không tìm thấy GPU NVIDIA hỗ trợ NVENC."
            else:
                snippet = err.splitlines()[-1][:120] if err else f"mã lỗi {proc.returncode}"
                reason = f"NVENC thử mã hóa thất bại ({snippet}). Đang dùng CPU libx264."
            _nvenc_ok, _nvenc_reason = False, reason
    except FileNotFoundError:
        _nvenc_ok, _nvenc_reason = False, f"Không tìm thấy binary FFmpeg ({FFMPEG_BIN})."
    except subprocess.TimeoutExpired:
        _nvenc_ok, _nvenc_reason = False, "Kiểm tra NVENC quá thời gian chờ (8s). Đang dùng CPU libx264."
    except Exception as e:
        _nvenc_ok, _nvenc_reason = False, f"Không kiểm tra được NVENC ({e})."
    return _nvenc_ok, _nvenc_reason


def has_working_nvenc() -> bool:
    """Thử mã hóa thật 0.2s bằng h264_nvenc (tránh lỗi ffmpeg có tên encoder nhưng lệch phiên bản driver)."""
    ok, _ = probe_nvenc()
    return ok


def video_encode_args(cap: int, encoder: str = "auto") -> Tuple[List[str], bool]:
    """Trả (tham số mã hóa video, có dùng NVENC không). Chặn trần bitrate ở `cap` để video dài không phình dung lượng."""
    use_nvenc = encoder == "nvenc" or (encoder == "auto" and has_working_nvenc())
    base = NVENC_ENCODE_ARGS if use_nvenc else ENCODE_ARGS
    return base + ["-maxrate", str(cap), "-bufsize", str(cap * 2)], use_nvenc


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


def render_parts(
    job: Job, input_mp4: Path, segments: List[Dict], duration: float, burn_sub: bool, delogo_vf: str, sig, prog: Progress,
    cover_vf: str = "", subcover: str = "none", sub_style: Optional[Dict] = None, size: Tuple[int, int] = (0, 0),
    encoder: str = "auto",
) -> Path:
    """Mã hóa lại video theo từng phần 10 phút (in phụ đề / xóa logo). Phần nào xong được cache:
    dừng giữa chừng thì chạy tiếp, sửa lời thoại thì chỉ phần chứa câu bị sửa phải làm lại."""
    global _nvenc_ok
    # CRF 21 / CQ 23 trên nguồn bitrate thấp (Bilibili ~1 Mbps) cho ra file to gấp 3 mà không đẹp hơn:
    # chặn trần ở 1.3 lần bitrate nguồn để video 90 tiếng không ngốn ổ cứng vô ích.
    cap = max(600_000, int(sig[0] * 8 / max(1.0, duration) * 1.3))
    encode_args, use_nvenc = video_encode_args(cap, encoder)
    job.parts_dir.mkdir(parents=True, exist_ok=True)
    n_parts = max(1, math.ceil((duration - 0.05) / PART_SEC))
    threads = max(2, min(8, (os.cpu_count() or 4) - 2))
    starts = [s["start"] for s in segments]
    plan = []  # (k, t0, dur, ass_txt) của từng phần — không phụ thuộc bộ mã hóa
    for k in range(n_parts):
        t0 = k * PART_SEC
        dur = min(PART_SEC, duration - t0)
        # chỉ xét các câu quanh phần này (câu dài nhất vài giây) thay vì quét cả 100k câu cho mỗi phần
        near = segments[bisect.bisect_left(starts, t0 - 60) : bisect.bisect_left(starts, t0 + dur)]
        ass_txt = build_ass(sub_events(near, offset=t0, window=dur), size[0], size[1], subcover, sub_style) if burn_sub else ""
        plan.append((k, t0, dur, ass_txt))

    def part_path(k: int, t0: float, dur: float, ass_txt: str, enc: List[str]) -> Path:
        key = hashlib.sha1(json.dumps([sig, t0, dur, ass_txt, delogo_vf, enc] + ([cover_vf] if cover_vf else [])).encode()).hexdigest()[:12]
        return job.parts_dir / f"p{k:05d}_{key}.mp4"

    # Mọi phần của 1 video phải cùng 1 bộ mã hóa (ghép copy 2 loại SPS/PPS dễ vỡ hình ở điểm nối). Nếu phần lớn video
    # đã mã hóa sẵn bằng CPU (dự án cũ / lần trước NVENC hỏng) thì làm nốt bằng CPU thay vì mã hóa lại tất cả bằng NVENC.
    if use_nvenc and encoder == "auto":
        cpu_args, _ = video_encode_args(cap, "cpu")
        n_cpu = sum(part_path(*p, cpu_args).exists() for p in plan)
        if n_cpu * 2 >= n_parts and n_cpu > sum(part_path(*p, encode_args).exists() for p in plan):
            encode_args, use_nvenc = cpu_args, False
    log(f"[Xuất video] Bộ mã hóa: {'GPU NVIDIA NVENC (h264_nvenc)' if use_nvenc else f'CPU libx264 ({threads} luồng)'}.")

    while True:
        keep, done_before = [], 0
        try:
            for k, t0, dur, ass_txt in plan:
                part = part_path(k, t0, dur, ass_txt, encode_args)
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
            break
        except RuntimeError:
            if not use_nvenc or encoder == "nvenc":
                raise
            _nvenc_ok = None
            if has_working_nvenc():  # NVENC vẫn chạy được -> lỗi do nguyên nhân khác (ổ đầy, filter...), không đổi bộ mã hóa
                raise
            log("[Xuất video] ⚠ NVENC ngừng hoạt động, mã hóa lại toàn bộ bằng CPU libx264 để các phần đồng nhất...")
            encode_args, use_nvenc = video_encode_args(cap, "cpu")
    for f in job.parts_dir.iterdir():
        if f not in keep:
            f.unlink(missing_ok=True)
    if done_before:
        log(f"[Xuất video] Dùng lại {done_before}/{n_parts} phần đã mã hóa từ trước.")
    concat = job.work / "parts.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in keep), encoding="utf-8")
    return concat


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
