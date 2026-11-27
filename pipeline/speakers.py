"""Bước 3 (phụ): phân biệt người nói và gán giọng cho từng nhân vật (mỗi nhân vật 1 giọng)."""
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional

from pipeline.common import NARRATOR_ZH, fmt_clock, log, read_json, run_cmd, write_json_atomic
from pipeline.store import STORY_PROJECTS_DIR, story_project_path
from pipeline.tts import VOICES_DIR, VieNeuEngine

if TYPE_CHECKING:
    from pipeline.job import Progress


# Giọng VieNeu tự gán cho các nhân vật phụ (nhân vật nói nhiều nhất dùng giọng người dùng chọn).
AUTO_VOICES = {
    "male": ["vieneu:Thiện Minh", "vieneu:Hải Đăng", "vieneu:Quang Sơn", "vieneu:Thái Sơn",
             "vieneu:Thiền Tâm Đức", "vieneu:Đức Trí", "vieneu:Minh Đức", "vieneu:Phạm Tuyên"],
    "female": ["vieneu:Ngọc Huyền", "vieneu:Trúc Ly", "vieneu:Quỳnh Anh", "vieneu:Ngọc Trân",
               "vieneu:Mai Anh", "vieneu:Mỹ Duyên", "vieneu:Thùy Dung", "vieneu:Đoan Trang"],
}

DIAR_WINDOW_SEC = 600.0     # đọc audio gốc từng cửa sổ 10 phút: video 90 tiếng cũng không tràn RAM

DIAR_MAX_FIT = 3000         # gom nhóm trên tối đa 3000 câu dài nhất, các câu còn lại gán theo tâm nhóm

DIAR_DISTANCE = 0.62        # khoảng cách cosine tối đa trong 1 nhóm (đo trên video thử: 0.6–0.7 tách đúng 2 người)

DIAR_MAX_SPEAKERS = 8


def cluster_speakers(emb, durs):
    """Gom câu thành nhân vật theo đặc trưng giọng (vector đã chuẩn hóa). Trả mảng nhãn 0..k-1,
    nhãn 0 là người nói nhiều nhất. Câu < 1 giây (đặc trưng kém) chỉ được gán theo nhóm gần nhất."""
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering

    n = len(emb)
    if n == 0:
        return np.zeros(0, dtype=int)
    order = np.argsort(-durs)
    fit = [i for i in order[:DIAR_MAX_FIT] if durs[i] >= 1.0] or list(order[:DIAR_MAX_FIT])
    if len(fit) < 2:
        return np.zeros(n, dtype=int)
    lab = AgglomerativeClustering(
        n_clusters=None, metric="cosine", linkage="average", distance_threshold=DIAR_DISTANCE
    ).fit_predict(emb[fit])
    groups = [np.array(fit)[lab == k] for k in range(lab.max() + 1)]
    # Bỏ nhóm vụn (< 4% thời lượng lời và < 3 câu: thường là tiếng hét/cười/nhạc), giữ tối đa N nhân vật.
    total = durs[fit].sum()
    groups.sort(key=lambda g: -durs[g].sum())
    keep = [g for g in groups if durs[g].sum() >= total * 0.04 or len(g) >= 3][:DIAR_MAX_SPEAKERS] or groups[:1]
    cents = np.stack([emb[g].mean(axis=0) for g in keep])
    cents /= np.linalg.norm(cents, axis=1, keepdims=True) + 1e-9
    return np.argmax(emb @ cents.T, axis=1)


def diarize(input_mp4: Path, segments: List[Dict], prog: "Progress") -> int:
    """Ghi s["speaker"] = "NV1".."NVk" cho từng câu và s["_f0"] (cao độ trung vị, Hz). Trả số nhân vật."""
    import numpy as np

    enc = VieNeuEngine.model().engine._ensure_speaker_encoder()
    sr = 16000
    emb = np.zeros((len(segments), 0), dtype=np.float32)
    rows, f0s = [], []
    i = 0
    t = 0.0
    end_all = segments[-1]["end"] if segments else 0
    while i < len(segments):
        w0 = segments[i]["start"]
        j = i
        while j < len(segments) and segments[j]["end"] - w0 <= DIAR_WINDOW_SEC:
            j += 1
        j = max(j, i + 1)
        w1 = segments[j - 1]["end"]
        raw = run_cmd(["ffmpeg", "-v", "error", "-ss", f"{w0:.3f}", "-to", f"{w1 + 0.05:.3f}", "-i", str(input_mp4),
                       "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"])
        y = np.frombuffer(raw, dtype=np.float32)
        for s in segments[i:j]:
            clip = y[int((s["start"] - w0) * sr): int((s["end"] - w0) * sr)]
            if len(clip) < sr * 0.8:  # câu rất ngắn: lặp lại cho đủ độ dài tối thiểu của bộ trích giọng
                clip = np.tile(clip, int(np.ceil(sr * 0.8 / max(1, len(clip)))))[: int(sr * 0.8)] if len(clip) else np.zeros(int(sr * 0.8), np.float32)
            e = np.asarray(enc.embed(clip.astype(np.float32), sr), dtype=np.float32).reshape(-1)
            rows.append(e / (np.linalg.norm(e) + 1e-9))
            f0s.append(_median_f0(clip, sr))
        i = j
        t = w1
        prog.note = f"Phân biệt nhân vật {fmt_clock(t)} / {fmt_clock(end_all)}"
        prog.emit()
    emb = np.stack(rows)
    durs = np.array([s["end"] - s["start"] for s in segments])
    labels = cluster_speakers(emb, durs)
    for s, lab, f0 in zip(segments, labels, f0s):
        s["speaker"] = f"NV{lab + 1}"
        s["_f0"] = f0
    prog.note = ""
    return int(labels.max()) + 1 if len(labels) else 0


def _median_f0(clip, sr: int) -> float:
    import numpy as np
    import librosa

    if len(clip) < sr * 0.2:
        return 0.0
    f0 = librosa.yin(clip, fmin=70, fmax=450, sr=sr, frame_length=1024)
    f0 = f0[(f0 > 72) & (f0 < 445)]  # yin trả biên khi khung không có giọng
    return float(np.median(f0)) if len(f0) else 0.0


# Ranh giới nam/nữ theo cao độ trung vị. Giọng nam lồng hoạt hình hay lên 170–180 Hz (đo trên video thử), nữ thường > 200.
FEMALE_F0 = 185


def voice_gender(voice: str) -> str:
    """"male" / "female" / "" (không rõ) của 1 giọng: giọng clone đọc từ data/voices.json, preset theo danh sách."""
    if voice.startswith("vieneu-clone:"):
        slug = voice.split(":", 1)[1]
        return next((v.get("gender", "") for v in read_json(VOICES_DIR.parent / "voices.json", []) if v.get("slug") == slug), "")
    if voice in AUTO_VOICES["male"]:
        return "male"
    if voice in AUTO_VOICES["female"]:
        return "female"
    return ""


def match_characters(segments: List[Dict], characters: List[Dict], known_zh) -> Dict[str, Dict]:
    """Phân vai: nhóm giọng NVk (máy tách theo âm sắc) là nhân vật nào trong truyện? Bỏ phiếu theo thời lượng các câu
    AI đã ghi 'who' lúc dịch. Trả {"NV1": {"zh", "name", "is_new", "voice"}} — chỉ gồm nhóm đoán được (>= 2 câu và
    >= 50% thời lượng có ghi tên). "is_new": nhân vật chưa có trong ngữ cảnh dự án trước video này."""
    by_zh = {c.get("zh", "").strip(): c for c in characters if c.get("zh")}
    votes: Dict[str, Dict[str, List[float]]] = {}
    for s in segments:
        who = str(s.get("who") or "").strip()
        if who:
            v = votes.setdefault(s.get("speaker", "NV1"), {}).setdefault(who, [0.0, 0])
            v[0] += s["end"] - s["start"]
            v[1] += 1
    out: Dict[str, Dict] = {}
    for spk, tally in votes.items():
        who, (dur, n) = max(tally.items(), key=lambda kv: kv[1][0])
        if n < 2 or dur < 0.5 * sum(v[0] for v in tally.values()):
            continue
        if who == NARRATOR_ZH:
            out[spk] = {"zh": who, "name": "Dẫn truyện", "is_new": False, "voice": ""}
        elif who in by_zh:
            c = by_zh[who]
            voice = c.get("voice") or ""
            out[spk] = {"zh": who, "name": c.get("vi") or who, "is_new": who not in known_zh,
                        "voice": voice if voice.startswith(("vieneu:", "vieneu-clone:")) else ""}
    return out


def save_character_voices(project_id: str, voices: Dict[str, str], story_dir: Path = STORY_PROJECTS_DIR) -> None:
    """Ghi giọng máy vừa tự chọn vào nhân vật chưa có giọng trong dự án, để các video sau dùng lại đúng giọng đó."""
    p = story_project_path(project_id, story_dir) if project_id else None
    proj = read_json(p, None) if project_id and voices else None
    if not proj:
        return
    n = 0
    for c in proj.get("characters") or []:
        v = voices.get(c.get("zh", "").strip())
        if v and not c.get("voice"):
            c["voice"] = v
            n += 1
    if n:
        write_json_atomic(p, proj, indent=2)
        log(f"[Nhân vật] Đã ghi giọng tự chọn cho {n} nhân vật vào ngữ cảnh dự án (đổi được trong Ngữ cảnh AI).")


def auto_voice_map(segments: List[Dict], main_voice: str, project_voices: Optional[List[str]] = None,
                   fixed: Optional[Dict[str, str]] = None) -> Dict[str, Dict]:
    """{"NV1": {"voice", "gender", "f0", "lines"}, ...}: NV1 (nói nhiều nhất) giữ giọng đã chọn. Nhân vật khác
    nhận giọng chưa dùng, cùng giới tính đoán từ cao độ (> FEMALE_F0 Hz: nữ/trẻ em): ưu tiên giọng của dự án
    (để đồng bộ với kênh), hết mới lấy giọng VieNeu có sẵn."""
    import numpy as np

    mine = [v for v in project_voices or [] if v != main_voice]

    stats: Dict[str, Dict] = {}
    for s in segments:
        st = stats.setdefault(s.get("speaker", "NV1"), {"f0": [], "lines": 0, "dur": 0.0})
        st["lines"] += 1
        st["dur"] += s["end"] - s["start"]
        if s.get("_f0"):
            st["f0"].append(s["_f0"])
    fixed = fixed or {}  # {"NV2": giọng đã cấu hình cho nhân vật trong ngữ cảnh dự án}
    used = {main_voice, *fixed.values()}
    out: Dict[str, Dict] = {}
    for spk in sorted(stats, key=lambda k: -stats[k]["dur"]):
        st = stats[spk]
        f0 = round(float(np.median(st["f0"]))) if st["f0"] else 0
        gender = "female" if f0 > FEMALE_F0 else "male"
        if spk in fixed:
            voice = fixed[spk]
        elif not out:
            voice = main_voice
        else:
            other = "male" if gender == "female" else "female"
            pool = (
                [v for v in mine if v not in used and voice_gender(v) in (gender, "")]
                or [v for v in AUTO_VOICES[gender] if v not in used]
                or [v for v in mine + AUTO_VOICES[other] if v not in used]
                or [main_voice]
            )
            voice = pool[0]
        used.add(voice)
        out[spk] = {"voice": voice, "gender": gender, "f0": f0, "lines": st["lines"]}
    return out
