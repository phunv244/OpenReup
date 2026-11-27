"""Bước 1: nhận diện lời thoại tiếng Trung theo khối (giải mã từng cửa sổ, cắt ở khoảng lặng, gom câu)."""
import os
import re
from pathlib import Path
from typing import Callable, Dict, List

from pipeline.common import FFMPEG_BIN, build_atempo_chain, cpu_forced, fmt_clock, free_gpu_memory, log, preload_nvidia_libs, run_cmd
from pipeline.job import Job, Progress

STT_PAD_SEC = 30.0  # giải mã dư ra để tìm khoảng lặng mà cắt khối, không cắt giữa câu


# ----------------------------------------------------------------------------
# Bước 1+2: Nhận diện lời thoại theo khối (faster-whisper)
# ----------------------------------------------------------------------------
def decode_audio_window(input_mp4: Path, t0: float, dur: float, speed: float):
    """Giải mã [t0, t0+dur] của video thành PCM 16kHz đã làm chậm — chỉ 1 khối nằm trong RAM."""
    import numpy as np

    raw = run_cmd(
        [
            FFMPEG_BIN,
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

    from pipeline import asr

    spec = asr.get(model_size)
    if not asr.installed(spec):
        raise RuntimeError(f"Chưa tải mô hình nhận diện '{spec['name']}'. Mở mục 'Mô hình nhận diện' để tải về.")
    sherpa = spec["engine"] == "sherpa"
    if sherpa:
        speed = 1.0  # SenseVoice/Paraformer/FireRed nghe được thoại nhanh, không cần làm chậm

    names = [c["zh"] for c in story_ctx.get("characters", []) if c.get("zh")]
    names += [g["zh"] for g in story_ctx.get("glossary", [])[:8] if g.get("zh")]
    prompt = ("普通话对白：" + "，".join(names[:40])) if names else "钓鱼动画楚新钓普通话对白"

    gpu = False
    if sherpa:
        log(f"[Nhận diện] Nạp {spec['name']} (sherpa-onnx, CPU) — lọc giọng nói bằng {asr.VAD_BY_ID[asr.vad_choice()]['name']}.")
        model = None
    else:
        from faster_whisper import WhisperModel

        gpu = False
        if not cpu_forced():
            lib_ok, lib_err = preload_nvidia_libs()
            if lib_ok and asr.cuda_devices() > 0:
                gpu = True
            elif not lib_ok and asr.cuda_devices() > 0:
                log(f"[Nhận diện] ⚠ Thiếu thư viện CUDA ({lib_err}), lùi {spec['name']} về CPU.")
        threads = max(2, min(8, (os.cpu_count() or 4) - 2))
        log(f"[Nhận diện] Nạp {spec['name']} trên {'GPU' if gpu else 'CPU'} — tách âm chậm {speed}x, quy đổi mốc giờ về tốc độ gốc 1.0x.")
        try:
            model = WhisperModel(spec["repo"], device="cuda" if gpu else "cpu",
                                 compute_type="int8_float16" if gpu else "int8", cpu_threads=threads)
        except RuntimeError as e:
            if not gpu:
                raise
            err_l = str(e).lower()
            is_oom = "out of memory" in err_l
            is_cuda_lib = any(k in err_l for k in ("cublas", "cudnn", "cuda", "libcu", "driver", "cannot be loaded", "no kernel image"))
            if not is_oom and not is_cuda_lib:
                raise
            if is_oom:
                log(f"[Nhận diện] ⚠ {spec['name']} thiếu VRAM ở chế độ float16, thử hạ xuống int8 / CPU...")
                free_gpu_memory()
                try:
                    model = WhisperModel(spec["repo"], device="cuda", compute_type="int8", cpu_threads=threads)
                except RuntimeError:
                    gpu = False
                    free_gpu_memory()
                    model = WhisperModel(spec["repo"], device="cpu", compute_type="int8", cpu_threads=threads)
            else:
                log(f"[Nhận diện] ⚠ Lỗi thư viện CUDA/cuBLAS/cuDNN ({e}), lùi {spec['name']} về CPU (int8)...")
                gpu = False
                free_gpu_memory()
                model = WhisperModel(spec["repo"], device="cpu", compute_type="int8", cpu_threads=threads)
    verbose = duration <= 900
    total_segs = sum(len(c["segments"]) for c in chunks)

    try:
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
                while True:
                    words = []
                    try:
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
                        break
                    except RuntimeError as e:
                        if not gpu or "out of memory" not in str(e).lower():
                            raise
                        # Hết VRAM giữa chừng: làm lại khối này và phần còn lại trên CPU thay vì hỏng cả lượt chạy.
                        log(f"[Nhận diện] ⚠ Hết VRAM ở {fmt_clock(t)}, chuyển {spec['name']} sang CPU cho phần còn lại...")
                        gpu = False
                        model = None
                        free_gpu_memory()
                        model = WhisperModel(spec["repo"], device="cpu", compute_type="int8", cpu_threads=threads)
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
    finally:
        if model is not None:
            unload = getattr(getattr(model, "model", None), "unload_model", None)
            if callable(unload):
                try:
                    unload()
                except Exception:
                    pass
            del model
        asr.release_models()
        if gpu:
            free_gpu_memory("Nhận diện")

    return chunks
