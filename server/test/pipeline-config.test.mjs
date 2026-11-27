/** Hằng số PY_SCRIPTS (config.mjs) là nơi duy nhất server lấy đường dẫn script Python: mọi script phải có thật trong gói pipeline/. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PY_SCRIPTS, ROOT } from "../config.mjs";

test("PY_SCRIPTS trỏ tới script có thật trong pipeline/, không còn script .py ở gốc repo", () => {
  for (const [name, file] of Object.entries(PY_SCRIPTS)) {
    assert.ok(fs.statSync(file).isFile(), `${name}: ${file}`);
    assert.equal(path.dirname(file), path.join(ROOT, "pipeline"), name);
  }
  for (const old of ["dub_video.py", "asr.py", "subtitles.py", "voice_tool.py", "reup_paths.py"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, old)), `còn ${old} ở gốc repo`);
  }
});
