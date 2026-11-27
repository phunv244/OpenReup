"""Bước 2: dịch theo ngữ cảnh dự án bằng engine agy (Antigravity) — chạy nền, có retry + checkpoint."""
import json
import math
import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from pipeline.common import NARRATOR_ZH, log, read_json, write_json_atomic
from pipeline.job import Job, Progress
from pipeline.store import STORY_PROJECTS_DIR, story_project_path

AGY_BIN = shutil.which("agy") or str(Path.home() / ".local" / "bin" / "agy")

TRANSLATE_BATCH = 45

AGY_TRANSLATION_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "vi": {"type": "string"},
                    "who": {"type": "string"},
                },
                "required": ["id", "vi"],
            },
        },
        "episode_summary": {"type": "string"},
        "new_characters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "zh": {"type": "string"},
                    "vi": {"type": "string"},
                    "role": {"type": "string"},
                    "pronouns": {"type": "string"},
                    "personality": {"type": "string"},
                },
                "required": ["zh", "vi"],
            },
        },
        "character_notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"zh": {"type": "string"}, "personality": {"type": "string"}},
                "required": ["zh", "personality"],
            },
        },
        "new_glossary": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "zh": {"type": "string"},
                    "vi": {"type": "string"},
                },
                "required": ["zh", "vi"],
            },
        },
    },
    "required": ["translations", "episode_summary", "new_characters", "new_glossary"],
}


def _extract_json_object(text: str) -> Dict:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*\n?", "", raw)
        raw = re.sub(r"\n?\s*```$", "", raw).strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(raw[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise RuntimeError(f"Không đọc được JSON từ phản hồi model dịch: {raw[:200]}")


# ----------------------------------------------------------------------------
# Bước 3: Dịch theo ngữ cảnh dự án bằng Antigravity (chạy nền, có retry + checkpoint)
# ----------------------------------------------------------------------------
class Translator:
    MAX_CHARS, MAX_GLOSS = 200, 600

    def __init__(self, job: Job, story_ctx: Dict, project_id: str, workers: int, prog: Progress, on_chunk_done, agy_model: str = "",
                 ask_who: bool = False, story_dir: Path = STORY_PROJECTS_DIR):
        self.job = job
        self.ask_who = ask_who  # chỉ hỏi AI "ai nói câu này" khi lồng tiếng nhiều giọng (bước phân vai cần)
        self.agy_model = agy_model  # "" = model mặc định của Antigravity (id đã gồm mức suy nghĩ, vd gemini-4-neon-high)
        self.ctx = story_ctx or {}
        self.project_id = project_id
        self.story_dir = story_dir
        self.prog = prog
        self.on_chunk_done = on_chunk_done or (lambda chunk: None)
        self.pool = ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="translate")
        self.lock = threading.Lock()
        self.chars: List[Dict] = list(self.ctx.get("characters") or [])
        self.gloss: List[Dict] = list(self.ctx.get("glossary") or [])
        self.new_chars: List[Dict] = []
        self.new_gloss: List[Dict] = []
        self.new_notes: Dict[str, str] = {}  # {tên gốc: tính cách} AI vừa rút ra, chờ ghi vào dự án
        self.summaries: List[str] = list(job.meta.get("summaries") or [])
        self.fail_streak = 0
        self.failed_segs = 0
        self.fatal: Optional[str] = None
        self.futures: List = []
        self.memory_lock = threading.Lock()
        self.verbose = prog.duration <= 900

    # --- ngữ cảnh gửi kèm mỗi lô: chỉ lấy phần liên quan để prompt không phình theo độ dài video
    def _context_block(self, batch_text: str) -> str:
        with self.lock:
            chars = self.chars if len(self.chars) <= 40 else (
                self.chars[:20] + [c for c in self.chars[20:] if c.get("zh") and c["zh"] in batch_text]
            )
            gloss = self.gloss if len(self.gloss) <= 40 else [g for g in self.gloss if g.get("zh") and g["zh"] in batch_text][:60]
            recent = self.summaries[-3:]
        chars_txt = "\n".join(
            f"- {c.get('zh')} -> {c.get('vi')} ({c.get('role', '')}; xưng hô: {c.get('pronouns', '')}"
            + (f"; tính cách: {c['personality']}" if c.get("personality") else "") + ")" for c in chars
        )
        gloss_txt = "\n".join(f"- {g.get('zh')} -> {g.get('vi')}" for g in gloss)
        ep_notes = self.ctx.get("episode_notes") or {}
        prev_eps = "\n".join(f"- {k}: {str(v)[:300]}" for k, v in list(ep_notes.items())[-5:] if k != self.job.job_id)
        head = (
            f"Tên dự án: {self.ctx.get('name', '')} ({self.ctx.get('type', '')})\n"
            f"Phong cách dịch: {self.ctx.get('style', '')}\n"
            f"Cốt truyện chung: {self.ctx.get('synopsis', '')}\n"
            if self.ctx
            else "Không có dự án cụ thể (hãy tự suy luận bối cảnh từ lời thoại).\n"
        )
        return (
            f"{head}"
            f"Nhân vật & Xưng hô:\n{chars_txt or '(chưa có)'}\n"
            f"Từ điển thuật ngữ:\n{gloss_txt or '(chưa có)'}\n"
            f"Tóm tắt các tập trước:\n{prev_eps or '(chưa có)'}\n"
            f"Diễn biến ngay trước đoạn này trong video:\n{' '.join(recent) or '(đây là đoạn đầu)'}"
        )

    def _call_agy(self, prompt: str) -> Dict:
        proc = subprocess.run(
            [
                AGY_BIN,
                "--disable-slash-commands",
                # Model chọn tay: id đã chứa mức suy nghĩ. Chưa chọn thì giữ cách cũ: model mặc định, suy nghĩ thấp (nhanh).
                *(["--model", self.agy_model] if self.agy_model else ["--effort", "low"]),
                "--output-format",
                "json",
                "--json-schema",
                json.dumps(AGY_TRANSLATION_SCHEMA, ensure_ascii=False),
                "-p",
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Antigravity CLI lỗi (code {proc.returncode}): {(proc.stderr or proc.stdout)[-300:]}")
        wrapper = json.loads(proc.stdout.strip())
        ai_out = wrapper.get("structured_output") or json.loads(wrapper.get("response") or "{}")
        if not isinstance(ai_out, dict) or not ai_out.get("translations"):
            raise RuntimeError("Antigravity trả về kết quả rỗng")
        return ai_out

    def _translate_batch(self, batch: List[Dict], prev_lines: List[str]) -> None:
        payload = json.dumps(
            [{"id": i + 1, "start": s["start"], "end": s["end"], "zh": s["zh"]} for i, s in enumerate(batch)],
            ensure_ascii=False,
        )
        prev_txt = ("\n".join(prev_lines) + "\n\n") if prev_lines else ""
        prompt = (
            "Bạn là biên dịch viên lồng tiếng phim/hoạt hình chuyên nghiệp. "
            "KHÔNG sử dụng bất kỳ tool nào, chỉ trả về đúng JSON theo schema.\n\n"
            f"=== NGỮ CẢNH DỰ ÁN ===\n{self._context_block(payload)}\n\n"
            "=== NHIỆM VỤ ===\n"
            "1. Đọc kỹ các câu thoại tiếng Trung do Whisper tách bên dưới (có thể bị nghe nhầm đồng âm, "
            "ví dụ 楚依旧->除意就, 老骨头->脑骨头, 出发->扶发, 去钓->去掉). Hãy tự sửa lỗi nghe nhầm dựa vào ngữ cảnh!\n"
            "2. Dịch sang tiếng Việt thật tự nhiên, ngắn gọn, súc tích để đọc lồng tiếng khớp tốc độ gốc 1.0x, đúng xưng hô.\n"
            "3. Trả về đúng đủ số lượng 'id' trong mảng 'translations'.\n"
            "4. Viết 'episode_summary' (1-2 câu tóm tắt diễn biến đoạn này để giữ mạch truyện).\n"
            "5. Nếu có nhân vật mới hoặc thuật ngữ mới quan trọng chưa có trong ngữ cảnh trên, điền vào "
            "'new_characters' / 'new_glossary' (nếu không có thì để mảng rỗng []).\n"
            + ("6. Với mỗi câu, điền 'who' = tên gốc tiếng Trung của nhân vật ĐANG NÓI câu đó, viết đúng như trong danh sách "
               f"Nhân vật (hoặc như trong 'new_characters' nếu là nhân vật mới). Lời dẫn truyện điền '{NARRATOR_ZH}'. Không chắc thì để ''.\n"
               if self.ask_who else "6. KHÔNG điền trường 'who'.\n")
            + "7. 'character_notes': tính cách / cách nói của nhân vật thể hiện qua lời thoại đoạn này (tối đa 15 từ mỗi nhân vật), "
            "chỉ ghi cho nhân vật CHƯA có 'tính cách' ở ngữ cảnh trên; nhân vật mới thì điền luôn 'personality'.\n\n"
            + (f"=== CÁC CÂU NGAY TRƯỚC (chỉ để hiểu mạch, KHÔNG dịch lại) ===\n{prev_txt}" if prev_txt else "")
            + f"=== LỜI THOẠI CẦN DỊCH ===\n{payload}"
        )
        last_err: Optional[Exception] = None
        for attempt in range(3):
            if self.fatal:
                return
            try:
                ai_out = self._call_agy(prompt)
                vi_map = {}
                for item in ai_out.get("translations") or []:
                    try:
                        vi_map[int(item["id"])] = ((item.get("vi") or "").strip(), str(item.get("who") or "").strip())
                    except (KeyError, TypeError, ValueError):
                        continue
                got = 0
                for i, seg in enumerate(batch):
                    if vi_map.get(i + 1, ("",))[0]:
                        seg["vi"] = vi_map[i + 1][0]
                        if self.ask_who:
                            seg["who"] = vi_map[i + 1][1]
                        got += 1
                if got < len(batch) * 0.6:
                    raise RuntimeError(f"chỉ nhận được {got}/{len(batch)} câu dịch")
                self._absorb(ai_out)
                with self.lock:
                    self.fail_streak = 0
                    self.failed_segs += len(batch) - got
                self.prog.bump("tr_done", got)
                if self.verbose:
                    for seg in batch:
                        log(f"  [Dịch] {seg['start']:7.2f}s | {seg['vi'] or '(chưa dịch được)'}")
                return
            except Exception as exc:  # mạng chập chờn / quá tải: thử lại rồi mới bỏ qua lô này
                last_err = exc
                time.sleep(5 * (attempt + 1) ** 2)
        with self.lock:
            self.fail_streak += 1
            self.failed_segs += len(batch)
            log(f"[Dịch] ⚠ Bỏ qua tạm 1 lô {len(batch)} câu sau 3 lần thử: {last_err}")
            if self.fail_streak >= 4:
                self.fatal = f"Antigravity lỗi liên tục, đã dừng để không tạo video thiếu lời dịch: {last_err}"

    def _absorb(self, ai_out: Dict) -> None:
        """Nạp nhân vật / thuật ngữ / tóm tắt mới vào ngữ cảnh để các lô sau dịch nhất quán."""
        with self.lock:
            summary = (ai_out.get("episode_summary") or "").strip()
            if summary:
                self.summaries.append(summary[:400])
            known = {c.get("zh", "").strip() for c in self.chars}
            for nc in (ai_out.get("new_characters") or [])[:3]:
                zh, vi = (nc.get("zh") or "").strip(), (nc.get("vi") or "").strip()
                if zh and vi and zh not in known and len(self.chars) < self.MAX_CHARS:
                    item = {"zh": zh, "vi": vi, "role": (nc.get("role") or "").strip(), "pronouns": (nc.get("pronouns") or "").strip(),
                            "personality": (nc.get("personality") or "").strip()[:160]}
                    self.chars.append(item)
                    self.new_chars.append(item)
                    known.add(zh)
            # Tính cách AI rút ra từ lời thoại: chỉ điền khi nhân vật chưa có ghi chú (không đè lời người dùng viết).
            by_zh = {c.get("zh", "").strip(): c for c in self.chars}
            for note in (ai_out.get("character_notes") or [])[:6]:
                c, txt = by_zh.get(str(note.get("zh") or "").strip()), str(note.get("personality") or "").strip()[:160]
                if c and txt and not c.get("personality"):
                    c["personality"] = txt
                    self.new_notes[c["zh"]] = txt
            known = {g.get("zh", "").strip() for g in self.gloss}
            for ng in (ai_out.get("new_glossary") or [])[:5]:
                zh, vi = (ng.get("zh") or "").strip(), (ng.get("vi") or "").strip()
                if zh and vi and zh not in known and len(self.gloss) < self.MAX_GLOSS:
                    item = {"zh": zh, "vi": vi}
                    self.gloss.append(item)
                    self.new_gloss.append(item)
                    known.add(zh)

    def submit_chunk(self, chunk: Dict) -> None:
        if self.fatal:  # đừng để Whisper chạy tiếp hàng giờ khi phần dịch đã hỏng hẳn
            raise RuntimeError(self.fatal)
        segs = chunk["segments"]
        todo = [s for s in segs if s.get("zh") and not s.get("vi")]
        with self.prog.lock:
            self.prog.tr_total += len(segs)
            self.prog.tr_done += len(segs) - len(todo)
        if not todo:
            self.on_chunk_done(chunk)
            return
        batches = [todo[i : i + TRANSLATE_BATCH] for i in range(0, len(todo), TRANSLATE_BATCH)]
        state = {"left": len(batches)}
        pos = {id(s): i for i, s in enumerate(segs)}

        def work(batch: List[Dict]) -> None:
            first = pos[id(batch[0])]
            prev = [s["zh"] for s in segs[max(0, first - 4) : first]]
            try:
                self._translate_batch(batch, prev)
            finally:
                with self.lock:
                    state["left"] -= 1
                    done = state["left"] == 0
                if done:
                    chunk["translated"] = all(s.get("vi") for s in segs if s.get("zh"))
                    self.job.save_chunk(chunk)
                    self.job.save_meta(summaries=self.summaries[-200:])
                    self.persist_memory(final=False)
                    self.on_chunk_done(chunk)

        for b in batches:
            self.futures.append(self.pool.submit(work, b))

    def wait(self) -> None:
        for f in self.futures:
            f.result()
        self.pool.shutdown()
        if self.fatal:
            raise RuntimeError(self.fatal)

    def persist_memory(self, final: bool) -> None:
        """Ghi nhân vật/thuật ngữ mới vào file Dự án. Đọc lại file trước khi ghi để không đè chỉnh sửa trên web."""
        if not self.project_id:
            return
        with self.memory_lock:  # 2 luồng dịch xong cùng lúc không được đọc-ghi file dự án chồng nhau
            self._persist_memory(final)

    def _persist_memory(self, final: bool) -> None:
        with self.lock:
            add_chars, add_gloss, notes_add = self.new_chars, self.new_gloss, self.new_notes
            self.new_chars, self.new_gloss, self.new_notes = [], [], {}
            summaries = list(self.summaries)
        if not (add_chars or add_gloss or notes_add or final):
            return
        p = story_project_path(self.project_id, self.story_dir)
        proj = read_json(p, None)
        if not proj:
            return
        have = {c.get("zh", "").strip() for c in proj.get("characters") or []}
        proj["characters"] = (proj.get("characters") or []) + [c for c in add_chars if c["zh"] not in have]
        for c in proj["characters"]:
            if notes_add.get(c.get("zh", "").strip()) and not c.get("personality"):
                c["personality"] = notes_add[c["zh"].strip()]
        have = {g.get("zh", "").strip() for g in proj.get("glossary") or []}
        proj["glossary"] = (proj.get("glossary") or []) + [g for g in add_gloss if g["zh"] not in have]
        if final and summaries:
            # Video dài có hàng nghìn tóm tắt lô: chỉ giữ ~8 mốc rải đều để ghi nhớ mạch truyện.
            step = max(1, math.ceil(len(summaries) / 8))
            notes = proj.get("episode_notes") or {}
            notes[self.job.job_id] = " ".join(summaries[::step])[:1500]
            proj["episode_notes"] = notes
        proj["updated_at"] = datetime.now().isoformat(timespec="seconds")
        write_json_atomic(p, proj, indent=2)
        if add_chars or add_gloss:
            log(f"[Dự án] Antigravity đã ghi nhớ thêm +{len(add_chars)} nhân vật, +{len(add_gloss)} thuật ngữ vào '{proj.get('name')}'.")
