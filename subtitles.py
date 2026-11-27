#!/usr/bin/env python3
"""Phụ đề in cứng: vùng che phụ đề gốc, kiểu chữ (font / màu / nền / viền) và file ASS.

Chỉ dùng thư viện chuẩn để chạy nhanh: dub_video.py dùng khi xuất video, server gọi `preview` để xem trước đúng
hình ảnh libass sẽ vẽ (cùng mã với bản xuất thật nên không lệch).
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from reup_paths import DATA_DIR  # noqa: E402

FONTS_DIR = DATA_DIR / "fonts"
DEFAULT_FONT = "DejaVu Sans"
SAMPLE_TEXT = "Xin chào các bạn, đây là phụ đề tiếng Việt mẫu"

# Kiểu phụ đề người dùng chỉnh. Thiếu trường nào thì lấy mặc định của trường đó.
STYLE_DEFAULTS = {
    "font": DEFAULT_FONT,
    "size_pct": 100,  # % so với cỡ chữ tự tính theo video / khung che
    "bold": True,
    "color": "#FFFFFF",  # màu chữ
    "bg": "#000000",  # màu nền (khung sau chữ)
    "bg_opacity": 87,  # % độ đặc của nền: 0 = không có nền
    "outline": "#000000",  # màu viền chữ
    "outline_width": 0.0,  # độ dày viền, đơn vị "điểm ảnh trên video cao 720"; 0 = không viền
}
_HEX = re.compile(r"#[0-9a-fA-F]{6}")


def _clamp(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def clean_style(raw) -> Optional[Dict]:
    """Chuẩn hóa kiểu từ JSON (server đã kiểm tra, đây là lớp phòng thủ thứ hai). None = dùng kiểu mặc định."""
    if not isinstance(raw, dict) or not raw:
        return None
    s = dict(STYLE_DEFAULTS)
    font = re.sub(r"[,\\{}\r\n]", " ", str(raw.get("font") or "")).strip()[:80]  # dấu phẩy phá dòng Style của ASS
    s["font"] = font or DEFAULT_FONT
    s["size_pct"] = int(_clamp(raw.get("size_pct"), 40, 250, 100))
    s["bold"] = bool(raw.get("bold", True))
    for key in ("color", "bg", "outline"):
        v = str(raw.get(key) or "")
        s[key] = v.upper() if _HEX.fullmatch(v) else STYLE_DEFAULTS[key]
    s["bg_opacity"] = int(_clamp(raw.get("bg_opacity"), 0, 100, 87))
    s["outline_width"] = round(_clamp(raw.get("outline_width"), 0, 12, 0.0), 1)
    return s


def parse_region(mode: str) -> Optional[Tuple[int, int, int, int]]:
    if mode and re.fullmatch(r"\d+,\d+,\d+,\d+", mode):
        x, y, w, h = map(int, mode.split(","))
        return (x, y, w, h) if w >= 4 and h >= 4 else None
    return None


def build_subcover_filter(mode: str, w: int, h: int) -> str:
    """Xóa phụ đề gốc kiểu xóa logo (delogo): nội suy từ viền quanh vùng x,y,w,h nên chữ Trung + viền đen biến mất,
    không còn khối hộp tối. Cùng 1 lần mã hóa với xóa logo và in phụ đề Việt."""
    r = parse_region(mode)
    if not r:
        return ""
    # delogo báo lỗi nếu vùng chạm mép: x,y >= 1 và x+w, y+h <= kích thước - 1
    x, y = max(1, r[0]), max(1, r[1])
    bw, bh = min(r[2], w - 1 - x), min(r[3], h - 1 - y)  # vùng vượt mép thì cắt cho vừa
    if bw < 4 or bh < 4:
        return ""
    return f"delogo=x={x}:y={y}:w={bw}:h={bh}:show=0"


# ----------------------------------------------------------------------------
# ASS
# ----------------------------------------------------------------------------
def _ass_color(hex_rgb: str, opacity_pct: float = 100) -> str:
    """#RRGGBB + độ đặc % -> &HAABBGGRR (ASS: alpha 00 = đặc, FF = trong suốt)."""
    r, g, b = hex_rgb[1:3], hex_rgb[3:5], hex_rgb[5:7]
    alpha = 255 - round(max(0, min(100, opacity_pct)) * 2.55)
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ass_time(sec: float) -> str:
    cs = int(round(max(0.0, sec) * 100))
    return f"{cs // 360000}:{cs % 360000 // 6000:02d}:{cs % 6000 // 100:02d}.{cs % 100:02d}"


def sub_events(segments: List[Dict], offset: float = 0.0, window: Optional[float] = None) -> Iterable[Tuple[float, float, str]]:
    """Các câu của cả video, hoặc của 1 phần [offset, offset+window) với mốc giờ dời về 0 và cắt theo ranh giới phần."""
    for seg in segments:
        txt = (seg.get("vi") or seg.get("zh") or "").strip()
        start, end = seg["start"] - offset, seg["end"] - offset
        if not txt or (window is not None and (end <= 0 or start >= window)):
            continue
        if window is not None:
            start, end = max(0.0, start), min(window, end)
        yield start, end, txt


def layout(mode: str, w: int, h: int, size_pct: int = 100) -> Dict:
    """Cỡ chữ và lề (điểm ảnh của video). Mặc định: đáy video. Có vùng che phụ đề gốc: chữ căn giữa ngay trong vùng đó."""
    r = parse_region(mode)
    if not r:
        return {"size": round(h * 16 / 288 * size_pct / 100), "ml": round(w * 0.05), "mr": round(w * 0.05), "mv": round(h * 18 / 288), "cover": False}
    x, y, bw, bh = r
    bw, bh = min(bw, w - x), min(bh, h - y)
    # Chữ vừa đủ cho 2 dòng trong vùng (câu dài xuống dòng vẫn nằm trong khung); vùng cao thì chữ to, nhưng có trần.
    base = max(h * 0.024, min(h * 0.0625, bh / 2.6))
    size = round(base * size_pct / 100)
    return {
        "size": size, "ml": max(0, x + 4), "mr": max(0, w - x - bw + 4), "mv": 0, "cover": True,
        "cx": round(x + bw / 2), "cy": round(y + bh / 2),  # tâm vùng: khối chữ căn giữa ở đây dù 1 hay nhiều dòng
    }


def effective_style(style: Optional[Dict], cover: bool) -> Dict:
    """Chưa tùy chỉnh: nền đen đặc ở đáy video (kiểu cũ); có vùng che thì chỉ chữ trắng viền mỏng (nền đã là vùng mờ)."""
    if style:
        return style
    s = dict(STYLE_DEFAULTS)
    if cover:
        s.update(bg_opacity=0, outline="#000000", outline_width=1.6)
    return s


def build_ass(events: Iterable[Tuple[float, float, str]], w: int, h: int, mode: str = "none", style: Optional[Dict] = None) -> str:
    """File ASS 2 lớp: lớp dưới vẽ khung nền (BorderStyle 3), lớp trên vẽ chữ + viền — libass không vẽ được cả hai trong 1 kiểu."""
    lay = layout(mode, w, h, (style or {}).get("size_pct", 100))
    st = effective_style(style, lay["cover"])
    size = max(8, lay["size"])
    ow = round(st["outline_width"] * h / 720, 2)
    pad = round(size * 0.3, 1)
    bold = -1 if st["bold"] else 0
    font = st["font"]
    common = f"{font},{size},{{prim}},&H000000FF,{{outl}},&H00000000,{bold},0,0,0,100,100,0,0"
    align = 5 if lay["cover"] else 2  # 5 = giữa; 2 = giữa đáy
    text_style = "Style: Text," + common.format(prim=_ass_color(st["color"]), outl=_ass_color(st["outline"])) + f",1,{ow},0,{align},{lay['ml']},{lay['mr']},{lay['mv']},1"
    # Khung nền: chữ trong suốt, "viền" của BorderStyle 3 chính là khung đặc dày `pad` quanh chữ.
    box_style = "Style: Box," + common.format(prim="&HFF000000", outl=_ass_color(st["bg"], st["bg_opacity"])) + f",3,{pad},0,{align},{lay['ml']},{lay['mr']},{lay['mv']},1"
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,"
        "ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        text_style, box_style, "",
        "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    lines = []
    pos = f"{{\\an5\\pos({lay['cx']},{lay['cy']})}}" if lay["cover"] else ""
    for start, end, txt in events:
        t = pos + re.sub(r"[{}]", "", txt).replace("\r", "").replace("\n", "\\N")
        a, b = _ass_time(start), _ass_time(end)
        if st["bg_opacity"] > 0:
            lines.append(f"Dialogue: 0,{a},{b},Box,,0,0,0,,{t}")
        lines.append(f"Dialogue: 1,{a},{b},Text,,0,0,0,,{t}")
    return "\n".join(head + lines) + "\n"


def escape_filter_path(p: Path) -> str:
    return str(p.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def subtitles_filter(ass_path: Path) -> str:
    """Bộ lọc ffmpeg vẽ file ASS; font người dùng tải lên nằm trong data/fonts nên thêm làm nơi tìm font."""
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    return f"subtitles='{escape_filter_path(ass_path)}':fontsdir='{escape_filter_path(FONTS_DIR)}'"


# ----------------------------------------------------------------------------
# Xem trước: 1 khung hình của video + phụ đề mẫu, đúng như bản xuất
# ----------------------------------------------------------------------------
def probe_size(video: Path) -> Tuple[int, int]:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(video)],
        text=True,
    )
    w, h = out.strip().split("x")[:2]
    return int(w), int(h)


def render_preview(video: Path, out: Path, subcover: str, style: Optional[Dict], text: str, at: float = 1.0, burn: bool = True) -> None:
    w, h = probe_size(video)
    with tempfile.TemporaryDirectory() as tmp:
        ass = Path(tmp) / "preview.ass"
        ass.write_text(build_ass([(0.0, 30.0, text or SAMPLE_TEXT)], w, h, subcover, style), encoding="utf-8")
        filters = [f for f in (build_subcover_filter(subcover, w, h), subtitles_filter(ass) if burn else "") if f]
        if not filters:
            filters = ["null"]
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", str(video), "-vf", ",".join(filters), "-frames:v", "1", "-q:v", "3", str(out)],
            check=True, capture_output=True, timeout=60,
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Xem trước phụ đề Việt trên 1 khung hình")
    ap.add_argument("preview", nargs="?")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--subcover", default="none")
    ap.add_argument("--style", default="")
    ap.add_argument("--text", default=SAMPLE_TEXT)
    ap.add_argument("--no-sub", action="store_true", help="Chỉ vẽ vùng che, không vẽ phụ đề Việt")
    args = ap.parse_args()
    try:
        style = clean_style(json.loads(args.style)) if args.style else None
        render_preview(Path(args.input), Path(args.out), args.subcover, style, args.text[:160], burn=not args.no_sub)
    except subprocess.CalledProcessError as err:
        print(json.dumps({"ok": False, "error": (err.stderr or b"").decode("utf-8", "replace")[-300:] or "ffmpeg lỗi"}))
        return 1
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(err)[:300]}))
        return 1
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
