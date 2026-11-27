"""Bước 3: giọng đọc tiếng Việt (VieNeu-TTS chạy trên máy), cache theo nội dung câu."""
import hashlib
import os
import re
import subprocess
import threading
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pipeline.paths import DATA_DIR
from pipeline.common import FFMPEG_BIN, SAMPLE_RATE, cpu_forced, free_gpu_memory, log
from pipeline.job import Progress


def tts_will_use_gpu() -> bool:
    """Kiểm tra VieNeu có chạy trên CUDA không (không tạo CUDA context để nhường trọn VRAM cho Whisper)."""
    if cpu_forced():
        return False
    if importlib.util.find_spec("torch") is None:
        return False
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ----------------------------------------------------------------------------
# Bước 4: Giọng đọc tiếng Việt (VieNeu-TTS chạy trên máy) — cache theo nội dung câu
# ----------------------------------------------------------------------------
VOICES_DIR = DATA_DIR / "voices"


class VieNeuEngine:
    """VieNeu-TTS v3 Turbo chạy offline (tự nhận PyTorch CUDA trên GPU hoặc ONNX trên CPU). Giọng:
    - "vieneu:<tên preset>"   vd vieneu:Hải Đăng
    - "vieneu-clone:<slug>"   clone từ data/voices/<slug>.wav (clip 3–8 giây, 1 người nói)"""

    _model = None
    _load_lock = threading.Lock()
    _infer_lock = threading.Lock()  # 1 mô hình dùng chung cho mọi giọng, khóa lượt suy luận

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

                kw: Dict = {}
                dev_desc = "CPU (ONNX)"
                if cpu_forced():
                    kw = {"backend": "onnx", "device": "cpu"}
                    dev_desc = "CPU (ONNX, REUP_FORCE_CPU=1)"
                else:
                    try:
                        import torch

                        if torch.cuda.is_available():
                            vram_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
                            major, _minor = torch.cuda.get_device_capability(0)
                            # Turing (sm_75 như GTX 1650) không hỗ trợ BF16 Cutlass -> ép float32.
                            dtype = "float32" if major < 8 else "auto"
                            # GPU 4 GB (như GTX 1650): giữ batch vừa phải để CUDA graph KV cache không tràn VRAM.
                            bs = 8 if vram_gb <= 4.5 else (16 if vram_gb <= 8.5 else 32)
                            kw = {"dtype": dtype, "max_batch_size": bs, "max_streams": max(4, bs // 2)}
                            dev_desc = f"GPU {torch.cuda.get_device_name(0)} ({vram_gb:.1f} GB VRAM, dtype={dtype}, batch={bs})"
                    except Exception:
                        pass
                log(f"[Giọng đọc] Đang nạp mô hình VieNeu-TTS trên {dev_desc}...")
                cls._model = Vieneu(**kw)
        return cls._model

    @classmethod
    def unload(cls) -> None:
        """Giải phóng mô hình VieNeu và CUDA graphs khỏi VRAM trước khi chuyển sang bước xuất video."""
        with cls._load_lock:
            m = cls._model
            cls._model = None
        if m is not None:
            for owner in (m, getattr(m, "engine", None)):
                be = getattr(owner, "_batch_engine", None) if owner is not None else None
                if be is not None:
                    for attr in ("_fused", "_graphs"):
                        coll = getattr(be, attr, None)
                        if hasattr(coll, "clear"):
                            try:
                                coll.clear()
                            except Exception:
                                pass
            close = getattr(m, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            del m
            free_gpu_memory("Giọng đọc")

    @staticmethod
    def _wav_to_mp3(wav, sample_rate: int, out: Path) -> bool:
        if wav is None or len(wav) < sample_rate * 0.1:
            return False
        # mp3 CBR không thẻ ID3: mp3_duration() đọc được thời lượng ngay từ header, không cần ffprobe.
        subprocess.run(
            [FFMPEG_BIN, "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "-",
             "-ar", str(SAMPLE_RATE), "-b:a", "64k", "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", str(out)],
            input=wav.astype("float32").tobytes(), check=True,
        )
        return out.exists() and out.stat().st_size > 200

    def synth_mp3(self, text: str, out: Path) -> bool:
        tts = self.model()
        with self._infer_lock:
            # Giọng clone: lần đầu lọc nhiễu + trích đặc trưng giọng, sau đó VieNeu tự nhớ (cache theo nội dung file).
            wav = tts.infer(text, ref_audio=self.ref_audio) if self.ref_audio else tts.infer(text, voice=self.preset)
        return self._wav_to_mp3(wav, tts.sample_rate, out)

    def synth_batch_wavs(self, texts: List[str]) -> Optional[Tuple[List, int]]:
        """Trên GPU (PyTorch), gộp nhiều câu cùng giọng vào 1 lượt infer_batch để tăng tốc gấp nhiều lần."""
        tts = self.model()
        if getattr(tts, "backend", "") != "pytorch" or not hasattr(tts, "infer_batch") or len(texts) < 2:
            return None
        with self._infer_lock:
            wavs = (
                tts.infer_batch(texts, ref_audio=self.ref_audio)
                if self.ref_audio
                else tts.infer_batch(texts, voice=self.preset)
            )
        return wavs, tts.sample_rate


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
        # GPU: đọc theo lô ở 1 luồng riêng (chỉ chạy sau gpu_go), nén mp3 ở save_pool để GPU không phải chờ ffmpeg.
        self.gpu = False
        self.gpu_ready = False
        self.gpu_queue: List = []
        self.batch_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-gpu")
        self.save_pool = ThreadPoolExecutor(max_workers=max(2, min(6, (os.cpu_count() or 4) - 2)), thread_name_prefix="tts-mp3")

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
        if self.gpu:
            with self.lock:
                self.gpu_queue += items
            self._drain_gpu()
            return
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
        if not items or not tts_will_use_gpu():
            return list(self.pool.map(self._ensure_counted, items))
        self._ensure_batched(items)
        return [self.cached(t, v or self.voice) for t, v in items]

    def gpu_go(self) -> None:
        """Bước Nhận diện đã nhả VRAM: bắt đầu đọc theo lô các khối đã dịch xong, song song với phần dịch còn lại."""
        self.gpu_ready = True
        self._drain_gpu()

    def _drain_gpu(self) -> None:
        if not self.gpu_ready:
            return

        def run() -> None:
            with self.lock:
                items, self.gpu_queue = self.gpu_queue, []
            if items:
                self._ensure_batched(items)

        self.prewarmed.append(self.batch_pool.submit(run))

    def _ensure_batched(self, items) -> None:
        """GPU: gom các câu chưa có cache theo từng giọng để chạy infer_batch (nhanh gấp nhiều lần từng câu lẻ).
        mp3 của lô trước được nén ở luồng nền trong lúc GPU chạy lô sau."""
        counts: Dict[Tuple[str, str], int] = {}
        by_voice: Dict[str, List[str]] = {}
        done_now = 0
        for raw_text, raw_voice in items:
            text = (raw_text or "").strip()
            voice = raw_voice or self.voice
            if not text or not re.search(r"\w", text):
                done_now += 1
                continue
            out = self.path(text, voice)
            if out.exists() and out.stat().st_size > 200:
                done_now += 1
                continue
            key = (text, voice)
            if key not in counts:
                counts[key] = 0
                by_voice.setdefault(voice, []).append(text)
            counts[key] += 1
        if done_now:
            self.prog.bump("tts_done", done_now)

        def save_wav(text, voice, wav, sr) -> bool:
            out = self.path(text, voice)
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(f"{out.stem}.{threading.get_ident()}.tmp.mp3")
            try:
                if VieNeuEngine._wav_to_mp3(wav, sr, tmp):
                    os.replace(tmp, out)
                    return True
                return False
            except Exception:
                return False
            finally:
                tmp.unlink(missing_ok=True)

        def single(t: str, voice: str) -> None:
            try:
                self.ensure(t, voice)
            finally:
                self.prog.bump("tts_done", counts[(t, voice)])

        def settle(voice: str, texts: List[str], futs) -> None:
            for t, f in zip(texts, futs):
                if f.result():
                    self.prog.bump("tts_done", counts[(t, voice)])
                else:  # lô trả âm thanh hỏng cho câu này -> vớt lại bằng đọc lẻ
                    single(t, voice)

        pending = None  # (giọng, các câu, future lưu mp3) của lô trước
        for voice, texts in by_voice.items():
            eng = self.engine(voice)
            bs = max(8, int(getattr(eng.model(), "max_batch_size", 8)) * 2)
            for i in range(0, len(texts), bs):
                batch_texts = texts[i : i + bs]
                res = None
                if len(batch_texts) >= 2:
                    try:
                        res = eng.synth_batch_wavs(batch_texts)
                    except Exception as e:
                        log(f"[Giọng đọc] ⚠ Lô GPU {len(batch_texts)} câu gặp lỗi ({e}), chuyển sang đọc lẻ từng câu...")
                        free_gpu_memory()
                if pending:
                    settle(*pending)
                    pending = None
                if res is None:  # lô lỗi, lô 1 câu, hoặc VieNeu không chạy backend PyTorch (ONNX)
                    list(self.pool.map(lambda t: single(t, voice), batch_texts))
                else:
                    wavs, sr = res
                    pending = (voice, batch_texts, [self.save_pool.submit(save_wav, t, voice, w, sr) for t, w in zip(batch_texts, wavs)])
        if pending:
            settle(*pending)
