#!/usr/bin/env python3
"""Mô hình nhận diện lời thoại tiếng Trung (ASR) cho OpenReup Studio.

  asr.py list            -> JSON danh sách model + đã tải hay chưa + máy có GPU không
  asr.py download <id>   -> tải 1 model (server.mjs chạy như 1 tiến trình nền, có thanh tiến độ)

Hai loại engine:
  - whisper: faster-whisper (CTranslate2), tự chạy GPU NVIDIA nếu có
  - sherpa : sherpa-onnx (SenseVoice / Paraformer / FireRedASR), chạy ONNX trên CPU, kèm Silero VAD để cắt câu
"""
import json
import shutil
import sys
import tarfile
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "data" / "asr_models"
SHERPA_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
VAD_FILE = "silero_vad.onnx"

# Mỗi model: hw = "cpu" (chạy tốt không cần GPU) | "gpu" (chạy được trên CPU nhưng rất chậm, nên có GPU).
CATALOG: List[Dict] = [
    {
        "id": "base", "engine": "whisper", "repo": "Systran/faster-whisper-base", "size_mb": 145, "hw": "cpu", "vram_gb": 0.5,
        "name": "Whisper base",
        "desc": "Nhanh nhất trong nhóm Whisper. Hay sót câu, nghe nhầm tên riêng và lẫn chữ Phồn thể. Chỉ nên dùng để thử nhanh.",
    },
    {
        "id": "small", "engine": "whisper", "repo": "Systran/faster-whisper-small", "size_mb": 485, "hw": "cpu", "vram_gb": 1,
        "name": "Whisper small",
        "desc": "Đúng chữ hơn base rõ rệt (đo trên video 8 phút: câu liền mạch, ít nghe nhầm). Chậm hơn base khoảng 3 lần trên CPU.",
    },
    {
        "id": "medium", "engine": "whisper", "repo": "Systran/faster-whisper-medium", "size_mb": 1530, "hw": "gpu", "vram_gb": 2.5,
        "name": "Whisper medium",
        "desc": "Chính xác hơn small. Trên CPU rất chậm (chậm hơn thời lượng video); nên chạy trên GPU.",
    },
    {
        "id": "large-v3-turbo", "engine": "whisper", "repo": "deepdml/faster-whisper-large-v3-turbo-ct2", "size_mb": 1620, "hw": "gpu", "vram_gb": 2.5,
        "name": "Whisper large-v3-turbo",
        "desc": "Gần bằng large-v3 nhưng nhanh hơn 5–8 lần. Vừa GPU 4 GB. Vẫn có thể ảo giác khi nhạc nền to.",
    },
    {
        "id": "belle-large-v3-zh", "engine": "whisper", "repo": "XA9/Belle-faster-whisper-large-v3-zh-punct", "size_mb": 3100, "hw": "gpu", "vram_gb": 4,
        "name": "BELLE Whisper large-v3 (tiếng Trung)",
        "desc": "Whisper large-v3 tinh chỉnh riêng cho tiếng Trung, có dấu câu, hết lẫn Giản/Phồn thể. Nặng: GPU 4 GB rất sát, có thể thiếu bộ nhớ.",
    },
    {
        "id": "sensevoice-small", "engine": "sherpa", "kind": "sense_voice", "size_mb": 230, "hw": "cpu", "vram_gb": 0,
        "archive": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17", "files": ["model.int8.onnx", "tokens.txt"],
        "name": "SenseVoice-Small (Alibaba)",
        "desc": "Rất nhanh trên CPU (nhanh hơn Whisper nhiều lần), có dấu câu, chịu được nhạc nền, hiểu cả tiếng Quảng Đông. Nên thử đầu tiên trên máy không có GPU.",
    },
    {
        "id": "paraformer-zh", "engine": "sherpa", "kind": "paraformer", "size_mb": 230, "hw": "cpu", "vram_gb": 0,
        "archive": "sherpa-onnx-paraformer-zh-2024-03-09", "files": ["model.int8.onnx", "tokens.txt"],
        "name": "Paraformer-zh (Alibaba FunASR)",
        "desc": "Chuẩn công nghiệp cho tiếng Phổ thông, ổn định, nhanh trên CPU. Không tự thêm dấu câu nên câu được cắt theo khoảng lặng.",
    },
    {
        "id": "firered-aed-l", "engine": "sherpa", "kind": "fire_red_asr", "size_mb": 1500, "hw": "gpu", "vram_gb": 4,
        "archive": "sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16",
        "files": ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
        "name": "FireRedASR-AED-L (Xiaohongshu)",
        "desc": "Chính xác nhất cho video mạng nói nhanh, tiếng lóng, nhạc nền dày. Mô hình 1,1 tỷ tham số: trên CPU rất chậm.",
    },
]
BY_ID = {m["id"]: m for m in CATALOG}

# Bộ lọc giọng nói (VAD) cắt audio thành đoạn có tiếng nói trước khi đưa cho SenseVoice / Paraformer / FireRedASR.
# Đo trên video 8 phút (SenseVoice): Silero 1 lượt 1034 chữ, Silero 2 lượt 1072, TEN 933, FireRedVAD 1178.
VAD_CATALOG: List[Dict] = [
    {
        "id": "firered-vad", "size_mb": 5, "extra": "PyTorch CPU (~760 MB)",
        "name": "FireRedVAD (Xiaohongshu)",
        "desc": "Bắt câu tốt nhất khi có nhạc nền: video 8 phút bắt thêm 14 câu so với Silero (câu ngắn, hét lẫn nhạc, tiếng lòng), chỉ sót 1 tiếng \"嗯\". Cần cài PyTorch bản CPU.",
    },
    {
        "id": "silero", "size_mb": 1, "extra": "",
        "name": "Silero VAD (2 lượt)",
        "desc": "Nhẹ, không cần thêm gì. Lượt chính ngưỡng 0,5, rồi quét lại các khoảng trống ở ngưỡng 0,3 để vớt câu nhỏ / ngắn: thêm 11 câu so với 1 lượt.",
    },
    {
        "id": "ten-vad", "size_mb": 1, "extra": "",
        "name": "TEN VAD (Agora)",
        "desc": "Nhỏ nhất, nhạy với khoảng ngắt. Trên video thử sót 9 câu so với Silero nên không khuyên dùng cho video có nhạc nền. Giấy phép có điều khoản riêng của Agora.",
    },
]
VAD_BY_ID = {v["id"]: v for v in VAD_CATALOG}
SETTINGS_JSON = BASE_DIR / "data" / "asr_settings.json"
FIRERED_VAD_DIR = MODELS_DIR / "FireRedVAD" / "VAD"


def log(msg: str) -> None:
    print(msg, flush=True)


def get(model_id: str) -> Dict:
    if model_id not in BY_ID:
        raise ValueError(f"Không có mô hình nhận diện '{model_id}'. Có: {', '.join(BY_ID)}")
    return BY_ID[model_id]


def cuda_devices() -> int:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count()
    except Exception:
        return 0


def gpu_info() -> Dict:
    """Tên + VRAM của GPU NVIDIA (qua nvidia-smi), và faster-whisper có dùng được CUDA không."""
    import subprocess

    info = {"name": "", "vram_gb": 0, "cuda": cuda_devices() > 0}
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
        if out:
            name, mem = out[0].rsplit(",", 1)
            info.update(name=name.strip(), vram_gb=round(int(mem) / 1024, 1))
    except Exception:
        pass
    return info


def _whisper_dir(repo: str) -> Optional[Path]:
    from huggingface_hub import try_to_load_from_cache

    p = try_to_load_from_cache(repo, "model.bin")
    return Path(p).parent if isinstance(p, str) and Path(p).exists() else None


def vad_installed(vid: str) -> bool:
    if vid == "firered-vad":
        import importlib.util

        return (FIRERED_VAD_DIR / "model.pth.tar").exists() and importlib.util.find_spec("fireredvad") is not None
    return (MODELS_DIR / ("ten-vad.onnx" if vid == "ten-vad" else VAD_FILE)).exists()


def vad_choice() -> str:
    """VAD đang chọn; chưa chọn thì FireRedVAD nếu đã cài, không thì Silero."""
    try:
        vid = json.loads(SETTINGS_JSON.read_text()).get("vad", "")
    except Exception:
        vid = ""
    if vid in VAD_BY_ID and vad_installed(vid):
        return vid
    return "firered-vad" if vad_installed("firered-vad") else "silero"


def set_vad(vid: str) -> None:
    if vid not in VAD_BY_ID or not vad_installed(vid):
        raise ValueError("Bộ lọc giọng nói này chưa tải hoặc không tồn tại.")
    SETTINGS_JSON.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_JSON.write_text(json.dumps({"vad": vid}))


def installed(m: Dict) -> bool:
    if m["engine"] == "whisper":
        return _whisper_dir(m["repo"]) is not None
    d = MODELS_DIR / m["archive"]
    return (MODELS_DIR / VAD_FILE).exists() and all((d / f).exists() for f in m["files"])


def _fetch(url: str, dest: Path, label: str) -> None:
    """Tải 1 file, in tiến độ theo dạng server.mjs hiểu (@@PROGRESS)."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=60) as r, tmp.open("wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done, last = 0, 0.0
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if time.time() - last > 1 and total:
                last = time.time()
                pct = round(done * 100 / total, 1)
                log("@@PROGRESS " + json.dumps({"pct": min(99, pct), "label": f"{label}: {done >> 20}/{total >> 20} MB"}, ensure_ascii=False))
    tmp.replace(dest)


def download_vad(vid: str) -> None:
    import subprocess

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if vid == "firered-vad":
        import importlib.util

        if importlib.util.find_spec("fireredvad") is None:
            uv = shutil.which("uv")
            if not uv:
                raise RuntimeError("Cần cài: uv pip install --python .venv/bin/python torch --index-url "
                                   "https://download.pytorch.org/whl/cpu && uv pip install --python .venv/bin/python fireredvad")
            if importlib.util.find_spec("torch") is None:
                log("[Mô hình] Đang cài PyTorch bản CPU (~200 MB tải về)...")
                log("@@PROGRESS " + json.dumps({"pct": 10, "label": "Đang cài PyTorch CPU..."}, ensure_ascii=False))
                # Bản CPU: chỉ cài khi chưa có torch (nếu đã cài vieneu[cuda] thì giữ nguyên bản CUDA).
                subprocess.run([uv, "pip", "install", "--python", sys.executable, "torch",
                                "--index-url", "https://download.pytorch.org/whl/cpu"], check=True)
            log("[Mô hình] Đang cài fireredvad...")
            subprocess.run([uv, "pip", "install", "--python", sys.executable, "fireredvad"], check=True)
        from huggingface_hub import snapshot_download

        log("@@PROGRESS " + json.dumps({"pct": 90, "label": "Đang tải FireRedVAD..."}, ensure_ascii=False))
        snapshot_download("FireRedTeam/FireRedVAD", local_dir=str(MODELS_DIR / "FireRedVAD"), allow_patterns=["VAD/*"])
    else:
        name = "ten-vad.onnx" if vid == "ten-vad" else VAD_FILE
        _fetch(SHERPA_URL + name, MODELS_DIR / name, VAD_BY_ID[vid]["name"])
    if not vad_installed(vid):
        raise RuntimeError("Tải xong nhưng thiếu file của bộ lọc giọng nói.")
    log(f"[Mô hình] Đã tải xong {VAD_BY_ID[vid]['name']}.")


def download(model_id: str) -> None:
    if model_id in VAD_BY_ID:
        return download_vad(model_id)
    m = get(model_id)
    if installed(m):
        log(f"[Mô hình] {m['name']} đã có sẵn.")
        return
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(MODELS_DIR).free / 1024**3
    if free_gb < m["size_mb"] * 3 / 1024 + 1:
        raise RuntimeError(f"Ổ cứng chỉ còn {free_gb:.1f} GB, không đủ để tải {m['name']}.")
    log(f"[Mô hình] Đang tải {m['name']} (~{m['size_mb']} MB)...")
    if m["engine"] == "whisper":
        from huggingface_hub import snapshot_download

        # Thư viện tự hiện tiến độ trên stderr; ở đây chỉ báo bắt đầu / xong.
        log("@@PROGRESS " + json.dumps({"pct": 5, "label": f"Đang tải {m['name']}..."}, ensure_ascii=False))
        snapshot_download(m["repo"], allow_patterns=["*.bin", "*.json", "*.txt", "vocabulary*", "tokenizer*"])
    else:
        if not (MODELS_DIR / VAD_FILE).exists():
            _fetch(SHERPA_URL + VAD_FILE, MODELS_DIR / VAD_FILE, "Bộ cắt câu Silero VAD")
        archive = MODELS_DIR / f"{m['archive']}.tar.bz2"
        _fetch(SHERPA_URL + archive.name, archive, m["name"])
        log("@@PROGRESS " + json.dumps({"pct": 99, "label": "Đang giải nén..."}, ensure_ascii=False))
        want = {f"{m['archive']}/{f}" for f in m["files"]}
        with tarfile.open(archive) as tar:
            # Chỉ giải nén đúng các file cần (bỏ bản fp32, wav mẫu...), và chặn đường dẫn lạ trong file nén.
            members = [x for x in tar.getmembers() if x.name in want and x.isfile()]
            tar.extractall(MODELS_DIR, members=members, filter="data")
        archive.unlink(missing_ok=True)
    if not installed(m):
        raise RuntimeError(f"Tải xong nhưng thiếu file của {m['name']}.")
    log(f"[Mô hình] Đã tải xong {m['name']}.")


def catalog_json() -> Dict:
    return {
        "gpu": gpu_info(),
        "models": [{k: v for k, v in m.items() if k not in ("files", "archive", "repo")} | {"installed": installed(m)} for m in CATALOG],
        "vads": [v | {"installed": vad_installed(v["id"])} for v in VAD_CATALOG],
        "vad": vad_choice(),
    }


# ----------------------------------------------------------------------------
# Chạy nhận diện bằng sherpa-onnx (dub_video.run_stt gọi)
# ----------------------------------------------------------------------------
_cache: Dict[str, object] = {}


def sherpa_recognizer(model_id: str):
    import os

    import sherpa_onnx

    if model_id in _cache:
        return _cache[model_id]
    m = get(model_id)
    d = MODELS_DIR / m["archive"]
    threads = max(2, min(8, (os.cpu_count() or 4) - 1))
    if m["kind"] == "sense_voice":
        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(d / "model.int8.onnx"), tokens=str(d / "tokens.txt"), language="zh", use_itn=True, num_threads=threads)
    elif m["kind"] == "paraformer":
        rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=str(d / "model.int8.onnx"), tokens=str(d / "tokens.txt"), num_threads=threads)
    else:
        rec = sherpa_onnx.OfflineRecognizer.from_fire_red_asr(
            encoder=str(d / "encoder.int8.onnx"), decoder=str(d / "decoder.int8.onnx"), tokens=str(d / "tokens.txt"), num_threads=threads)
    _cache[model_id] = rec
    return rec


def speech_chunks(audio, sr: int = 16000, max_sec: float = 15.0, threshold: float = 0.5, kind: str = "silero"):
    """Cắt audio thành các đoạn có tiếng nói (Silero VAD), mỗi đoạn tối đa max_sec giây. Trả [(start_s, samples)]."""
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    v = cfg.ten_vad if kind == "ten-vad" else cfg.silero_vad
    v.model = str(MODELS_DIR / ("ten-vad.onnx" if kind == "ten-vad" else VAD_FILE))
    v.threshold = threshold
    v.min_silence_duration = 0.25
    v.min_speech_duration = 0.2
    v.max_speech_duration = max_sec
    cfg.sample_rate = sr
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max_sec * 4)
    out = []
    win = v.window_size
    for i in range(0, len(audio), win):
        vad.accept_waveform(audio[i: i + win])
        while not vad.empty():
            out.append((vad.front.start / sr, vad.front.samples))
            vad.pop()
    vad.flush()
    while not vad.empty():
        out.append((vad.front.start / sr, vad.front.samples))
        vad.pop()
    return out


VAD_MAIN = 0.5      # lượt chính: chỉ lấy đoạn chắc chắn là giọng nói (đoạn gọn, mô hình nghe chuẩn nhất)
VAD_GAP = 0.3       # lượt vớt: quét lại các khoảng trống với ngưỡng thấp hơn (câu ngắn, tiếng lòng, thì thầm, hét lẫn nhạc)
MIN_GAP_SEC = 0.4


def _recognize(rec, samples, start: float, t0: float) -> List[Dict]:
    import numpy as np

    st = rec.create_stream()
    st.accept_waveform(16000, np.asarray(samples, dtype=np.float32))
    rec.decode_stream(st)
    r = st.result
    toks = [t for t in (r.tokens or []) if t.strip()]
    if not toks and r.text.strip():
        toks = list(r.text.strip())
    if not toks:
        return []
    dur = len(samples) / 16000
    ts = list(r.timestamps or [])
    if len(ts) != len(r.tokens or []) or not ts:
        pairs = list(zip(toks, [dur * i / len(toks) for i in range(len(toks))]))
    else:
        pairs = [(t, s) for t, s in zip(r.tokens, ts) if t.strip()]
    out = []
    for k, (tok, s) in enumerate(pairs):
        e = pairs[k + 1][1] if k + 1 < len(pairs) else dur
        out.append({"w": tok.replace("▁", ""), "s": t0 + start + s, "e": t0 + start + min(e, s + 0.6)})
    return out


_firered = None


def release_models() -> None:
    """Giải phóng bộ nhận diện sherpa-onnx và bộ lọc VAD khỏi bộ nhớ sau khi xong bước nhận diện."""
    global _firered
    _cache.clear()
    _firered = None


def firered_chunks(audio, sr: int = 16000):
    """Đoạn có tiếng nói theo FireRedVAD (mỗi đoạn tối đa 15 giây). Trả [(start_s, samples)] như speech_chunks."""
    global _firered
    import numpy as np

    if _firered is None:
        from fireredvad import FireRedVad, FireRedVadConfig

        _firered = FireRedVad.from_pretrained(str(FIRERED_VAD_DIR), FireRedVadConfig(
            use_gpu=False, speech_threshold=0.4, min_speech_frame=20, max_speech_frame=1500, min_silence_frame=20))
    # Thư viện đọc PCM 16-bit (thang int16), không phải float [-1, 1]
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    res, _ = _firered.detect(pcm)
    return [(a, audio[int(a * sr): int(b * sr)]) for a, b in res["timestamps"] if b - a >= 0.15]


def sherpa_words(model_id: str, audio, t0: float, on_progress=None) -> List[Dict]:
    """Nhận diện 1 cửa sổ audio (16 kHz, tốc độ gốc) -> [{"w", "s", "e"}] với mốc giờ theo video (cộng t0).
    Có mốc giờ từng chữ thì dùng; không có thì chia đều đoạn theo số chữ.
    2 lượt VAD: hạ ngưỡng cho cả bài làm đoạn bị gộp dài và mô hình nghe kém đi (đo trên video 8 phút: mất ~20 chữ),
    nên chỉ quét lại phần audio mà lượt chính bỏ qua."""
    import re

    rec = sherpa_recognizer(model_id)
    sr = 16000
    words: List[Dict] = []
    vad = vad_choice()
    if vad == "firered-vad":
        main = firered_chunks(audio)
    else:
        main = speech_chunks(audio, threshold=VAD_MAIN, kind=vad)
    for start, samples in main:
        words += _recognize(rec, samples, start, t0)
        if on_progress:
            on_progress(t0 + start + len(samples) / sr)
    # Khoảng trống giữa các đoạn của lượt chính
    edges = [0.0] + [x for start, smp in main for x in (start, start + len(smp) / sr)] + [len(audio) / sr]
    rescued = 0
    for a, b in zip(edges[0::2], edges[1::2]) if vad == "silero" else []:
        if b - a < MIN_GAP_SEC:
            continue
        gap = audio[int(a * sr): int(b * sr)]
        for start, samples in speech_chunks(gap, threshold=VAD_GAP):
            got = _recognize(rec, samples, a + start, t0)
            if re.search(r"\w", "".join(w["w"] for w in got)):
                words += got
                rescued += 1
    if rescued:
        log(f"[Nhận diện] Vớt thêm {rescued} đoạn nói nhỏ / ngắn mà lượt lọc chính bỏ qua.")
    words.sort(key=lambda w: w["s"])
    return words


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        print(json.dumps(catalog_json(), ensure_ascii=False))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "set-vad":
        set_vad(sys.argv[2])
        print(json.dumps({"ok": True}))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "download":
        try:
            download(sys.argv[2])
        except Exception as e:
            log(f"[Lỗi] {e}")
            sys.exit(1)
        return
    print(__doc__)
    sys.exit(2)


if __name__ == "__main__":
    main()
