#!/usr/bin/env python3
"""Tự kiểm tra phần lõi không cần mạng/whisper: .venv/bin/python test_dub_video.py"""
import atexit
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

# Mọi test ghi vào thư mục tạm (DB, dub_work/...), không đụng data/ và downloads/ thật. Phải đặt trước import dub_video.
_TEST_ROOT = tempfile.mkdtemp(prefix="reup_pytest_")
atexit.register(shutil.rmtree, _TEST_ROOT, ignore_errors=True)
os.environ.setdefault("REUP_DATA_DIR", os.path.join(_TEST_ROOT, "data"))
os.environ.setdefault("REUP_MEDIA_ROOT", os.path.join(_TEST_ROOT, "media"))

import dub_video as d  # noqa: E402

SR = d.SAMPLE_RATE


def _sine_mp3(path, seconds):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ar", "24000", "-ac", "1", "-b:a", "48k", str(path)],
        check=True,
    )


def test_audio_part_is_sample_exact_and_fits_slots():
    """Chạy ffmpeg thật: câu dài bị tăng tốc/cắt, câu thiếu giọng thành im lặng, tổng mẫu đúng từng mẫu."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        _sine_mp3(tmp / "short.mp3", 1.0)
        _sine_mp3(tmp / "long.mp3", 6.0)
        assert abs(d.mp3_duration(tmp / "long.mp3") - 6.0) < 0.15
        segs = [{"start": 1.0}, {"start": 3.0}, {"start": 5.0}, {"start": 5.5}]
        mp3s = [tmp / "short.mp3", tmp / "long.mp3", None, tmp / "long.mp3"]
        inputs, graph, total = d.audio_part_graph(segs, mp3s, 0.0, 10.37)
        assert total == d.sample_index(10.37) and len(inputs) == 3 and "atempo=1.95" in graph
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for f in inputs:
            cmd += ["-i", f]
        pcm = subprocess.run(
            cmd + ["-filter_complex", graph, "-map", "[out]", "-f", "s16le", "-"], check=True, capture_output=True
        ).stdout
        assert len(pcm) == total * 2
        sec = lambda a, b: pcm[int(a * SR) * 2 : int(b * SR) * 2]
        assert not any(sec(0.0, 0.95))  # im lặng trước câu đầu
        assert any(sec(1.1, 1.5)) and not any(sec(2.6, 2.95))  # câu ngắn phát xong rồi im
        assert any(sec(3.1, 4.9))  # câu dài lấp đầy khoảng trống của nó
        assert not any(sec(5.05, 5.45))  # câu không tạo được giọng -> im lặng
        assert any(sec(5.6, 8.0))


def test_audio_part_bounds_cut_only_at_segment_starts():
    segs = [{"start": round(i * 7.3, 2)} for i in range(1000)]
    bounds = d.audio_part_bounds(segs, 7300.5)
    assert bounds[0] == 0.0 and bounds[-1] == 7300.5 and len(bounds) == 8
    assert all(b in {s["start"] for s in segs} for b in bounds[1:-1])
    # tổng mẫu các phần = cả timeline, kể cả video 90 tiếng thưa lời thoại
    assert sum(d.sample_index(b) - d.sample_index(a) for a, b in zip(bounds, bounds[1:])) == d.sample_index(7300.5)
    assert d.audio_part_bounds([], 324000.0) == [0.0, 324000.0]


def test_pick_cut_prefers_longest_silence():
    words = [{"s": 570 + i, "e": 570.9 + i, "w": "x"} for i in range(60)]
    words[35]["e"] = 605.2  # khoảng lặng dài nhất nằm trước từ thứ 36
    words[36]["s"] = 607.0
    cut = d.pick_cut(words, 600.0, 630.0)
    assert 605.2 < cut < 607.0
    assert d.pick_cut([], 600.0, 630.0) == 600.0
    assert d.pick_cut([{"s": 10, "e": 11, "w": "x"}], 600.0, 630.0) == 600.0


def test_words_to_segments_and_loop_guard():
    words = [{"w": "你好。", "s": 0.0, "e": 0.5}, {"w": "走吧", "s": 0.6, "e": 1.0}]
    segs = d.words_to_segments(words)
    assert [s["zh"] for s in segs] == ["你好。", "走吧"]
    loop = [{"w": "谢谢观看。", "s": i, "e": i + 0.5} for i in range(6)]
    assert len(d.words_to_segments(loop)) == 2  # Whisper lặp vô hạn -> chỉ giữ 2 lần


def test_part_srt_is_shifted_and_clipped():
    segs = [
        {"start": 598.0, "end": 601.0, "vi": "vắt qua ranh giới"},
        {"start": 700.0, "end": 702.0, "vi": "phần hai"},
        {"start": 10.0, "end": 12.0, "vi": "phần một"},
    ]
    srt = d.build_srt(segs, offset=600.0, window=600.0)
    assert "phần một" not in srt
    assert "00:00:00,000 --> 00:00:01,000\nvắt qua ranh giới" in srt
    assert "00:01:40,000 --> 00:01:42,000\nphần hai" in srt
    assert "25:00:00,000" in d.build_srt([{"start": 90000.0, "end": 90001.0, "vi": "giờ thứ 25"}])


def test_subcover_filter():
    assert d.build_subcover_filter("none", 1280, 720) == ""
    # che phụ đề gốc = xóa kiểu delogo (không còn khối mờ tối)
    assert d.build_subcover_filter("129,577,1024,87", 1280, 720) == "delogo=x=129:y=577:w=1024:h=87:show=0"
    # vùng vượt mép video thì cắt cho vừa (delogo không cho chạm mép)
    assert d.build_subcover_filter("1180,700,500,500", 1280, 720) == "delogo=x=1180:y=700:w=99:h=19:show=0"
    assert d.build_subcover_filter("0,0,50,50", 1280, 720) == "delogo=x=1:y=1:w=50:h=50:show=0"


def test_subtitle_style_and_ass():
    import subtitles as sb

    assert sb.clean_style(None) is None and sb.clean_style({}) is None
    st = sb.clean_style({"font": "A,B{x}\nC", "color": "#ff0000", "bg": "javascript", "bg_opacity": 500, "outline_width": -3})
    assert "," not in st["font"] and "{" not in st["font"] and "\n" not in st["font"]  # không phá được dòng Style của ASS
    assert st["color"] == "#FF0000" and st["bg"] == "#000000" and st["bg_opacity"] == 100 and st["outline_width"] == 0
    assert sb._ass_color("#FF8000", 100) == "&H000080FF" and sb._ass_color("#FF8000", 0) == "&HFF0080FF"
    ass = sb.build_ass([(0, 2.5, "Xin {chào}\nbạn")], 1280, 720)
    assert "PlayResY: 720" in ass and "Xin chào\\Nbạn" in ass
    assert ass.count("Dialogue: 0,") == 1 and ass.count("Dialogue: 1,") == 1  # mặc định: có nền + chữ
    assert "Dialogue: 0," not in sb.build_ass([(0, 1, "a")], 1280, 720, "none", sb.clean_style({"bg_opacity": 0}))
    # vùng che: chữ căn giữa trong vùng: lề trái/phải theo vùng, đáy chữ phía trên mép dưới vùng
    lay = sb.layout("128,576,1024,86", 1280, 720)
    assert lay["ml"] == 132 and lay["mr"] == 132 and lay["cover"]
    assert (lay["cx"], lay["cy"]) == (640, 619)  # tâm vùng
    assert lay["size"] == round(86 / 2.6)  # vừa 2 dòng trong vùng
    assert "{\\an5\\pos(640,619)}" in sb.build_ass([(0, 1, "a")], 1280, 720, "128,576,1024,86")
    assert sb.layout("none", 1280, 720)["size"] == 40  # 16/288 chiều cao


def test_agy_model_argument():
    """Chọn model thì gọi `agy --model <id>` (id đã gồm mức suy nghĩ); chưa chọn thì giữ `--effort low` như cũ."""
    import json as _json
    import types

    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        out = _json.dumps({"structured_output": {"translations": [{"id": 1, "vi": "x"}]}})
        return types.SimpleNamespace(returncode=0, stdout=out, stderr="")

    real = d.subprocess.run
    d.subprocess.run = fake_run
    try:
        for model in ["", "gemini-4-neon-high"]:
            t = d.Translator.__new__(d.Translator)
            t.agy_model = model
            t._call_agy("p")
    finally:
        d.subprocess.run = real
    default, chosen = calls
    assert "--effort" in default and "low" in default and "--model" not in default
    assert chosen[chosen.index("--model") + 1] == "gemini-4-neon-high" and "--effort" not in chosen


def test_delogo_matches_js():
    assert d.build_delogo_filter("top-right", 1920, 1080) == "delogo=x=1411:y=16:w=480:h=73:show=0"
    assert d.build_delogo_filter("none", 1920, 1080) == ""
    assert d.build_delogo_filter("both-top", 1280, 720).count("delogo=") == 2
    assert d.build_delogo_filter("10,20,300,60", 1920, 1080) == "delogo=x=10:y=20:w=300:h=60:show=0"


def test_cluster_speakers_and_voice_map():
    import numpy as np

    rng = np.random.default_rng(0)
    a, b = rng.normal(size=192), rng.normal(size=192)
    # 2 người nói xen kẽ + 1 câu rất ngắn: câu ngắn phải được gán theo nhóm gần nhất, không thành nhân vật mới
    raw = [a, b, a, b, a, b, a, b, a * 0.9 + b * 0.1]
    emb = np.stack([v + rng.normal(scale=0.15, size=192) for v in raw])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True)
    durs = np.array([3.0, 2, 3, 2, 3, 2, 3, 2, 0.4])
    lab = d.cluster_speakers(emb, durs)
    assert list(lab) == [0, 1, 0, 1, 0, 1, 0, 1, 0], lab  # 0 = người nói nhiều nhất

    segs = [{"start": i, "end": i + du, "speaker": f"NV{l + 1}", "_f0": 120 if l == 0 else 280}
            for i, (l, du) in enumerate(zip(lab, durs))]
    vm = d.auto_voice_map(segs, "vieneu-clone:longtieng")
    assert vm["NV1"]["voice"] == "vieneu-clone:longtieng" and vm["NV1"]["gender"] == "male"
    assert vm["NV2"]["gender"] == "female" and vm["NV2"]["voice"] in d.AUTO_VOICES["female"]
    # Giọng của dự án được ưu tiên, nhưng không gán giọng nam cho nhân vật nữ khi còn giọng nữ khác
    vm = d.auto_voice_map(segs, "vieneu-clone:longtieng", ["vieneu-clone:longtieng", "vieneu:Hải Đăng", "vieneu:Mai Anh"])
    assert vm["NV2"]["voice"] == "vieneu:Mai Anh", vm

    # Phân vai: NV1 nói chủ yếu câu của 江云 (đã cấu hình giọng), NV2 là nhân vật AI mới gặp; 1 câu lạc không đổi kết quả
    for s, who in zip(segs, ["江云", "小红", "江云", "小红", "江云", "小红", "江云", "", "小红"]):
        s["who"] = who
    chars = [{"zh": "江云", "vi": "Giang Vân", "voice": "vieneu:Hải Đăng"}, {"zh": "小红", "vi": "Tiểu Hồng"}]
    cast = d.match_characters(segs, chars, {"江云"})
    assert cast["NV1"] == {"zh": "江云", "name": "Giang Vân", "is_new": False, "voice": "vieneu:Hải Đăng"}, cast
    assert cast["NV2"]["name"] == "Tiểu Hồng" and cast["NV2"]["is_new"] and cast["NV2"]["voice"] == "", cast
    vm = d.auto_voice_map(segs, "vieneu-clone:longtieng", None, {"NV1": "vieneu:Hải Đăng"})
    assert vm["NV1"]["voice"] == "vieneu:Hải Đăng" and vm["NV2"]["voice"] in d.AUTO_VOICES["female"], vm
    # Nhóm chỉ có 1 câu ghi tên: chưa đủ căn cứ, để "chưa rõ"
    assert d.match_characters([{"start": 0, "end": 2, "speaker": "NV1", "who": "江云"}], chars, set()) == {}


def test_segments_db_roundtrip():
    old = d.DB_PATH
    with tempfile.TemporaryDirectory() as tmp:
        d.DB_PATH = Path(tmp) / "t.db"
        try:
            segs = [{"id": 1, "start": 0.0, "end": 1.5, "zh": "大家好", "vi": "Chào mọi người", "speaker": "NV2"},
                    {"id": 2, "start": 2.0, "end": 3.0, "zh": "走", "vi": ""}]
            d.save_segments("job_a", segs)
            d.save_segments("job_b", segs[:1])
            d.save_segments("job_a", segs)  # ghi lại không nhân đôi
            assert d.load_segments("job_a") == segs
            assert len(d.load_segments("job_b")) == 1 and d.load_segments("khong_co") == []
        finally:
            d.DB_PATH = old


def test_voice_ref_candidates():
    import voice_tool as vt

    sr = 16000
    sp = lambda a, b: {"start": int(a * sr), "end": int(b * sr)}
    # 2 câu sát nhau gộp thành 1 cụm 5 giây; câu lẻ 2 giây bị loại; khoảng nói 20 giây chỉ lấy 7 giây đầu
    got = vt.pick_candidates([sp(0, 2.5), sp(2.7, 5.0), sp(10, 12), sp(30, 50)], sr)
    assert got == [(0.0, 5.0), (30.0, 37.0)], got
    assert vt.pick_candidates([sp(0, 3.4)], sr) == [] and vt.pick_candidates([sp(0, 3.4)], sr, vt.MIN_REF) == [(0.0, 3.4)]


def test_vieneu_voice_parsing():
    # Không nạp mô hình: chỉ kiểm tra cách hiểu tên giọng và chặn đường dẫn lạ.
    assert d.VieNeuEngine("vieneu:Hải Đăng").preset == "Hải Đăng"
    for bad in ["vieneu-clone:../x", "vieneu-clone:Abc", "vieneu-clone:", "vi-VN-NamMinhNeural", "vieneu:"]:
        try:
            d.VieNeuEngine(bad)
            raise AssertionError(bad)
        except ValueError:
            pass


def test_gpu_batched_tts_dedup_and_unload():
    """Trên GPU, ensure_all gộp câu trùng, chạy theo lô theo từng giọng, tự vớt câu lỗi và unload sạch mô hình."""
    import numpy as np

    sr = 24000
    tone = np.sin(np.linspace(0, 80, int(sr * 0.5), dtype=np.float32)) * 0.2
    batch_calls = []
    closed = []

    class DummyModel:
        max_batch_size = 4

        def close(self):
            closed.append(True)

    d.VieNeuEngine._model = DummyModel()
    orig_gpu = d.tts_will_use_gpu
    orig_model = d.VieNeuEngine.model
    orig_batch = d.VieNeuEngine.synth_batch_wavs
    orig_single = d.VieNeuEngine.synth_mp3
    try:
        d.tts_will_use_gpu = lambda: True
        d.VieNeuEngine.model = classmethod(lambda cls: cls._model)

        def fake_batch(self, texts):
            batch_calls.append((self.preset, list(texts)))
            # câu "lỗi lô" trả mảng rỗng để kiểm tra đường vớt lẻ từng câu
            return [np.zeros(0, dtype=np.float32) if t == "lỗi lô" else tone for t in texts], sr

        def fake_single(self, text, out):
            return d.VieNeuEngine._wav_to_mp3(tone, sr, out)

        d.VieNeuEngine.synth_batch_wavs = fake_batch
        d.VieNeuEngine.synth_mp3 = fake_single

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            job = d.Job("test_gpu_tts")
            job.work = tmp / "work"
            prog = d.Progress(job, 60.0, False)
            tts = d.TTS(tmp / "tts", "vieneu:Thiện Minh", 2, prog)
            items = [
                ("Xin chào", "vieneu:Thiện Minh"),
                ("Xin chào", "vieneu:Thiện Minh"),  # câu lặp lại trong video dài -> chỉ tổng hợp 1 lần
                ("Đi thôi", "vieneu:Thiện Minh"),
                ("lỗi lô", "vieneu:Thiện Minh"),   # vớt lại bằng synth_mp3
                ("", "vieneu:Thiện Minh"),
            ]
            # Có GPU: câu dịch xong chỉ xếp hàng, tới khi Nhận diện nhả VRAM (gpu_go) mới được đọc.
            tts.gpu = True
            tts.prewarm([("Đọc sớm", "vieneu:Thiện Minh")])
            assert not tts.prewarmed and not tts.path("Đọc sớm").exists()
            tts.gpu_go()
            outs = tts.ensure_all(items)
            assert tts.path("Đọc sớm").exists()
            tts.pool.shutdown()
            assert len(batch_calls) == 1 and batch_calls[0] == ("Thiện Minh", ["Xin chào", "Đi thôi", "lỗi lô"])
            assert outs[0] == outs[1] and outs[0] is not None and outs[2] is not None and outs[3] is not None and outs[4] is None
            assert prog.tts_done == len(items)
            d.VieNeuEngine.unload()
            assert d.VieNeuEngine._model is None and closed == [True]
    finally:
        d.VieNeuEngine._model = None
        d.tts_will_use_gpu = orig_gpu
        d.VieNeuEngine.model = orig_model
        d.VieNeuEngine.synth_batch_wavs = orig_batch
        d.VieNeuEngine.synth_mp3 = orig_single


def test_video_encode_args_and_render_parts():
    """Kiểm tra chọn NVENC/CPU và xuất thật 1 đoạn video có xóa logo + phụ đề."""
    args_cpu, used = d.video_encode_args(1_200_000, "cpu")
    assert not used and "libx264" in args_cpu and "1200000" in args_cpu
    args_nv, used_nv = d.video_encode_args(1_200_000, "nvenc")
    assert used_nv and "h264_nvenc" in args_nv and "-cq" in args_nv

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "in.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1.5:size=640x360:rate=15",
             "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", str(src)],
            check=True,
        )
        job = d.Job("test_render")
        job.work = tmp / "work"
        job.parts_dir = job.work / "parts"
        prog = d.Progress(job, 1.5, True)
        st = src.stat()
        segs = [{"start": 0.1, "end": 1.2, "vi": "Thử xuất GPU"}]
        concat = d.render_parts(
            job, src, segs, 1.5, True, d.build_delogo_filter("top-right", 640, 360),
            [st.st_size, int(st.st_mtime)], prog, size=(640, 360), encoder="auto",
        )
        lines = concat.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 1
        part_mp4 = Path(lines[0].split("'")[1])
        assert part_mp4.exists() and part_mp4.stat().st_size > 1000



def test_paths_from_args():
    with tempfile.TemporaryDirectory() as tmp:
        old = d.STORY_PROJECTS_DIR
        try:
            d.STORY_PROJECTS_DIR = Path(tmp)
            assert d.story_project_path("a") == Path(tmp) / "a.json"  # dạng cũ
            (Path(tmp) / "a").mkdir()
            (Path(tmp) / "a" / "project.json").write_text("{}")
            assert d.story_project_path("a") == Path(tmp) / "a" / "project.json"  # dạng thư mục
            assert d.story_project_path("../a") == Path(tmp) / "a" / "project.json"  # không thoát ra ngoài
        finally:
            d.STORY_PROJECTS_DIR = old
        assert d.rel_to_base(d.BASE_DIR / "downloads" / "dubbed") == "downloads/dubbed"
        assert d.from_base("downloads/dubbed") == d.BASE_DIR / "downloads" / "dubbed"
        assert d.rel_to_base(Path(tmp)) == str(Path(tmp).resolve())
        assert d.Job("j1", Path(tmp) / "w").meta_path == Path(tmp) / "w" / "meta.json"
        assert d.Job("j1").work == d.WORK_ROOT / "j1"


def _paths_in_child(env_extra, code):
    """Chạy Python con với env cho trước (bỏ REUP_* của tiến trình cha) để module đọc lại biến lúc import."""
    import json
    import os
    import sys

    env = {k: v for k, v in os.environ.items() if not k.startswith("REUP_")}
    env.update(env_extra)
    out = subprocess.run([sys.executable, "-c", code], cwd=str(d.BASE_DIR), env=env, check=True,
                         capture_output=True, text=True).stdout
    return json.loads(out.strip().splitlines()[-1])


_PATHS_CODE = """
import json, asr, subtitles, list_channel_adb as adb, dub_video as d
print(json.dumps({k: str(v) for k, v in {
    "models": asr.MODELS_DIR, "asr_settings": asr.SETTINGS_JSON, "fonts": subtitles.FONTS_DIR,
    "videos_json": adb.DEFAULT_JSON, "db": d.DB_PATH, "work": d.WORK_ROOT, "dub_projects": d.PROJECTS_DIR,
    "projects": d.STORY_PROJECTS_DIR, "dubbed": d.DUBBED_INDEX_JSON, "voices": d.VOICES_DIR, "out": d.DUB_OUT_DIR,
}.items()}))
"""


def test_reup_data_dir_default_is_repo():
    """Không đặt REUP_DATA_DIR/REUP_MEDIA_ROOT: đường dẫn y như trước (data/ và downloads/ trong repo)."""
    p = _paths_in_child({}, _PATHS_CODE)
    data, base = d.BASE_DIR / "data", d.BASE_DIR
    assert p["models"] == str(data / "asr_models") and p["asr_settings"] == str(data / "asr_settings.json")
    assert p["db"] == str(data / "openreup.db") and p["work"] == str(data / "dub_work")
    assert p["fonts"] == str(data / "fonts") and p["voices"] == str(data / "voices")
    assert p["videos_json"] == str(data / "videos.json") and p["dubbed"] == str(data / "dubbed.json")
    assert p["dub_projects"] == str(data / "dub_projects") and p["projects"] == str(data / "projects")
    assert p["out"] == str(base / "downloads" / "dubbed")


def test_reup_data_dir_isolates_writes():
    """Đặt REUP_DATA_DIR: asr_models, asr_settings.json, openreup.db... nằm trong thư mục đó, data/ thật không bị ghi."""
    import os

    import asr

    real = d.BASE_DIR / "data"
    watch = [real / "asr_settings.json", real / "openreup.db", real / "openreup.db-wal", real / "asr_models"]
    before = {str(w): (w.exists() and w.stat().st_mtime_ns) for w in watch}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        env = {"REUP_DATA_DIR": str(tmp / "data"), "REUP_MEDIA_ROOT": str(tmp / "media")}
        p = _paths_in_child(env, _PATHS_CODE)
        for k, v in p.items():
            root = tmp / ("media" if k == "out" else "data")
            assert Path(v).is_relative_to(root), (k, v)
        assert p["models"] == str(tmp / "data" / "asr_models") and p["db"] == str(tmp / "data" / "openreup.db")
        # Ghi thật: set-vad (cần file VAD giả) + mở DB câu thoại
        (tmp / "data" / "asr_models").mkdir(parents=True)
        (tmp / "data" / "asr_models" / asr.VAD_FILE).write_bytes(b"x")
        env_run = {k: v for k, v in os.environ.items() if not k.startswith("REUP_")} | env
        import sys

        subprocess.run([sys.executable, "asr.py", "set-vad", "silero"], cwd=str(d.BASE_DIR), env=env_run,
                       check=True, capture_output=True)
        _paths_in_child(env, "import json, dub_video as d; d.open_db().close(); print(json.dumps({}))")
        assert (tmp / "data" / "asr_settings.json").read_text() == '{"vad": "silero"}'
        assert (tmp / "data" / "openreup.db").exists()
    after = {str(w): (w.exists() and w.stat().st_mtime_ns) for w in watch}
    assert before == after, (before, after)

if __name__ == "__main__":
    # CI không cài VieNeu-TTS (nặng, kèm model): bỏ qua đúng các test được liệt kê, không bỏ ngầm test nào khác.
    skip = {s.strip() for s in os.environ.get("SKIP_TESTS", "").split(",") if s.strip()}
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            if name in skip:
                print("skip", name)
                continue
            fn()
            print("ok", name)
