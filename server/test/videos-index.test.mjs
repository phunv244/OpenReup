/** lib/videos.mjs: chỉ mục video.json đọc được cả bố cục mới (data/videos/) lẫn bố cục cũ (downloads/, dub_work/). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { setupApp } from "./helpers.mjs";

const { app, dir, cleanup } = await setupApp();
after(cleanup);
const { VIDEOS_DIR, DATA_DIR } = await import("../config.mjs");
const await_import = await import("../lib/videos.mjs");
const { lookupDownload, jobPaths, reloadVideoIndex } = await_import;
const { resolveDownload, relOf } = await import("../lib/util.mjs");

const put = (file, body = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
const OLD_SRC = path.join(dir, "downloads", "bilibili", "BVold_p1_a.mp4");
const OLD_OUT = path.join(dir, "downloads", "dubbed", "dub_BVold_p1_a_0p5x.mp4");

test("chưa có data/videos/: tra theo bố cục cũ, không tạo data/videos/", async () => {
  put(OLD_SRC);
  assert.equal(VIDEOS_DIR, path.join(DATA_DIR, "videos"));
  assert.equal(resolveDownload("downloads/bilibili/BVold_p1_a.mp4"), OLD_SRC);
  assert.equal(relOf(OLD_SRC), "downloads/bilibili/BVold_p1_a.mp4");
  assert.deepEqual(lookupDownload("downloads/dubbed/dub_BVold_p1_a_0p5x.mp4"), { abs: OLD_OUT, kind: "output", key: "", job_id: "" });
  assert.equal(lookupDownload("downloads/bilibili/BVold_p1_a.mp4").kind, "source");
  assert.equal(jobPaths("dub_BVold_p1_a_0p5x"), null);
  // Chống ../ như trước.
  for (const bad of ["", "../data/openreup.db", "downloads/../data/x", "/etc/passwd", "downloads"]) {
    assert.equal(resolveDownload(bad), "", bad);
    assert.equal(lookupDownload(bad), null, bad);
  }
  // API đi qua resolveDownload vẫn chạy với dữ liệu cũ.
  const res = await app.inject({ method: "GET", url: "/api/sources" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().sources.map((s) => s.rel_path), ["downloads/bilibili/BVold_p1_a.mp4"]);
  assert.equal(fs.existsSync(VIDEOS_DIR), false);
});

test("bố cục mới: rel_path ↔ đường dẫn thật, job → {project, work, out}, loại file, giữ hoa/thường BV id", () => {
  const v1 = path.join(VIDEOS_DIR, "bilibili-BV1nHW3z3EhH-p1");
  const v2 = path.join(VIDEOS_DIR, "bilibili-BV1nhw3z3ehh-p1"); // chỉ khác hoa/thường: video khác
  const job = "dub_BV1nHW3z3EhH_p1__0p5x";
  put(path.join(v1, "video.json"), {
    key: "bilibili-BV1nHW3z3EhH-p1",
    files: { "downloads/bilibili/BV1nHW3z3EhH_p1__.mp4": "source/BV1nHW3z3EhH_p1__.mp4" },
    jobs: [job],
  });
  put(path.join(v1, "source", "BV1nHW3z3EhH_p1__.mp4"));
  put(path.join(v1, "jobs", job, "out", `${job}.mp4`));
  put(path.join(v2, "video.json"), {
    key: "bilibili-BV1nhw3z3ehh-p1",
    files: { "downloads/bilibili/BV1nhw3z3ehh_p1__.mp4": "source/BV1nhw3z3ehh_p1__.mp4" },
    jobs: [],
  });
  put(path.join(VIDEOS_DIR, "_orphan", "jobs", "dub_mat_nguon_0p65x", "work", "meta.json"), {});
  reloadVideoIndex();

  const src = path.join(v1, "source", "BV1nHW3z3EhH_p1__.mp4");
  assert.equal(resolveDownload("downloads/bilibili/BV1nHW3z3EhH_p1__.mp4"), src);
  assert.equal(resolveDownload("downloads/bilibili/./BV1nHW3z3EhH_p1__.mp4"), src);
  assert.equal(relOf(src), "downloads/bilibili/BV1nHW3z3EhH_p1__.mp4");
  assert.equal(resolveDownload("downloads/bilibili/BV1nhw3z3ehh_p1__.mp4"), path.join(v2, "source", "BV1nhw3z3ehh_p1__.mp4"));

  const out = path.join(v1, "jobs", job, "out", `${job}.mp4`);
  assert.deepEqual(lookupDownload(`downloads/dubbed/${job}.mp4`), { abs: out, kind: "output", key: "bilibili-BV1nHW3z3EhH-p1", job_id: job });
  assert.equal(relOf(out), `downloads/dubbed/${job}.mp4`);
  assert.equal(relOf(path.join(v1, "jobs", job, "out", `${job}.srt`)), `downloads/dubbed/${job}.srt`);
  assert.equal(lookupDownload("downloads/bilibili/BV1nHW3z3EhH_p1__.mp4").kind, "source");
  assert.deepEqual(jobPaths(job), {
    key: "bilibili-BV1nHW3z3EhH-p1",
    project: path.join(v1, "jobs", job, "project.json"),
    work: path.join(v1, "jobs", job, "work"),
    out: path.join(v1, "jobs", job, "out"),
  });
  assert.equal(jobPaths("dub_mat_nguon_0p65x").key, "_orphan");
  assert.equal(relOf(path.join(VIDEOS_DIR, "_orphan", "jobs", "dub_mat_nguon_0p65x", "out", "dub_mat_nguon_0p65x.mp4")), "downloads/dubbed/dub_mat_nguon_0p65x.mp4");

  // Bố cục cũ vẫn đọc được song song.
  assert.equal(resolveDownload("downloads/bilibili/BVold_p1_a.mp4"), OLD_SRC);
  assert.equal(relOf(OLD_OUT), "downloads/dubbed/dub_BVold_p1_a_0p5x.mp4");
});

test("thêm video mới (mtime data/videos đổi) thì chỉ mục tự đọc lại; video.json hỏng/sai bị bỏ qua, không lọt ra ngoài source/", () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    put(path.join(VIDEOS_DIR, "douyin-123", "video.json"), { key: "douyin-123", files: { "downloads/123.mp4": "source/123.mp4" }, jobs: [] });
    // Thêm thư mục đổi mtime của data/videos/ ở cùng mili giây với lần trước thì không thấy: ép mtime khác.
    fs.utimesSync(VIDEOS_DIR, new Date(), new Date(Date.now() + 5000));
    assert.equal(resolveDownload("downloads/123.mp4"), path.join(VIDEOS_DIR, "douyin-123", "source", "123.mp4"));

    put(path.join(VIDEOS_DIR, "hong", "video.json"), "{không phải json");
    put(path.join(VIDEOS_DIR, "sai-key", "video.json"), { key: "khac", files: { "downloads/k.mp4": "source/k.mp4" } });
    put(path.join(VIDEOS_DIR, "thoat", "video.json"), {
      key: "thoat",
      files: { "downloads/t.mp4": "../../../etc/passwd", "downloads/../x.mp4": "source/x.mp4", "data/a.mp4": "source/a.mp4" },
      jobs: ["../dub_x", "dub_ok_0p5x"],
    });
    put(path.join(VIDEOS_DIR, "_migration", "video.json"), { key: "_migration", files: { "downloads/m.mp4": "source/m.mp4" } });
    reloadVideoIndex();
    assert.equal(resolveDownload("downloads/k.mp4"), path.join(dir, "downloads", "k.mp4"));
    assert.equal(resolveDownload("downloads/t.mp4"), path.join(dir, "downloads", "t.mp4"));
    assert.equal(resolveDownload("downloads/m.mp4"), path.join(dir, "downloads", "m.mp4"));
    assert.equal(jobPaths("dub_ok_0p5x").key, "thoat");
    assert.equal(warned.filter((m) => /hong|sai-key|thoat/.test(m)).length, 6, warned.join("\n"));
  } finally {
    console.warn = warn;
  }
});

test("hai video.json cùng nhận một rel_path / job: giữ bản theo thứ tự tên, có cảnh báo", () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    for (const key of ["trung-a", "trung-b"]) put(path.join(VIDEOS_DIR, key, "video.json"), { key, files: { "downloads/trung.mp4": "source/trung.mp4" }, jobs: ["dub_trung_0p5x"] });
    reloadVideoIndex();
    assert.equal(resolveDownload("downloads/trung.mp4"), path.join(VIDEOS_DIR, "trung-a", "source", "trung.mp4"));
    assert.equal(jobPaths("dub_trung_0p5x").key, "trung-a");
    assert.equal(warned.filter((m) => /trung/.test(m)).length, 2, warned.join("\n"));
  } finally {
    console.warn = warn;
  }
});

test("symlink trỏ ra ngoài source/ hoặc downloads/ bị từ chối (realpath), symlink vào downloads/dubbed tính là bản xuất", () => {
  const { writeVideoJson } = await_import;
  const outside = path.join(dir, "ngoai.txt");
  put(outside, "bi mat");
  const v = path.join(VIDEOS_DIR, "local-symlink");
  writeVideoJson("local-symlink", { key: "local-symlink", files: { "downloads/sl.mp4": "source/sl.mp4", "downloads/sl2.mp4": "source/sl2.mp4" }, jobs: ["dub_sl_0p5x"] });
  fs.mkdirSync(path.join(v, "source"), { recursive: true });
  fs.symlinkSync(outside, path.join(v, "source", "sl.mp4"));
  fs.symlinkSync("/etc", path.join(v, "source", "sl2.mp4"));
  assert.equal(resolveDownload("downloads/sl.mp4"), "");
  assert.equal(lookupDownload("downloads/sl2.mp4"), null);
  // Thư mục out/ của job là symlink ra ngoài: bản xuất cũng bị từ chối.
  fs.mkdirSync(path.join(v, "jobs", "dub_sl_0p5x"), { recursive: true });
  fs.symlinkSync(dir, path.join(v, "jobs", "dub_sl_0p5x", "out"));
  assert.equal(lookupDownload("downloads/dubbed/dub_sl_0p5x.mp4"), null);
  // Bố cục cũ: symlink trong downloads/ trỏ ra ngoài.
  fs.symlinkSync(outside, path.join(dir, "downloads", "bilibili", "link_ra_ngoai.mp4"));
  assert.equal(resolveDownload("downloads/bilibili/link_ra_ngoai.mp4"), "");
  // Symlink trong downloads/ trỏ vào bản xuất: vẫn nhận nhưng loại là output (không lồng tiếng lại được).
  put(OLD_OUT);
  fs.symlinkSync(OLD_OUT, path.join(dir, "downloads", "bilibili", "link_ban_xuat.mp4"));
  assert.equal(lookupDownload("downloads/bilibili/link_ban_xuat.mp4").kind, "output");
  // Symlink nằm gọn trong source/: vẫn dùng được; file chưa có trên đĩa vẫn trả đường dẫn (nơi gọi tự kiểm tồn tại).
  put(path.join(v, "source", "that.mp4"));
  writeVideoJson("local-symlink", { key: "local-symlink", files: { "downloads/that.mp4": "source/that.mp4", "downloads/chua-co.mp4": "source/chua-co.mp4" }, jobs: [] });
  assert.equal(resolveDownload("downloads/that.mp4"), path.join(v, "source", "that.mp4"));
  assert.equal(resolveDownload("downloads/chua-co.mp4"), path.join(v, "source", "chua-co.mp4"));
});

test("chỉ mục không bị cũ: mkdir thư mục video trước rồi mới ghi video.json (kể cả ghi tại chỗ, không rename) vẫn thấy ngay", () => {
  const v = path.join(VIDEOS_DIR, "douyin-999");
  fs.mkdirSync(v, { recursive: true });
  assert.equal(resolveDownload("downloads/999.mp4"), path.join(dir, "downloads", "999.mp4")); // chỉ mục đã dựng, chưa có video.json
  fs.writeFileSync(path.join(v, "video.json"), JSON.stringify({ key: "douyin-999", files: { "downloads/999.mp4": "source/999.mp4" }, jobs: [] }));
  assert.equal(resolveDownload("downloads/999.mp4"), path.join(v, "source", "999.mp4"));
  // Sửa video.json đã có bằng writeVideoJson: thêm job, thấy ngay.
  const { writeVideoJson } = await_import;
  writeVideoJson("douyin-999", { key: "douyin-999", files: { "downloads/999.mp4": "source/999.mp4" }, jobs: ["dub_999_0p5x"] });
  assert.equal(jobPaths("dub_999_0p5x").key, "douyin-999");
  // Job mồ côi mới thêm cũng thấy ngay.
  fs.mkdirSync(path.join(VIDEOS_DIR, "_orphan", "jobs", "dub_moi_0p5x"), { recursive: true });
  assert.equal(jobPaths("dub_moi_0p5x").key, "_orphan");
  // Không có thư mục tạm/file .tmp sót lại; key sai thì từ chối ghi.
  assert.deepEqual(fs.readdirSync(v), ["video.json"]);
  assert.throws(() => writeVideoJson("../x", { key: "../x" }), /video_key không hợp lệ/);
  assert.throws(() => writeVideoJson("_orphan", { key: "_orphan" }), /video_key không hợp lệ/);
});
