#!/usr/bin/env python3
"""
Douyin Channel Video Lister via ADB (Video Player Swipe Mode)
Swipes through videos in a Douyin channel's video player (UltraDetailActivity),
extracting accurate live title, episode number, publish date, likes, comments,
collects, shares, and saving incrementally to JSON & CSV.
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


from pipeline.paths import DATA_DIR  # noqa: E402

DEFAULT_JSON = DATA_DIR / "videos.json"
DEFAULT_CSV = DATA_DIR / "videos.csv"


CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3,
    "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}
CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}


def chinese_to_int(text: str) -> Optional[int]:
    """Convert Chinese numeral string (e.g. '三百一十六', '一百六十九', '十二') to int."""
    text = text.strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)

    total = 0
    current = 0
    has_any = False
    for ch in text:
        if ch in CN_DIGITS:
            current = CN_DIGITS[ch]
            has_any = True
        elif ch in CN_UNITS:
            unit = CN_UNITS[ch]
            has_any = True
            if current == 0:
                current = 1
            if unit == 10000:
                total = (total + current) * unit
            else:
                total += current * unit
            current = 0
        else:
            return None
    if not has_any:
        return None
    return total + current


def extract_episode(title: str) -> Tuple[Optional[int], str]:
    """Extract episode number and label from a Douyin video title."""
    # Strip promo bracket prefixes like 【主页置顶可看12集超前】 before matching
    cleaned = re.sub(r"【[^】]*】", " ", title)

    for candidate in (cleaned, title):
        m = re.search(r"第?\s*(\d+)\s*[-~—至到]\s*(\d+)\s*[集话期]", candidate)
        if m:
            return int(m.group(1)), f"{m.group(1)}-{m.group(2)}"

        m = re.search(r"第\s*(\d+)\s*[集话期]", candidate)
        if m:
            num = int(m.group(1))
            return num, str(num)

        m = re.search(r"第\s*([零〇一二两三四五六七八九十百千万]+)\s*[集话期]", candidate)
        if m:
            num = chinese_to_int(m.group(1))
            if num is not None:
                return num, str(num)

        m = re.search(r"(\d+)\s*[集话期]", candidate)
        if m:
            num = int(m.group(1))
            return num, str(num)

        m = re.search(r"([零〇一二两三四五六七八九十百千万]+)\s*[集话期]", candidate)
        if m:
            num = chinese_to_int(m.group(1))
            if num is not None:
                return num, str(num)

    return None, ""


def parse_count(raw: str) -> int:
    """Parse Douyin count string like '3.8万', '1475', '1.2亿' into integer."""
    s = (raw or "").strip()
    if not s:
        return 0
    m = re.search(r"([\d.]+)\s*([万亿]?)", s)
    if not m:
        return 0
    val = float(m.group(1))
    unit = m.group(2)
    if unit == "亿":
        return int(val * 100_000_000)
    if unit == "万":
        return int(val * 10_000)
    return int(val)


def parse_player_xml(xml_path: str) -> Optional[Dict]:
    """Parse Douyin video player (UltraDetailActivity) UI dump for the active video."""
    tree = ET.parse(xml_path)
    root = tree.getroot()

    author = ""
    publish_date = ""
    title = ""
    likes_raw = ""
    comments_raw = ""
    collects_raw = ""
    shares_raw = ""

    for node in root.iter("node"):
        rid = node.attrib.get("resource-id", "")
        text = (node.attrib.get("text") or "").strip()
        desc = (node.attrib.get("content-desc") or "").strip()

        if rid == "com.ss.android.ugc.aweme:id/title" and text.startswith("@"):
            author = text.lstrip("@").strip()
        elif rid == "com.ss.android.ugc.aweme:id/desc" and text:
            # Remove trailing UI collapse marker '展开>' or '展开∨'
            title = re.sub(r"\s*展开[>∨v]?\s*$", "", text).strip()
        elif desc.startswith("发布时间：") or desc.startswith("发布时间:"):
            publish_date = desc.split("：", 1)[-1].split(":", 1)[-1].strip()
        elif rid == "com.ss.android.ugc.aweme:id/gr_" and text:
            likes_raw = text
        elif not likes_raw and "喜欢" in desc and "按钮" in desc:
            m = re.search(r"喜欢([^，,]+)", desc)
            if m:
                likes_raw = m.group(1).strip()
        elif desc.startswith("评论") and "按钮" in desc:
            m = re.search(r"评论([^，,]+)", desc)
            if m:
                comments_raw = m.group(1).strip()
        elif rid == "com.ss.android.ugc.aweme:id/d9-" and text:
            collects_raw = text
        elif rid == "com.ss.android.ugc.aweme:id/zml" and text:
            shares_raw = text

    if not title and not likes_raw:
        return None

    ep_num, ep_label = extract_episode(title)
    return {
        "author": author,
        "episode_num": ep_num,
        "episode_label": ep_label,
        "title": title,
        "publish_date": publish_date,
        "likes_raw": likes_raw,
        "likes": parse_count(likes_raw),
        "comments_raw": comments_raw,
        "comments": parse_count(comments_raw),
        "collects_raw": collects_raw,
        "collects": parse_count(collects_raw),
        "shares_raw": shares_raw,
        "shares": parse_count(shares_raw),
        "hashtags": re.findall(r"#([^\s#]+)", title),
    }


class ADBClient:
    def __init__(self, serial: Optional[str] = None):
        self.serial = serial or self._detect_device()

    def _base_cmd(self) -> List[str]:
        cmd = ["adb"]
        if self.serial:
            cmd += ["-s", self.serial]
        return cmd

    def _detect_device(self) -> str:
        out = subprocess.check_output(["adb", "devices"], text=True)
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device":
                return parts[0]
        raise RuntimeError("Không tìm thấy thiết bị Android nào đang kết nối ADB.")

    def run(self, *args: str, timeout: int = 25) -> str:
        cmd = self._base_cmd() + list(args)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            raise RuntimeError(f"ADB lỗi ({' '.join(args)}): {proc.stderr.strip()}")
        return proc.stdout

    def screen_size(self) -> Tuple[int, int]:
        out = self.run("shell", "wm", "size")
        m = re.search(r"(\d+)x(\d+)", out)
        if m:
            return int(m.group(1)), int(m.group(2))
        return 1080, 2400

    def tap(self, x: int, y: int) -> None:
        self.run("shell", "input", "tap", str(x), str(y))

    def dump_ui(self, local_path: str, width: int = 1080, height: int = 2400) -> None:
        remote = "/sdcard/reup_douyin_dump.xml"
        for attempt in range(3):
            self.run("shell", "rm", "-f", remote, timeout=10)
            out = self.run("shell", "uiautomator", "dump", remote, timeout=25)
            if "ERROR:" not in out and "UI hierchary dumped" in out:
                self.run("pull", remote, local_path, timeout=15)
                return
            # Video playback/animation blocks uiautomator idle state -> tap to pause & retry
            self.tap(width // 2, int(height * 0.35))
            time.sleep(0.5)
        raise RuntimeError("uiautomator dump không lấy được idle state sau 3 lần thử")

    def swipe_next_video(self, width: int, height: int, duration_ms: int = 220) -> None:
        """Swipe up to advance to the next video in Douyin player."""
        x = width // 2
        y_start = int(height * 0.75)
        y_end = int(height * 0.22)
        self.run("shell", "input", "swipe", str(x), str(y_start), str(x), str(y_end), str(duration_ms))


def make_video_key(video: Dict) -> str:
    return f"{video.get('title', '')}|{video.get('publish_date', '')}|{video.get('likes_raw', '')}"


def save_outputs(
    videos: List[Dict],
    meta: Dict[str, str],
    json_path: Path,
    csv_path: Path,
) -> None:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "channel_meta": meta,
        "total_collected": len(videos),
        "videos": videos,
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    fieldnames = [
        "index", "episode_num", "episode_label", "title", "publish_date",
        "likes_raw", "likes", "comments", "collects", "shares",
        "hashtags", "reup_status",
    ]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for v in videos:
            row = dict(v)
            row["hashtags"] = " ".join(f"#{h}" for h in v.get("hashtags", []))
            writer.writerow({k: row.get(k, "") for k in fieldnames})


def load_existing(json_path: Path) -> Tuple[Dict[str, str], List[Dict]]:
    if not json_path.exists():
        return {}, []
    data = json.loads(json_path.read_text(encoding="utf-8"))
    return data.get("channel_meta", {}), data.get("videos", [])


def main() -> int:
    parser = argparse.ArgumentParser(description="Tool list toàn bộ video kênh Douyin qua ADB (Player Mode)")
    parser.add_argument("--serial", help="ADB device serial (mặc định tự nhận)")
    parser.add_argument("--limit", type=int, default=0, help="Giới hạn số video cần lấy (0 = lấy hết)")
    parser.add_argument("--max-steps", type=int, default=650, help="Số lần vuốt tối đa (mặc định 650)")
    parser.add_argument("--stale-limit", type=int, default=5, help="Dừng sau N lần vuốt liên tiếp không đổi video")
    parser.add_argument("--delay", type=float, default=0.8, help="Thời gian chờ sau mỗi lần vuốt (giây)")
    parser.add_argument("--resume", action="store_true", help="Tiếp tục nối thêm vào data/videos.json cũ")
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON, help="Đường dẫn file JSON output")
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="Đường dẫn file CSV output")
    parser.add_argument("--from-dump", help="Chỉ parse thử từ 1 file XML dump có sẵn")
    args = parser.parse_args()

    meta: Dict[str, str] = {
        "channel_name": "楚新钓",
        "douyin_id": "76602931608",
        "share_url": "https://v.douyin.com/4I831MTYhcg/",
        "sec_uid": "MS4wLjABAAAAShPDui4jT63haBEolNbHB-ZRj1_3MWuzuPdvB7m66MWNQP5W31lbn1lbR08KawBd",
        "mcn": "奇头怪脑",
        "total_works": "580",
    }
    collected: List[Dict] = []
    seen = set()

    if args.resume:
        old_meta, collected = load_existing(args.json)
        meta.update(old_meta)
        for v in collected:
            seen.add(make_video_key(v))
        print(f"[Resume] Đã tải sẵn {len(collected)} video từ {args.json}")

    if args.from_dump:
        v = parse_player_xml(args.from_dump)
        if v:
            v["index"] = len(collected) + 1
            v["reup_status"] = "pending"
            collected.append(v)
            save_outputs(collected, meta, args.json, args.csv)
            print(f"[Dump Test] Parse OK: ep={v['episode_label']} | {v['publish_date']} | {v['likes_raw']} | {v['title']}")
        else:
            print("[Dump Test] Không tìm thấy thông tin video trong XML.")
        return 0

    adb = ADBClient(args.serial)
    width, height = adb.screen_size()
    print(f"[ADB] Kết nối: {adb.serial} ({width}x{height})")
    print("[Info] Đang quét từng video trong trình phát Douyin (vuốt lên để qua video tiếp theo).")
    print("[Info] Dữ liệu được lưu liên tục vào JSON & CSV. Nhấn Ctrl+C để dừng.\n")

    stale_rounds = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        xml_path = os.path.join(tmpdir, "dump.xml")
        try:
            for step in range(1, args.max_steps + 1):
                # Tap to pause video playback so uiautomator dump succeeds immediately
                adb.tap(width // 2, int(height * 0.35))
                time.sleep(0.35)
                try:
                    adb.dump_ui(xml_path, width, height)
                except Exception as e:
                    print(f"[Warn] Bước {step} dump UI lỗi: {e}, thử lại...")
                    time.sleep(1.0)
                    continue

                v = parse_player_xml(xml_path)
                if not v:
                    stale_rounds += 1
                    print(f"[Bước {step:03d}] Không đọc được video (có thể là ảnh/quảng cáo), vuốt tiếp...")
                else:
                    if v.get("author"):
                        meta["channel_name"] = v["author"]
                    key = make_video_key(v)
                    if key not in seen:
                        seen.add(key)
                        v["index"] = len(collected) + 1
                        v["reup_status"] = "pending"
                        collected.append(v)
                        stale_rounds = 0
                        save_outputs(collected, meta, args.json, args.csv)
                        ep_str = f"Tập {v['episode_label']}" if v["episode_label"] else "Khác"
                        print(
                            f"[{len(collected):03d}/{meta.get('total_works', '?')}] "
                            f"{ep_str:<10} | {v['publish_date']:<10} | ♥ {v['likes_raw']:<6} | {v['title'][:48]}"
                        )
                    else:
                        stale_rounds += 1
                        print(f"[Bước {step:03d}] Trùng video hiện tại ({stale_rounds}/{args.stale_limit})")

                if args.limit > 0 and len(collected) >= args.limit:
                    print(f"\n[Done] Đã đạt giới hạn --limit {args.limit} video.")
                    break

                if stale_rounds >= args.stale_limit:
                    print(f"\n[Done] Không còn video mới sau {args.stale_limit} lượt vuốt. Hoàn tất!")
                    break

                adb.swipe_next_video(width, height)
                time.sleep(args.delay)

        except KeyboardInterrupt:
            print("\n[Stop] Đã dừng theo yêu cầu người dùng.")

    save_outputs(collected, meta, args.json, args.csv)
    print(f"[Saved] Tổng cộng {len(collected)} video -> {args.json} & {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
