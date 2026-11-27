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
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

if __package__ in (None, ""):  # chạy bằng đường dẫn file (server: python pipeline/<script>.py) → import gói từ gốc repo
    sys.path[0] = str(Path(__file__).resolve().parent.parent)

from pipeline.common import CHILDREN, NARRATOR_ZH, assert_disk_space, dir_size_mb, fmt_clock, from_base, log, probe_media, read_json, rel_to_base, run_ffmpeg, write_json_atomic
from pipeline import store
from pipeline.job import Job, Progress
from pipeline.mix import build_audio
from pipeline.render import PART_SEC, build_delogo_filter, build_srt, mux_final, render_parts
from pipeline.speakers import auto_voice_map, diarize, match_characters, save_character_voices
from pipeline.store import check_job_id, load_segments, load_story_context, save_segments, update_dubbed_index
from pipeline.stt import run_stt
from pipeline.subtitles import build_subcover_filter, clean_style
from pipeline.translate import Translator
from pipeline.tts import TTS, VieNeuEngine, tts_will_use_gpu

JOB: Optional["Job"] = None

RERENDER = False


def main() -> int:
    global JOB, RERENDER
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
    args = parser.parse_args()
    if args.index_file:
        store.DUBBED_INDEX_JSON = from_base(args.index_file)
    if args.story_dir:
        store.STORY_PROJECTS_DIR = from_base(args.story_dir)

    os.nice(8)  # chạy nền nhiều giờ: nhường CPU cho máy; ffmpeg/agy con được thừa hưởng

    rerender = RERENDER = bool(args.project)
    proj: Dict = {}
    if rerender:
        proj_path = from_base(args.project_file) if args.project_file else store.PROJECTS_DIR / f"{Path(args.project).name}.json"
        proj = read_json(proj_path, None)
        if not proj:
            raise RuntimeError(f"Không tìm thấy project: {proj_path}")
        job_id = check_job_id(args.job_id, proj["job_id"], proj_path)
        input_mp4 = Path(proj["input_path"])
        speed = float(proj.get("speed", args.speed))
        voice = proj.get("voice") or args.voice
        bg_volume = float(proj.get("bg_volume", 0.06))
        burn_sub = bool(proj.get("burn_sub", True))
        delogo = proj.get("delogo") or "none"
        subcover = proj.get("subcover") or "none"
        agy_model = proj.get("agy_model") or ""
        sub_style = clean_style(proj.get("sub_style"))
        story_project_id = proj.get("project_id", "")
        multi_voice = bool(proj.get("multi_voice"))
        speakers = proj.get("speakers") or {}
        # File project đời cũ còn chứa "segments" (server chuyển sang SQLite lúc khởi động; đây là đường dự phòng khi chạy tay).
        segments = load_segments(job_id) or sorted(proj.get("segments", []), key=lambda s: s["start"])
        log(f"[Xuất lại] Đọc {len(segments)} câu đã chỉnh sửa từ project {job_id}...")
    else:
        if not args.input:
            raise RuntimeError("Cần truyền --input <mp4> hoặc --project <job_id>")
        input_mp4 = Path(args.input).resolve()
        speed = max(0.25, min(1.5, args.speed))
        voice, bg_volume, burn_sub, delogo = args.voice, args.bg_volume, not args.no_sub, args.delogo
        subcover = args.subcover
        agy_model = args.agy_model
        try:
            sub_style = clean_style(json.loads(args.sub_style)) if args.sub_style else None
        except json.JSONDecodeError:
            raise RuntimeError("--sub-style không phải JSON hợp lệ")
        story_project_id = args.story_project or ""
        multi_voice = args.multi_voice
        speakers = {}
        stem = re.sub(r"[^0-9a-zA-Z_-]+", "_", input_mp4.stem)[:32].strip("_") or "video"
        if stem != input_mp4.stem:
            # Tên có chữ Trung / quá dài bị rút gọn: thêm mã băm để 2 video khác nhau không đè job của nhau.
            stem += "_" + hashlib.sha1(input_mp4.name.encode("utf-8")).hexdigest()[:6]
        job_id = f"dub_{stem}_{str(speed).replace('.', 'p')}x"
        if args.job_id:
            job_id = check_job_id(args.job_id, job_id)
        segments = []
    if not input_mp4.exists():
        raise RuntimeError(f"Không tìm thấy video đầu vào: {input_mp4}")

    if args.out_dir or proj.get("out_dir"):
        store.DUB_OUT_DIR = from_base(args.out_dir or proj["out_dir"])
    work_dir = from_base(args.work_dir or proj["work_dir"]) if (args.work_dir or proj.get("work_dir")) else None
    proj_path = from_base(args.project_file) if args.project_file else store.PROJECTS_DIR / f"{job_id}.json"
    if not rerender and args.job_id:
        check_job_id(job_id, read_json(proj_path, {}).get("job_id") or job_id, proj_path)
    for d in (store.DUB_OUT_DIR, proj_path.parent, store.DUBBED_INDEX_JSON.parent):
        d.mkdir(parents=True, exist_ok=True)

    job = JOB = Job(job_id, work_dir)
    for leftover in job.work.rglob("*.tmp.*"):  # file ghi dở của lần chạy bị ngắt
        leftover.unlink(missing_ok=True)
    st = input_mp4.stat()
    sig = [st.st_size, int(st.st_mtime)]
    media = probe_media(input_mp4)
    duration = media["duration"]
    if duration <= 0:
        raise RuntimeError("Không đọc được thời lượng video (file hỏng hoặc tải chưa xong).")
    delogo_vf = build_delogo_filter(delogo, media["w"], media["h"])
    cover_vf = build_subcover_filter(subcover, media["w"], media["h"])
    encode = burn_sub or bool(delogo_vf) or bool(cover_vf)

    if not rerender:
        if not media["has_audio"]:
            raise RuntimeError("Video này không có luồng âm thanh!")
        stt_params = {"speed": speed, "model": args.model, "sig": sig, "chunk_min": args.chunk_min}
        old = job.meta
        if args.fresh or old.get("status") == "done" or old.get("stt_params") != stt_params:
            # Chạy mới: bỏ khối nhận diện/dịch cũ. Cache giọng đọc được giữ vì khóa theo nội dung câu.
            shutil.rmtree(job.chunks_dir, ignore_errors=True)
            job.meta = {}
        job.chunks_dir.mkdir(parents=True, exist_ok=True)
        job.save_meta(
            status="running", error="", input_path=str(input_mp4), title=input_mp4.name, duration=round(duration, 1),
            stt_params=stt_params,
            params={"speed": speed, "voice": voice, "model": args.model, "bg_volume": bg_volume, "burn_sub": burn_sub,
                    "delogo": delogo, "subcover": subcover, "project_id": story_project_id,
                    "multi_voice": multi_voice, "agy_model": agy_model, "sub_style": sub_style},
        )
    else:
        # Xuất lại không đổi `status`: nếu lỗi/dừng, job vẫn là "done" và lời đã sửa trong project không bị
        # lượt "Tiếp tục" (dựng lại từ các khối nhận diện) ghi đè.
        job.work.mkdir(parents=True, exist_ok=True)
        job.save_meta(error="")

    in_gb = st.st_size / 1024**3
    assert_disk_space(store.DUB_OUT_DIR, in_gb * ((1.2 if rerender else 2.2) if encode else 1.15) + 0.5)

    story_ctx = load_story_context(story_project_id)
    if story_ctx:
        log(f"[Dự án] Đã nạp ngữ cảnh: {story_ctx.get('name')} ({len(story_ctx.get('characters', []))} nhân vật, {len(story_ctx.get('glossary', []))} từ điển)")
    log(f"[Video] {input_mp4.name} | {fmt_clock(duration)} | {media['w']}x{media['h']} | {in_gb:.2f} GB")

    prog = Progress(job, duration, encode)
    tts = TTS(job.tts_dir, voice, args.tts_workers, prog)
    tts.voice_map = {k: v["voice"] for k, v in speakers.items()}
    out_mp4 = store.DUB_OUT_DIR / f"{job_id}.mp4"
    out_srt = store.DUB_OUT_DIR / f"{job_id}.srt"
    untranslated = 0
    # Xuất lại một nửa: lấy nửa còn lại từ bản đã xuất (copy, không mã hóa) — cần bản đã xuất còn nguyên.
    only = args.only if rerender and out_mp4.exists() else ""
    if args.only and not only:
        log("[Xuất lại] Không có bản đã xuất để tái sử dụng — chạy lại đầy đủ.")
    if only:
        log(f"[Xuất lại] Chỉ làm lại {'phần HÌNH' if only == 'video' else 'phần TIẾNG'}; {'tiếng' if only == 'video' else 'hình'} lấy lại từ bản đã xuất.")

    if not rerender:
        # Máy có GPU: câu đã dịch chỉ xếp hàng, đợi Nhận diện xong và xả VRAM (gpu_go) rồi mới nạp VieNeu chạy theo lô
        # (infer_batch) để không tranh VRAM 4 GB với Whisper — từ đó giọng đọc chạy song song với phần dịch còn lại.
        tts.gpu = tts_will_use_gpu()
        translator = Translator(
            job, story_ctx, story_project_id, args.translate_workers, prog, agy_model=agy_model, ask_who=multi_voice,
            # Nhiều giọng cần nghe hết video mới phân vai nên không tạo giọng trước.
            on_chunk_done=None if multi_voice else lambda c: tts.prewarm([tts.item(s) for s in c["segments"]]),
        )
        chunks = run_stt(
            job, input_mp4, duration, speed, args.model, story_ctx, max(60.0, args.chunk_min * 60), prog,
            on_chunk=translator.submit_chunk,
        )
        tts.gpu_go()
        prog.stt = 1.0
        prog.set_stage("translate")
        translator.wait()
        translator.persist_memory(final=True)
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
        if multi_voice:
            try:
                prog.set_stage("tts")
                log("[Nhân vật] Đang phân biệt người nói theo giọng gốc...")
                n = diarize(input_mp4, segments, prog)
                # Phân vai: nhóm giọng nào là nhân vật nào trong truyện; nhân vật đã cấu hình giọng thì dùng đúng giọng đó.
                cast = match_characters(segments, translator.chars, {c.get("zh", "").strip() for c in story_ctx.get("characters") or []})
                speakers = auto_voice_map(segments, voice, story_ctx.get("voices"), {k: c["voice"] for k, c in cast.items() if c["voice"]})
                # Máy hay tách 1 người thành 2 nhóm giọng (giọng thường / giọng hét): cùng 1 nhân vật thì dùng chung 1 giọng,
                # lấy theo nhóm nói nhiều nhất (speakers đã xếp theo thời lượng giảm dần).
                char_voice: Dict[str, str] = {}
                for k in speakers:
                    if k in cast:
                        c = cast[k]
                        speakers[k].update(zh=c["zh"], name=c["name"], is_new=c["is_new"])
                        speakers[k]["voice"] = char_voice.setdefault(c["zh"], speakers[k]["voice"])
                save_character_voices(story_project_id, {c["zh"]: speakers[k]["voice"] for k, c in cast.items() if not c["voice"] and c["zh"] != NARRATOR_ZH})
                tts.voice_map = {k: v["voice"] for k, v in speakers.items()}
                for k, v in speakers.items():
                    who = f" = {v['name']}{' (NHÂN VẬT MỚI)' if v.get('is_new') else ''}" if v.get("name") else " (chưa rõ là ai)"
                    log(f"[Nhân vật] {k}{who}: {v['lines']} câu, ~{v['f0']} Hz ({'nữ/trẻ' if v['gender'] == 'female' else 'nam'}) → {v['voice']}")
                log(f"[Nhân vật] Tìm thấy {n} nhân vật. Đổi giọng từng nhân vật trong 'Sửa lời' rồi xuất lại nếu cần.")
            except Exception as e:  # thiếu VieNeu / lỗi đọc audio: vẫn lồng tiếng được bằng 1 giọng
                log(f"[Nhân vật] ⚠ Không phân biệt được nhân vật ({e}) — dùng 1 giọng cho cả video.")
                multi_voice, speakers = False, {}
            for s in segments:
                s.pop("_f0", None)
                s.pop("who", None)
    else:
        prog.stt = 1.0

    out_srt.write_text(build_srt(segments), encoding="utf-8")
    write_json_atomic(
        proj_path,
        {
            "job_id": job_id,
            "project_id": story_project_id,
            "title": input_mp4.name,
            "input_path": str(input_mp4),
            "speed": speed,
            "voice": voice,
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "subcover": subcover,
            "agy_model": agy_model,
            "sub_style": sub_style,
            "multi_voice": multi_voice,
            "speakers": speakers,
            "orig_duration_sec": round(duration, 1),
            "dub_duration_sec": round(duration, 1),
            "resolution": f"{media['w']}x{media['h']}",
            "out_dir": rel_to_base(store.DUB_OUT_DIR),
            "work_dir": rel_to_base(job.work),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    save_segments(job_id, segments)

    if only != "video":
        prog.set_stage("tts")
        log(f"[Giọng đọc] Tạo giọng tiếng Việt ({voice}) cho {len(segments)} câu (câu đã có trong cache được dùng lại)...")
        try:
            tts.ensure_all([tts.item(s) for s in segments])
        finally:
            # Xả sạch mô hình TTS + CUDA graphs khỏi VRAM trước khi bước Xuất video dùng NVENC.
            VieNeuEngine.unload()
        if tts.failed:
            log(f"[Giọng đọc] ⚠ {tts.failed} câu không tạo được âm thanh (sẽ im lặng ở các câu đó).")
    else:
        VieNeuEngine.unload()

    # Track tiếng được dựng + trộn ở luồng nền trong lúc luồng chính mã hóa video.
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
            build_audio, job, input_mp4, segments, tts, duration, bg_volume, media["has_audio"], prog
        )
    concat_list = None
    prog.set_stage("render")
    if only == "audio":
        concat_list = job.work / "parts.txt"
        concat_list.write_text(f"file '{out_mp4}'\n", encoding="utf-8")
    elif encode:
        what = " + ".join(x for x in ["in phụ đề" if burn_sub else "", "xóa logo" if delogo_vf else "",
                                      "che phụ đề gốc" if cover_vf else ""] if x)
        log(f"[Xuất video] Mã hóa lại theo từng phần {int(PART_SEC // 60)} phút ({what})...")
        concat_list = render_parts(
            job, input_mp4, segments, duration, burn_sub, delogo_vf, sig, prog, cover_vf, subcover, sub_style,
            (media["w"], media["h"]), encoder=args.encoder,
        )
    prog.render = 1.0
    prog.note = ""
    mix = audio_future.result()
    audio_pool.shutdown()
    prog.audio = 1.0
    prog.set_stage("mux")
    log("[Xuất video] Ghép hình và tiếng lồng (tốc độ gốc 1.0x)...")
    mux_final(job, input_mp4, concat_list, mix, out_mp4, duration, prog)
    tts.pool.shutdown()

    size_mb = round(out_mp4.stat().st_size / (1024 * 1024), 2)
    update_dubbed_index(
        {
            "job_id": job_id,
            "project_id": story_project_id,
            "title": input_mp4.name,
            "speed": speed,
            "voice": voice,
            "multi_voice": multi_voice,
            "speaker_count": len(speakers),
            "bg_volume": bg_volume,
            "burn_sub": burn_sub,
            "delogo": delogo,
            "subcover": subcover,
            "agy_model": agy_model,
            "sub_style": sub_style,
            "segment_count": len(segments),
            "untranslated": untranslated,
            "duration_sec": round(duration),
            "resolution": f"{media['w']}x{media['h']}",
            "size_mb": size_mb,
            "cache_mb": dir_size_mb(job.work),
            "mp4_file": out_mp4.name,
            "srt_file": out_srt.name,
            "out_dir": rel_to_base(store.DUB_OUT_DIR),
            "work_dir": rel_to_base(job.work),
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
    )
    prog.mux = 1.0
    prog.emit(force=True)
    job.save_meta(status="done", pct=100, label="Hoàn tất", error="")
    if untranslated:
        log(f"[Lưu ý] {untranslated} câu chưa có lời dịch — mở 'Sửa lời' để bổ sung rồi xuất lại.")
    log(f"[HOÀN TẤT] Đã xuất bản lồng tiếng: {out_mp4.name} ({size_mb} MB | {len(segments)} câu thoại)")
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
