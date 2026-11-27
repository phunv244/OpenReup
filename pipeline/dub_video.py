#!/usr/bin/env python3
"""
Dịch & lồng tiếng Việt tự động cho video tiếng Trung — chạy được với video 9, 10, 90 tiếng.

Thiết kế cho video siêu dài:
  - Không bao giờ nạp cả video / cả track âm thanh vào RAM: mọi thứ xử lý theo KHỐI ~10 phút.
  - Mỗi khối xong là ghi checkpoint xuống data/dub_work/<job_id>/ -> dừng, mất điện, lỗi mạng
    thì chạy lại sẽ TIẾP TỤC đúng chỗ đang dở chứ không làm lại từ đầu.
  - Nhận diện (CPU) chạy song song với dịch (Antigravity) và tạo giọng đọc (TTS) ở luồng nền.
  - Giọng đọc được cache theo nội dung câu; video in phụ đề được xuất theo từng phần 10 phút
    và cache theo nội dung phụ đề -> "Sửa lời & Xuất lại" chỉ làm lại đúng phần bị sửa.

Hai chế độ:
  - Chạy mới / tiếp tục:  pipeline/dub_video.py --input <mp4> --speed 0.5 --voice "vieneu:Thiện Minh"
  - Xuất lại sau khi sửa: pipeline/dub_video.py --project <job_id>   (bỏ qua nhận diện & dịch)

Mã chia theo bước trong gói pipeline/ (file này chỉ điều phối):
  stt.py (nhận diện) → translate.py (dịch) → speakers.py + tts.py (giọng đọc) → mix.py (ghép âm) → render.py (xuất video)
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

if __package__ in (None, ""):  # chạy bằng đường dẫn file (server: python pipeline/<script>.py) → import gói từ gốc repo
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

from pipeline.common import CHILDREN, NARRATOR_ZH, assert_disk_space, dir_size_mb, fmt_clock, from_base, log, probe_media, read_json, rel_to_base, run_ffmpeg, write_json_atomic
from pipeline import store
from pipeline.job import Job, Progress
from pipeline.mix import build_audio
from pipeline.render import PART_SEC, build_delogo_filter, build_srt, mux_final, render_parts
from pipeline.speakers import auto_voice_map, diarize, match_characters, save_character_voices
from pipeline.store import StorePaths, check_job_id, load_segments, load_story_context, save_segments, update_dubbed_index
from pipeline.stt import run_stt
from pipeline.subtitles import build_subcover_filter, clean_style
from pipeline.translate import Translator
from pipeline.tts import TTS, VieNeuEngine, tts_will_use_gpu

JOB: Optional["Job"] = None

RERENDER = False


@dataclass
class Run:
    """Tham số đã chốt của một lượt chạy: chạy mới lấy từ dòng lệnh, xuất lại lấy từ file project đã lưu."""
    job_id: str
    input_mp4: Path
    speed: float
    voice: str
    bg_volume: float
    burn_sub: bool
    delogo: str
    subcover: str
    agy_model: str
    sub_style: Optional[Dict]
    story_project_id: str
    multi_voice: bool
    speakers: Dict
    segments: List[Dict]
    rerender: bool
    proj: Dict = field(default_factory=dict)  # file project của lần chạy trước (chỉ khi xuất lại)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dịch & Lồng tiếng Việt tự động cho video tiếng Trung")
    parser.add_argument("--input", help="Đường dẫn file MP4 gốc")
    parser.add_argument("--project", help="Job ID có sẵn để render lại sau khi sửa bản dịch")
    parser.add_argument("--story-project", default="", help="ID Dự án truyện/phim (data/projects/<id>.json)")
    parser.add_argument("--speed", type=float, default=0.5, help="Tốc độ làm chậm khi tách âm (mặc định 0.5)")
    parser.add_argument("--voice", default="vieneu:Thiện Minh", help="Giọng VieNeu: vieneu:<preset> hoặc vieneu-clone:<slug>")
    parser.add_argument("--model", default="sensevoice-small", help="Mô hình nhận diện (xem: asr.py list)")
    parser.add_argument("--bg-volume", type=float, default=0.06, help="Âm lượng âm thanh gốc giữ lại (0.0 = tắt hẳn)")
    parser.add_argument("--no-sub", action="store_true", help="Không in cứng phụ đề tiếng Việt lên video")
    parser.add_argument("--delogo", default="none", help="Xóa logo ngay khi xuất: none | top-right | top-left | both-top | x,y,w,h")
    parser.add_argument("--subcover", default="none", help="Che phụ đề gốc (làm mờ) ở vùng x,y,w,h; phụ đề Việt hiện trong vùng này")
    parser.add_argument("--sub-style", default="", help="Kiểu phụ đề Việt (JSON: font, color, bg, bg_opacity, outline, outline_width...); rỗng = mặc định")
    parser.add_argument("--agy-model", default="", help="Model Antigravity dùng để dịch (xem: agy models); rỗng = mặc định")
    parser.add_argument("--multi-voice", action="store_true",
                        help="Tự phân biệt nhân vật theo giọng nói gốc, mỗi nhân vật một giọng VieNeu")
    parser.add_argument("--only", choices=["video", "audio"], default="",
                        help="Chỉ với --project: 'video' = chỉ mã hóa lại hình (giữ nguyên tiếng đã xuất), 'audio' = chỉ dựng lại tiếng (giữ nguyên hình đã xuất)")
    parser.add_argument("--fresh", action="store_true", help="Bỏ kết quả dở dang, nhận diện & dịch lại từ đầu")
    parser.add_argument("--chunk-min", type=float, default=10.0, help="Độ dài mỗi khối nhận diện (phút)")
    parser.add_argument("--translate-workers", type=int, default=3, help="Số lô dịch chạy song song")
    # VieNeu chạy lần lượt từng câu (1 mô hình dùng hết CPU); luồng thứ 2 chỉ để nối phần mã hóa mp3 của câu trước.
    parser.add_argument("--tts-workers", type=int, default=2, help="Số luồng tạo giọng đọc")
    parser.add_argument("--encoder", choices=["auto", "nvenc", "cpu"], default="auto",
                        help="Bộ mã hóa video khi in phụ đề / xóa logo: auto (ưu tiên GPU NVENC) | nvenc | cpu")
    # Đường dẫn do server (module dub) quyết định; bỏ trống = vị trí mặc định cũ. Xuất lại không truyền thì dùng lại
    # out_dir/work_dir đã lưu trong file project của lần chạy trước.
    parser.add_argument("--out-dir", default="", help="Thư mục ghi <job>.mp4 / <job>.srt (mặc định downloads/dubbed)")
    parser.add_argument("--work-dir", default="", help="Thư mục làm việc/checkpoint của job (mặc định data/dub_work/<job>)")
    parser.add_argument("--job-id", default="", help="Mã job do server cấp (chữ/số/_/-); rỗng = tự suy từ tên file và tốc độ")
    parser.add_argument("--project-file", default="", help="File project lồng tiếng để đọc/ghi (mặc định data/dub_projects/<job>.json)")
    parser.add_argument("--index-file", default="", help="File danh sách bản lồng tiếng (mặc định data/dubbed.json)")
    parser.add_argument("--story-dir", default="", help="Thư mục chứa dự án truyện (mặc định data/projects)")
    return parser.parse_args()


def load_rerender(args: argparse.Namespace) -> Run:
    """Xuất lại: đọc tham số + câu thoại đã chỉnh sửa từ project của lần chạy trước (bỏ qua nhận diện & dịch)."""
    proj_path = from_base(args.project_file) if args.project_file else store.PROJECTS_DIR / f"{Path(args.project).name}.json"
    proj = read_json(proj_path, None)
    if not proj:
        raise RuntimeError(f"Không tìm thấy project: {proj_path}")
    job_id = check_job_id(args.job_id, proj["job_id"], proj_path)
    # File project đời cũ còn chứa "segments" (server chuyển sang SQLite lúc khởi động; đây là đường dự phòng khi chạy tay).
    segments = load_segments(job_id) or sorted(proj.get("segments", []), key=lambda s: s["start"])
    log(f"[Xuất lại] Đọc {len(segments)} câu đã chỉnh sửa từ project {job_id}...")
    return Run(
        job_id=job_id, input_mp4=Path(proj["input_path"]), speed=float(proj.get("speed", args.speed)),
        voice=proj.get("voice") or args.voice, bg_volume=float(proj.get("bg_volume", 0.06)),
        burn_sub=bool(proj.get("burn_sub", True)), delogo=proj.get("delogo") or "none",
        subcover=proj.get("subcover") or "none", agy_model=proj.get("agy_model") or "",
        sub_style=clean_style(proj.get("sub_style")), story_project_id=proj.get("project_id", ""),
        multi_voice=bool(proj.get("multi_voice")), speakers=proj.get("speakers") or {}, segments=segments,
        rerender=True, proj=proj,
    )


def new_run(args: argparse.Namespace) -> Run:
    """Chạy mới / tiếp tục: tham số từ dòng lệnh; job_id suy từ tên file + tốc độ nếu server không cấp."""
    if not args.input:
        raise RuntimeError("Cần truyền --input <mp4> hoặc --project <job_id>")
    input_mp4 = Path(args.input).resolve()
    speed = max(0.25, min(1.5, args.speed))
    try:
        sub_style = clean_style(json.loads(args.sub_style)) if args.sub_style else None
    except json.JSONDecodeError:
        raise RuntimeError("--sub-style không phải JSON hợp lệ")
    stem = re.sub(r"[^0-9a-zA-Z_-]+", "_", input_mp4.stem)[:32].strip("_") or "video"
    if stem != input_mp4.stem:
        # Tên có chữ Trung / quá dài bị rút gọn: thêm mã băm để 2 video khác nhau không đè job của nhau.
        stem += "_" + hashlib.sha1(input_mp4.name.encode("utf-8")).hexdigest()[:6]
    job_id = f"dub_{stem}_{str(speed).replace('.', 'p')}x"
    if args.job_id:
        job_id = check_job_id(args.job_id, job_id)
    return Run(
        job_id=job_id, input_mp4=input_mp4, speed=speed, voice=args.voice, bg_volume=args.bg_volume,
        burn_sub=not args.no_sub, delogo=args.delogo, subcover=args.subcover, agy_model=args.agy_model,
        sub_style=sub_style, story_project_id=args.story_project or "", multi_voice=args.multi_voice,
        speakers={}, segments=[], rerender=False,
    )


def resolve_paths(args: argparse.Namespace, run: Run) -> Tuple[StorePaths, Path, Optional[Path]]:
    """Đường dẫn ghi kết quả: tham số server truyền > giá trị đã lưu trong project (xuất lại) > mặc định."""
    out = args.out_dir or run.proj.get("out_dir")
    sp = StorePaths(
        out_dir=from_base(out) if out else store.DUB_OUT_DIR,
        story_dir=from_base(args.story_dir) if args.story_dir else store.STORY_PROJECTS_DIR,
        index_json=from_base(args.index_file) if args.index_file else store.DUBBED_INDEX_JSON,
    )
    work = args.work_dir or run.proj.get("work_dir")
    work_dir = from_base(work) if work else None
    proj_path = from_base(args.project_file) if args.project_file else sp.projects_dir / f"{run.job_id}.json"
    if not run.rerender and args.job_id:
        check_job_id(run.job_id, read_json(proj_path, {}).get("job_id") or run.job_id, proj_path)
    for d in (sp.out_dir, proj_path.parent, sp.index_json.parent):
        d.mkdir(parents=True, exist_ok=True)
    return sp, proj_path, work_dir


def start_job(args: argparse.Namespace, run: Run, job: Job, duration: float, media: Dict, sig: List[int]) -> None:
    """Ghi trạng thái bắt đầu vào meta của job (chạy mới thì bỏ khối nhận diện/dịch cũ nếu tham số đã đổi)."""
    if run.rerender:
        # Xuất lại không đổi `status`: nếu lỗi/dừng, job vẫn là "done" và lời đã sửa trong project không bị
        # lượt "Tiếp tục" (dựng lại từ các khối nhận diện) ghi đè.
        job.work.mkdir(parents=True, exist_ok=True)
        job.save_meta(error="")
        return
    if not media["has_audio"]:
        raise RuntimeError("Video này không có luồng âm thanh!")
    stt_params = {"speed": run.speed, "model": args.model, "sig": sig, "chunk_min": args.chunk_min}
    old = job.meta
    if args.fresh or old.get("status") == "done" or old.get("stt_params") != stt_params:
        # Chạy mới: bỏ khối nhận diện/dịch cũ. Cache giọng đọc được giữ vì khóa theo nội dung câu.
        shutil.rmtree(job.chunks_dir, ignore_errors=True)
        job.meta = {}
    job.chunks_dir.mkdir(parents=True, exist_ok=True)
    job.save_meta(
        status="running", error="", input_path=str(run.input_mp4), title=run.input_mp4.name, duration=round(duration, 1),
        stt_params=stt_params,
        params={"speed": run.speed, "voice": run.voice, "model": args.model, "bg_volume": run.bg_volume,
                "burn_sub": run.burn_sub, "delogo": run.delogo, "subcover": run.subcover,
                "project_id": run.story_project_id, "multi_voice": run.multi_voice, "agy_model": run.agy_model,
                "sub_style": run.sub_style},
    )


def recognize_and_translate(args: argparse.Namespace, run: Run, job: Job, duration: float, story_ctx: Dict,
                            prog: Progress, tts: TTS, sp: StorePaths) -> Tuple[int, "Translator"]:
    """Nhận diện + dịch song song; điền run.segments. Trả về (số câu chưa dịch, translator)."""
    # Máy có GPU: câu đã dịch chỉ xếp hàng, đợi Nhận diện xong và xả VRAM (gpu_go) rồi mới nạp VieNeu chạy theo lô
    # (infer_batch) để không tranh VRAM 4 GB với Whisper — từ đó giọng đọc chạy song song với phần dịch còn lại.
    tts.gpu = tts_will_use_gpu()
    translator = Translator(
        job, story_ctx, run.story_project_id, args.translate_workers, prog, agy_model=run.agy_model,
        ask_who=run.multi_voice, story_dir=sp.story_dir,
        # Nhiều giọng cần nghe hết video mới phân vai nên không tạo giọng trước.
        on_chunk_done=None if run.multi_voice else lambda c: tts.prewarm([tts.item(s) for s in c["segments"]]),
    )
    chunks = run_stt(
        job, run.input_mp4, duration, run.speed, args.model, story_ctx, max(60.0, args.chunk_min * 60), prog,
        on_chunk=translator.submit_chunk,
    )
    tts.gpu_go()
    prog.stt = 1.0
    prog.set_stage("translate")
    translator.wait()
    translator.persist_memory(final=True)
    segments = run.segments
    for c in chunks:
        segments.extend(c["segments"])
    segments.sort(key=lambda s: s["start"])
    for i, s in enumerate(segments, start=1):
        s["id"] = i
    if not segments:
        raise RuntimeError(
            "Không nhận diện được câu thoại tiếng Trung nào — video này có vẻ chỉ có nhạc / tiếng động nên không có gì để lồng tiếng."
        )
    untranslated = sum(1 for s in segments if s.get("zh") and not s.get("vi"))
    if segments and untranslated > len(segments) * 0.2:
        raise RuntimeError(
            f"Còn {untranslated}/{len(segments)} câu chưa dịch được (Antigravity lỗi). "
            "Kết quả đã lưu — bấm Tiếp tục để dịch nốt phần còn thiếu."
        )
    log(f"[Dịch] Hoàn tất {len(segments) - untranslated}/{len(segments)} câu thoại.")
    return untranslated, translator


def assign_voices(run: Run, translator: "Translator", story_ctx: Dict, prog: Progress, tts: TTS, sp: StorePaths) -> None:
    """Nhiều giọng: phân biệt người nói, ghép với nhân vật trong truyện, mỗi nhân vật đúng 1 giọng. Lỗi thì về 1 giọng."""
    segments = run.segments
    try:
        prog.set_stage("tts")
        log("[Nhân vật] Đang phân biệt người nói theo giọng gốc...")
        n = diarize(run.input_mp4, segments, prog)
        # Phân vai: nhóm giọng nào là nhân vật nào trong truyện; nhân vật đã cấu hình giọng thì dùng đúng giọng đó.
        cast = match_characters(segments, translator.chars, {c.get("zh", "").strip() for c in story_ctx.get("characters") or []})
        speakers = auto_voice_map(segments, run.voice, story_ctx.get("voices"), {k: c["voice"] for k, c in cast.items() if c["voice"]})
        # Máy hay tách 1 người thành 2 nhóm giọng (giọng thường / giọng hét): cùng 1 nhân vật thì dùng chung 1 giọng,
        # lấy theo nhóm nói nhiều nhất (speakers đã xếp theo thời lượng giảm dần).
        char_voice: Dict[str, str] = {}
        for k in speakers:
            if k in cast:
                c = cast[k]
                speakers[k].update(zh=c["zh"], name=c["name"], is_new=c["is_new"])
                speakers[k]["voice"] = char_voice.setdefault(c["zh"], speakers[k]["voice"])
        save_character_voices(run.story_project_id,
                              {c["zh"]: speakers[k]["voice"] for k, c in cast.items() if not c["voice"] and c["zh"] != NARRATOR_ZH},
                              sp.story_dir)
        tts.voice_map = {k: v["voice"] for k, v in speakers.items()}
        for k, v in speakers.items():
            who = f" = {v['name']}{' (NHÂN VẬT MỚI)' if v.get('is_new') else ''}" if v.get("name") else " (chưa rõ là ai)"
            log(f"[Nhân vật] {k}{who}: {v['lines']} câu, ~{v['f0']} Hz ({'nữ/trẻ' if v['gender'] == 'female' else 'nam'}) → {v['voice']}")
        log(f"[Nhân vật] Tìm thấy {n} nhân vật. Đổi giọng từng nhân vật trong 'Sửa lời' rồi xuất lại nếu cần.")
        run.speakers = speakers
    except Exception as e:  # thiếu VieNeu / lỗi đọc audio: vẫn lồng tiếng được bằng 1 giọng
        log(f"[Nhân vật] ⚠ Không phân biệt được nhân vật ({e}) — dùng 1 giọng cho cả video.")
        run.multi_voice, run.speakers = False, {}
    for s in segments:
        s.pop("_f0", None)
        s.pop("who", None)


def write_project(run: Run, job: Job, proj_path: Path, duration: float, media: Dict, sp: StorePaths) -> None:
    """Lưu file project (tham số để xuất lại) + câu thoại vào SQLite — trước bước giọng đọc để web sửa lời được ngay."""
    write_json_atomic(
        proj_path,
        {
            "job_id": run.job_id,
            "project_id": run.story_project_id,
            "title": run.input_mp4.name,
            "input_path": str(run.input_mp4),
            "speed": run.speed,
            "voice": run.voice,
            "bg_volume": run.bg_volume,
            "burn_sub": run.burn_sub,
            "delogo": run.delogo,
            "subcover": run.subcover,
            "agy_model": run.agy_model,
            "sub_style": run.sub_style,
            "multi_voice": run.multi_voice,
            "speakers": run.speakers,
            "orig_duration_sec": round(duration, 1),
            "dub_duration_sec": round(duration, 1),
            "resolution": f"{media['w']}x{media['h']}",
            "out_dir": rel_to_base(sp.out_dir),
            "work_dir": rel_to_base(job.work),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    save_segments(run.job_id, run.segments)


def make_voices(run: Run, tts: TTS, only: str, prog: Progress) -> None:
    """Tạo giọng đọc cho mọi câu (cache theo nội dung câu), rồi xả mô hình TTS khỏi VRAM."""
    if only == "video":
        VieNeuEngine.unload()
        return
    prog.set_stage("tts")
    log(f"[Giọng đọc] Tạo giọng tiếng Việt ({run.voice}) cho {len(run.segments)} câu (câu đã có trong cache được dùng lại)...")
    try:
        tts.ensure_all([tts.item(s) for s in run.segments])
    finally:
        # Xả sạch mô hình TTS + CUDA graphs khỏi VRAM trước khi bước Xuất video dùng NVENC.
        VieNeuEngine.unload()
    if tts.failed:
        log(f"[Giọng đọc] ⚠ {tts.failed} câu không tạo được âm thanh (sẽ im lặng ở các câu đó).")


def render_and_mux(args: argparse.Namespace, run: Run, job: Job, tts: TTS, prog: Progress, only: str, out_mp4: Path,
                   duration: float, media: Dict, sig: List[int], delogo_vf: str, cover_vf: str, encode: bool) -> None:
    """Dựng track tiếng ở luồng nền trong lúc luồng chính mã hóa hình, rồi ghép thành out_mp4."""
    audio_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio")
    if only == "video":
        mix_keep = job.work / "mix.m4a"

        def reuse_audio() -> Path:
            run_ffmpeg(["-i", str(out_mp4), "-vn", "-map", "0:a:0", "-c:a", "copy", "-f", "mp4", str(mix_keep)],
                       duration, lambda f: None, job.work / "mix_err.log")
            return mix_keep

        audio_future = audio_pool.submit(reuse_audio)
    else:
        audio_future = audio_pool.submit(
            build_audio, job, run.input_mp4, run.segments, tts, duration, run.bg_volume, media["has_audio"], prog
        )
    concat_list = None
    prog.set_stage("render")
    if only == "audio":
        concat_list = job.work / "parts.txt"
        concat_list.write_text(f"file '{out_mp4}'\n", encoding="utf-8")
    elif encode:
        what = " + ".join(x for x in ["in phụ đề" if run.burn_sub else "", "xóa logo" if delogo_vf else "",
                                      "che phụ đề gốc" if cover_vf else ""] if x)
        log(f"[Xuất video] Mã hóa lại theo từng phần {int(PART_SEC // 60)} phút ({what})...")
        concat_list = render_parts(
            job, run.input_mp4, run.segments, duration, run.burn_sub, delogo_vf, sig, prog, cover_vf, run.subcover,
            run.sub_style, (media["w"], media["h"]), encoder=args.encoder,
        )
    prog.render = 1.0
    prog.note = ""
    mix = audio_future.result()
    audio_pool.shutdown()
    prog.audio = 1.0
    prog.set_stage("mux")
    log("[Xuất video] Ghép hình và tiếng lồng (tốc độ gốc 1.0x)...")
    mux_final(job, run.input_mp4, concat_list, mix, out_mp4, duration, prog)
    tts.pool.shutdown()


def index_entry(run: Run, job: Job, untranslated: int, duration: float, media: Dict, out_mp4: Path, out_srt: Path,
                size_mb: float, sp: StorePaths) -> Dict:
    """Dòng của bản lồng tiếng này trong danh sách bản lồng tiếng (data/dubbed.json)."""
    return {
        "job_id": run.job_id,
        "project_id": run.story_project_id,
        "title": run.input_mp4.name,
        "speed": run.speed,
        "voice": run.voice,
        "multi_voice": run.multi_voice,
        "speaker_count": len(run.speakers),
        "bg_volume": run.bg_volume,
        "burn_sub": run.burn_sub,
        "delogo": run.delogo,
        "subcover": run.subcover,
        "agy_model": run.agy_model,
        "sub_style": run.sub_style,
        "segment_count": len(run.segments),
        "untranslated": untranslated,
        "duration_sec": round(duration),
        "resolution": f"{media['w']}x{media['h']}",
        "size_mb": size_mb,
        "cache_mb": dir_size_mb(job.work),
        "mp4_file": out_mp4.name,
        "srt_file": out_srt.name,
        "out_dir": rel_to_base(sp.out_dir),
        "work_dir": rel_to_base(job.work),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }


def main() -> int:
    global JOB, RERENDER
    args = parse_args()
    os.nice(8)  # chạy nền nhiều giờ: nhường CPU cho máy; ffmpeg/agy con được thừa hưởng

    RERENDER = bool(args.project)
    run = load_rerender(args) if RERENDER else new_run(args)
    if not run.input_mp4.exists():
        raise RuntimeError(f"Không tìm thấy video đầu vào: {run.input_mp4}")
    sp, proj_path, work_dir = resolve_paths(args, run)

    job = JOB = Job(run.job_id, work_dir)
    for leftover in job.work.rglob("*.tmp.*"):  # file ghi dở của lần chạy bị ngắt
        leftover.unlink(missing_ok=True)
    st = run.input_mp4.stat()
    sig = [st.st_size, int(st.st_mtime)]
    media = probe_media(run.input_mp4)
    duration = media["duration"]
    if duration <= 0:
        raise RuntimeError("Không đọc được thời lượng video (file hỏng hoặc tải chưa xong).")
    delogo_vf = build_delogo_filter(run.delogo, media["w"], media["h"])
    cover_vf = build_subcover_filter(run.subcover, media["w"], media["h"])
    encode = run.burn_sub or bool(delogo_vf) or bool(cover_vf)
    start_job(args, run, job, duration, media, sig)

    in_gb = st.st_size / 1024**3
    assert_disk_space(sp.out_dir, in_gb * ((1.2 if run.rerender else 2.2) if encode else 1.15) + 0.5)

    story_ctx = load_story_context(run.story_project_id, sp.story_dir)
    if story_ctx:
        log(f"[Dự án] Đã nạp ngữ cảnh: {story_ctx.get('name')} ({len(story_ctx.get('characters', []))} nhân vật, {len(story_ctx.get('glossary', []))} từ điển)")
    log(f"[Video] {run.input_mp4.name} | {fmt_clock(duration)} | {media['w']}x{media['h']} | {in_gb:.2f} GB")

    prog = Progress(job, duration, encode)
    tts = TTS(job.tts_dir, run.voice, args.tts_workers, prog)
    tts.voice_map = {k: v["voice"] for k, v in run.speakers.items()}
    out_mp4 = sp.out_dir / f"{run.job_id}.mp4"
    out_srt = sp.out_dir / f"{run.job_id}.srt"
    untranslated = 0
    # Xuất lại một nửa: lấy nửa còn lại từ bản đã xuất (copy, không mã hóa) — cần bản đã xuất còn nguyên.
    only = args.only if run.rerender and out_mp4.exists() else ""
    if args.only and not only:
        log("[Xuất lại] Không có bản đã xuất để tái sử dụng — chạy lại đầy đủ.")
    if only:
        log(f"[Xuất lại] Chỉ làm lại {'phần HÌNH' if only == 'video' else 'phần TIẾNG'}; {'tiếng' if only == 'video' else 'hình'} lấy lại từ bản đã xuất.")

    if not run.rerender:
        untranslated, translator = recognize_and_translate(args, run, job, duration, story_ctx, prog, tts, sp)
        if run.multi_voice:
            assign_voices(run, translator, story_ctx, prog, tts, sp)
    else:
        prog.stt = 1.0

    out_srt.write_text(build_srt(run.segments), encoding="utf-8")
    write_project(run, job, proj_path, duration, media, sp)
    make_voices(run, tts, only, prog)
    render_and_mux(args, run, job, tts, prog, only, out_mp4, duration, media, sig, delogo_vf, cover_vf, encode)

    size_mb = round(out_mp4.stat().st_size / (1024 * 1024), 2)
    update_dubbed_index(index_entry(run, job, untranslated, duration, media, out_mp4, out_srt, size_mb, sp), sp.index_json)
    prog.mux = 1.0
    prog.emit(force=True)
    job.save_meta(status="done", pct=100, label="Hoàn tất", error="")
    if untranslated:
        log(f"[Lưu ý] {untranslated} câu chưa có lời dịch — mở 'Sửa lời' để bổ sung rồi xuất lại.")
    log(f"[HOÀN TẤT] Đã xuất bản lồng tiếng: {out_mp4.name} ({size_mb} MB | {len(run.segments)} câu thoại)")
    return 0


def _stop_children() -> None:
    for proc in list(CHILDREN):
        try:
            proc.kill()
        except OSError:
            pass


def _raise_interrupt(*_):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _raise_interrupt)
    code = 1
    try:
        code = main()
    except KeyboardInterrupt:
        log("[Đã dừng] Tiến độ đã được lưu — bấm Tiếp tục để chạy tiếp từ chỗ đang dở.")
        if JOB and not RERENDER:
            JOB.save_meta(status="stopped")
        code = 130
    except Exception as exc:
        log(f"[Lỗi] {exc}")
        if JOB:
            JOB.save_meta(error=str(exc)[:500], **({} if RERENDER else {"status": "error"}))
    _stop_children()
    sys.stdout.flush()
    os._exit(code)  # không chờ các luồng nền (dịch/TTS) đang dở khi dừng hoặc lỗi
