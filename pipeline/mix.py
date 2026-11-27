"""Bước 4: dựng track lồng tiếng theo từng phần (mp3 từng câu → atempo cho vừa khung → FLAC) rồi trộn với âm gốc."""
import hashlib
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional

from pipeline.common import SAMPLE_RATE, build_atempo_chain, run_cmd, run_ffmpeg
from pipeline.job import Job, Progress

if TYPE_CHECKING:
    from pipeline.tts import TTS

AUDIO_PART_SEGS = 150  # số câu thoại trong 1 phần track tiếng = số input của 1 lệnh ffmpeg


MP3_BITRATES = {
    True: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],  # MPEG-1 Layer III
    False: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],  # MPEG-2 / 2.5 Layer III
}


def mp3_duration(path: Path) -> float:
    """Thời lượng 1 câu TTS. File VieNeu là luồng mp3 CBR thô nên tính được ngay từ header (không tốn 1 lần
    chạy ffprobe cho mỗi câu trong 100k câu); file mp3 khác (có thẻ ID3/khung Info) thì hỏi ffprobe."""
    try:
        with path.open("rb") as f:
            head = f.read(4)
        if len(head) == 4 and head[0] == 0xFF and (head[1] & 0xE6) == 0xE2:  # sync + Layer III
            kbps = MP3_BITRATES[(head[1] >> 3) & 3 == 3][head[2] >> 4]
            if kbps:
                return path.stat().st_size * 8 / (kbps * 1000)
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], text=True
        )
        return float(out.strip() or 0)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0.0


def sample_index(t: float) -> int:
    return int(round(t * SAMPLE_RATE))


def audio_part_bounds(segments: List[Dict], duration: float) -> List[float]:
    """Ranh giới các phần track tiếng: mỗi phần tối đa AUDIO_PART_SEGS câu, luôn cắt tại mốc bắt đầu 1 câu.
    Mỗi câu chỉ được phát tới mốc câu kế tiếp, nên không câu nào vắt qua ranh giới phần."""
    bounds = [0.0]
    for s in segments[AUDIO_PART_SEGS::AUDIO_PART_SEGS]:
        if s["start"] > bounds[-1]:
            bounds.append(s["start"])
    bounds.append(max(duration, bounds[-1] + 0.1))
    return bounds


def audio_part_graph(part_segs: List[Dict], mp3s: List[Optional[Path]], t0: float, t1: float):
    """Dựng lệnh ffmpeg cho 1 phần track tiếng: mỗi câu được cắt lặng đầu, tăng tốc (tối đa 1.95x) cho vừa
    khoảng trống, rồi đệm/cắt về ĐÚNG số mẫu tính tới câu kế tiếp — nên cả phần khớp timeline từng mẫu.
    Trả về (danh sách file input, nội dung filter_complex, tổng số mẫu)."""
    silence = f"anullsrc=r={SAMPLE_RATE}:cl=mono,aformat=sample_fmts=s16"
    base, end = sample_index(t0), sample_index(t1)
    inputs: List[str] = []
    chains: List[str] = []
    labels: List[str] = []

    def add(chain: str) -> None:
        labels.append(f"[a{len(labels)}]")
        chains.append(chain + labels[-1])

    pos = base
    for n, (seg, mp3) in enumerate(zip(part_segs, mp3s)):
        start = max(pos, sample_index(seg["start"]))
        nxt = min(end, sample_index(part_segs[n + 1]["start"])) if n + 1 < len(part_segs) else end
        length = nxt - start
        if length <= 0:
            continue
        if start > pos:  # khoảng lặng trước câu (chỉ có ở câu đầu tiên của phần)
            add(f"{silence},atrim=end_sample={start - pos}")
        if mp3:
            slot = max(0.35, length / SAMPLE_RATE - 0.03)
            dur = mp3_duration(mp3)
            tempo = f"{build_atempo_chain(min(1.95, dur / slot))}," if dur > slot * 1.02 else ""
            add(
                f"[{len(inputs)}:a]silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB,{tempo}"
                f"aresample={SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono,"
                f"apad=whole_len={length},atrim=end_sample={length}"
            )
            inputs.append(str(mp3))
        else:
            add(f"{silence},atrim=end_sample={length}")
        pos = nxt
    if pos < end:
        add(f"{silence},atrim=end_sample={end - pos}")
    graph = ";".join(chains) + f";{''.join(labels)}concat=n={len(labels)}:v=0:a=1[out]"
    return inputs, graph, end - base


def build_audio_parts(job: "Job", segments: List[Dict], tts: "TTS", duration: float, prog: "Progress") -> Path:
    """Dựng track lồng tiếng theo từng phần FLAC (không mất dữ liệu, nối lại khít từng mẫu), mỗi phần chỉ
    1 lệnh ffmpeg, cache theo nội dung: chạy tiếp được, và sửa 1 câu chỉ phải dựng lại đúng 1 phần."""
    adir = job.work / "audio"
    adir.mkdir(parents=True, exist_ok=True)
    bounds = audio_part_bounds(segments, duration)
    jobs, i = [], 0
    for k in range(len(bounds) - 1):
        t0, t1 = bounds[k], bounds[k + 1]
        j = i
        while j < len(segments) and segments[j]["start"] < t1:
            j += 1
        part_segs, i = segments[i:j], j
        key = hashlib.sha1(
            # có/không có giọng cũng nằm trong khóa: câu từng tạo giọng lỗi sẽ được dựng lại khi đã có giọng
            json.dumps(
                [t0, t1, [[s["start"], *tts.item(s), bool(tts.cached(*tts.item(s)))] for s in part_segs]]
            ).encode()
        ).hexdigest()[:12]
        jobs.append((k, t0, t1, part_segs, adir / f"a{k:05d}_{key}.flac"))
    done = 0

    def build(item) -> None:
        nonlocal done
        k, t0, t1, part_segs, part = item
        if not part.exists():
            for stale in adir.glob(f"a{k:05d}_*"):
                stale.unlink(missing_ok=True)
            inputs, graph, _ = audio_part_graph(part_segs, [tts.cached(*tts.item(s)) for s in part_segs], t0, t1)
            script = adir / f"a{k:05d}.filter.txt"
            script.write_text(graph, encoding="utf-8")
            tmp = part.with_suffix(".tmp.flac")
            cmd = ["ffmpeg", "-y", "-v", "error"]
            for f in inputs:
                cmd += ["-i", f]
            run_cmd(cmd + ["-filter_complex_script", str(script), "-map", "[out]", "-c:a", "flac", "-f", "flac", str(tmp)])
            os.replace(tmp, part)
            script.unlink(missing_ok=True)
        done += 1
        prog.audio = 0.2 * done / len(jobs)
        prog.emit()

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="audio") as pool:
        list(pool.map(build, jobs))
    keep = [item[4] for item in jobs]
    for f in adir.iterdir():
        if f not in keep:
            f.unlink(missing_ok=True)
    concat = job.work / "audio.txt"
    concat.write_text("".join(f"file '{p}'\n" for p in keep), encoding="utf-8")
    return concat


def build_audio(
    job: Job, input_mp4: Path, segments: List[Dict], tts: "TTS", duration: float,
    bg_volume: float, has_orig_audio: bool, prog: Progress,
) -> Path:
    """Dựng các phần track lồng tiếng rồi trộn với âm nền gốc thành 1 file AAC hoàn chỉnh.
    Mã hóa AAC chỉ nhanh ~28 lần thời gian thực (video 90 tiếng mất ~3 giờ) nên việc này chạy ở luồng
    nền, song song với lúc luồng chính mã hóa video."""
    audio_list = build_audio_parts(job, segments, tts, duration + 0.5, prog)
    dub_in = ["-f", "concat", "-safe", "0", "-i", str(audio_list)]
    if bg_volume > 0.001 and has_orig_audio:
        cmd = ["-i", str(input_mp4)] + dub_in + [
            "-filter_complex",
            f"[0:a:0]volume={bg_volume:.3f}[bg];[1:a]volume=1.35[vo];"
            f"[bg][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]",
            "-map", "[aout]",
        ]
    else:
        cmd = dub_in + ["-map", "0:a:0"]
    mix = job.work / "mix.m4a"

    def on_frac(f):
        prog.audio = 0.2 + 0.8 * f
        prog.emit()

    run_ffmpeg(cmd + ["-c:a", "aac", "-b:a", "128k", "-f", "mp4", str(mix)], duration, on_frac, job.work / "mix_err.log")
    return mix
