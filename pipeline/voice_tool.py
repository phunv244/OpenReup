#!/usr/bin/env python3
"""Công cụ giọng đọc cho OpenReup Studio (server.mjs gọi, mỗi lệnh in 1 dòng JSON kết quả ở cuối):

  voice_tool.py clone   --src <file|URL> --out data/voices/<slug>.wav [--start S --end E]
  voice_tool.py preview --voice <giọng> --text "..." --out <file.mp3>

clone: cắt 1 đoạn 3–8,5 giây làm giọng mẫu. Không truyền --start/--end thì tự chọn đoạn nói liên tục
sạch nhất, gần với tông giọng chủ đạo của audio (bỏ qua nhạc, tiếng hét, người nói phụ).
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

if __package__ in (None, ""):  # chạy bằng đường dẫn file (server: python pipeline/<script>.py) → import gói từ gốc repo
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

from pipeline import common, speakers, tts  # noqa: E402

REF_SR = 44100
ANALYZE_SEC = 900  # chỉ nghe 15 phút đầu để tìm đoạn mẫu: đủ để gặp giọng chính, video 90 tiếng cũng nhanh
MIN_REF, MAX_REF = 3.0, 8.5


def fetch_audio(url: str, tmp: Path) -> Path:
    """Tải riêng luồng tiếng của 1 video (yt-dlp) vào thư mục tạm."""
    common.log("[Giọng mẫu] Đang tải âm thanh từ link...")
    subprocess.run(
        ["yt-dlp", "-q", "--no-playlist", "--no-warnings", "-f", "bestaudio/best", "--max-filesize", "500M",
         "-o", str(tmp / "src.%(ext)s"), "--", url],
        check=True, timeout=600,
    )
    files = [p for p in tmp.iterdir() if p.name.startswith("src.")]
    if not files:
        raise RuntimeError("Không tải được âm thanh từ link này.")
    return files[0]


def pick_candidates(speech, sr: int, min_len: float = 4.5):
    """Gom các khoảng có tiếng nói (mẫu) thành những cụm min_len–8,5 giây liền mạch (nghỉ giữa các khoảng < 0,35 giây).
    Trả [(start_s, end_s)]. Khoảng nói dài hơn 8,5 giây thì lấy 7 giây đầu."""
    out, cur = [], []
    for seg in speech:
        a, b = seg["start"] / sr, seg["end"] / sr
        if cur and (a - cur[-1][1] > 0.35 or b - cur[0][0] > MAX_REF):
            out.append((cur[0][0], cur[-1][1]))
            cur = []
        if b - a > MAX_REF:
            out.append((a, a + 7.0))
            continue
        cur.append((a, b))
    if cur:
        out.append((cur[0][0], cur[-1][1]))
    return [(a, b) for a, b in out if min_len <= b - a <= MAX_REF]


def auto_pick(src: Path):
    """Chọn đoạn mẫu: nói liên tục, cao độ gần trung vị của cả audio (giọng chủ đạo), âm lượng đều."""
    import numpy as np
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    sr = 16000
    raw = common.run_cmd(["ffmpeg", "-v", "error", "-t", str(ANALYZE_SEC), "-i", str(src), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"])
    y = np.frombuffer(raw, dtype=np.float32)
    speech = get_speech_timestamps(y, VadOptions(min_silence_duration_ms=250, speech_pad_ms=60), sampling_rate=sr)
    # Hội thoại câu ngắn không có cụm 4,5 giây: chấp nhận cụm từ 3 giây (mức tối thiểu VieNeu clone được).
    cands = pick_candidates(speech, sr) or pick_candidates(speech, sr, MIN_REF)
    if not cands:
        raise RuntimeError("Không tìm thấy đoạn nói liên tục dài từ 3 giây. Hãy tự nhập mốc bắt đầu / kết thúc.")
    # Cao độ + độ đều âm lượng của tối đa 60 ứng viên dài nhất
    cands = sorted(cands, key=lambda c: c[0] - c[1])[:60]
    stats = []
    for a, b in cands:
        clip = y[int(a * sr): int(b * sr)]
        frames = clip[: len(clip) // 1600 * 1600].reshape(-1, 1600)  # khung 0,1 giây
        rms_db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-6)
        stats.append((speakers._median_f0(clip, sr), float(np.std(rms_db))))
    f0s = np.array([s[0] for s in stats])
    main_f0 = float(np.median(f0s[f0s > 0])) if (f0s > 0).any() else 0.0
    scores = [-(abs(f0 - main_f0) / 60 if f0 else 5) - sd / 6 for f0, sd in stats]
    best = int(np.argmax(scores))
    a, b = cands[best]
    return max(0.0, a - 0.05), b + 0.1, stats[best][0]


def cmd_clone(args) -> dict:
    out = Path(args.out).resolve()
    if out.parent != tts.VOICES_DIR.resolve() or out.suffix != ".wav":
        raise RuntimeError("File giọng mẫu phải nằm trong data/voices/*.wav")
    with tempfile.TemporaryDirectory(prefix="voice_") as tmp:
        src = fetch_audio(args.src, Path(tmp)) if args.src.startswith(("http://", "https://")) else Path(args.src)
        if not src.exists():
            raise RuntimeError(f"Không thấy file nguồn: {src}")
        if args.start is not None and args.end is not None:
            a, b = float(args.start), float(args.end)
            if not MIN_REF <= b - a <= MAX_REF:
                raise RuntimeError("Đoạn mẫu phải dài từ 3 đến 8,5 giây.")
            f0 = 0.0
        else:
            common.log("[Giọng mẫu] Đang tìm đoạn nói sạch nhất...")
            a, b, f0 = auto_pick(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp_out = out.with_suffix(".tmp.wav")
        common.run_cmd(["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(src),
                   "-vn", "-ac", "1", "-ar", str(REF_SR), str(tmp_out)])
        if not tmp_out.exists() or tmp_out.stat().st_size < REF_SR:  # < ~0,5 giây: mốc nằm ngoài audio
            tmp_out.unlink(missing_ok=True)
            raise RuntimeError("Đoạn đã chọn không có âm thanh (mốc thời gian vượt quá độ dài file?).")
        if not f0:
            import numpy as np

            clip = np.frombuffer(common.run_cmd(["ffmpeg", "-v", "error", "-i", str(tmp_out), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]), dtype=np.float32)
            f0 = speakers._median_f0(clip, 16000)
        tmp_out.replace(out)
    return {"ok": True, "start": round(a, 2), "end": round(b, 2), "f0": round(f0), "gender": "female" if f0 > speakers.FEMALE_F0 else "male"}


def cmd_preview(args) -> dict:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.mp3")
    if not tts.VieNeuEngine(args.voice).synth_mp3(args.text, tmp):
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Không tạo được âm thanh nghe thử.")
    tmp.replace(out)
    return {"ok": True}


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("clone")
    c.add_argument("--src", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--start", type=float)
    c.add_argument("--end", type=float)
    p = sub.add_parser("preview")
    p.add_argument("--voice", required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        result = cmd_clone(args) if args.cmd == "clone" else cmd_preview(args)
    except subprocess.CalledProcessError as e:
        result = {"ok": False, "error": f"Lệnh {Path(str(e.cmd[0])).name} lỗi (mã {e.returncode})."}
    except Exception as e:
        result = {"ok": False, "error": str(e)}
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
