#!/usr/bin/env python3
"""Tự kiểm tra phần lõi không cần mạng/whisper: .venv/bin/python test_dub_video.py"""
import subprocess
import tempfile
from pathlib import Path

import dub_video as d

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
    vm = d.auto_voice_map(segs, "vieneu-clone:tuncoi")
    assert vm["NV1"]["voice"] == "vieneu-clone:tuncoi" and vm["NV1"]["gender"] == "male"
    assert vm["NV2"]["gender"] == "female" and vm["NV2"]["voice"] in d.AUTO_VOICES["female"]
    # Giọng của dự án được ưu tiên, nhưng không gán giọng nam cho nhân vật nữ khi còn giọng nữ khác
    vm = d.auto_voice_map(segs, "vieneu-clone:tuncoi", ["vieneu-clone:tuncoi", "vieneu:Hải Đăng", "vieneu:Mai Anh"])
    assert vm["NV2"]["voice"] == "vieneu:Mai Anh", vm


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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
