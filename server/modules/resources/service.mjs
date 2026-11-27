/** Nghiệp vụ tài nguyên dùng chung mọi dự án: font phụ đề, giọng đọc (clone/nghe thử), mô hình nhận diện, xem trước phụ đề. Lỗi do input: ném Error có statusCode. */
import crypto from "node:crypto";
import path from "node:path";
import { checkSubStyle } from "../../lib/fonts.mjs";
import { httpError, nowIso, validModelId, validSubcover, validVoice } from "../../lib/util.mjs";
import { PRESET_VOICES } from "./presets.mjs";


export const FONT_EXTS = ["ttf", "otf", "ttc", "otc"];
const MAX_FONT_BYTES = 40 * 1024 * 1024;
const MAX_VOICE_UPLOAD = 500 * 1024 * 1024;
const VOICE_EXT = /^(mp3|wav|m4a|aac|flac|ogg|opus|mp4|mkv|webm|mov)$/;
const validFontId = (v) => /^[a-z0-9][a-z0-9_-]{0,60}$/.test(String(v));
const validSlug = (s) => /^[a-z0-9_-]{1,40}$/.test(String(s));
const cloneId = (slug) => `vieneu-clone:${slug}`;
// `asr.py list` khởi động Python (~300 ms) mỗi lần: giữ kết quả 30 s. Tải mô hình xong / đổi VAD thì bỏ ngay;
// TTL chỉ để bắt thay đổi ngoài server (xóa tay thư mục mô hình, cài thêm gói Python).
const ASR_LIST_TTL_MS = 30_000;

/**
 * repo: resourceRepo (repo.mjs); deps (ctx.get hoặc bản giả trong test): dub (busyError: chặn xóa khi đang lồng tiếng),
 * project (addVoice/dropVoice: giọng của dự án), sources (fileOf: video nguồn đã tải);
 * tasks: { spawnTask, python, onEnd(fn) } của lib/tasks (onEnd: nghe sự kiện tác vụ nền kết thúc).
 */
export function createResourceService(repo, { dub, project, sources, tasks }) {
  const listClones = () => repo.listCloneVoices(validSlug);
  let asrList = null; // { at, promise } của lần `asr.py list` gần nhất (đang chạy hoặc đã xong, không lỗi)
  tasks.onEnd((ev) => {
    if (ev.type === "asr_download") asrList = null;
  });

  return {
    /* ---------- Font ---------- */
    async fonts() {
      return { ok: true, fonts: repo.listFonts(), system: await repo.systemFonts() };
    },
    async uploadFont(stream, name, contentLength) {
      const original = path.basename(String(name || "font.ttf"));
      const ext = path.extname(original).slice(1).toLowerCase();
      if (!FONT_EXTS.includes(ext)) throw httpError(400, `Chỉ nhận file font ${FONT_EXTS.join(", ")}.`);
      if (Number(contentLength) > MAX_FONT_BYTES) throw httpError(413, "File font lớn hơn 40 MB.");
      const tmp = repo.fontTmpFile(ext);
      try {
        await repo.saveUpload(stream, tmp, MAX_FONT_BYTES, "File font lớn hơn 40 MB.");
        const info = await repo.scanFont(tmp);
        if (repo.listFonts().some((f) => f.family.toLowerCase() === info.family.toLowerCase() && f.style === info.style)) {
          throw httpError(409, `Font "${info.family}" đã có trong tài nguyên.`);
        }
        return { ok: true, font: repo.addFont(tmp, ext, info, original) };
      } catch (err) {
        repo.removeFile(tmp);
        const code = err.statusCode || 400;
        throw httpError(code, code === 400 ? "File này không phải font hợp lệ." : err.message);
      }
    },
    removeFont(id) {
      if (!validFontId(id)) throw httpError(400, "Font không hợp lệ.");
      if (dub.busyError()) throw httpError(409, "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa font.");
      if (!repo.removeFont(id)) throw httpError(404, "Không tìm thấy font.");
      return { ok: true };
    },
    /** Font đã tải lên theo id (null nếu không có). */
    font: (id) => repo.listFonts().find((x) => x.id === String(id || "")) || null,
    fontsDir: repo.FONTS_DIR,

    /** Ảnh JPEG: 1 khung hình của video + phụ đề mẫu, vẽ bằng đúng bộ lọc sẽ dùng khi xuất. */
    subPreview(body) {
      const video = sources.fileOf(body.rel_path);
      if (!video) throw httpError(400, "Video không hợp lệ.");
      if (body.subcover !== undefined && !validSubcover(body.subcover)) throw httpError(400, "Vùng che phụ đề không hợp lệ.");
      const checked = checkSubStyle(body.style);
      if (checked.error) throw httpError(400, checked.error);
      const args = ["--input", video, "--subcover", String(body.subcover || "none")];
      if (checked.style) args.push("--style", JSON.stringify(checked.style));
      if (body.text) args.push("--text", String(body.text).slice(0, 160));
      if (body.burn === false) args.push("--no-sub"); // đang tắt in phụ đề: chỉ cho xem vùng che
      return repo.renderSubPreview(args);
    },

    /* ---------- Mô hình nhận diện ---------- */
    /** Danh sách mô hình (cache ASR_LIST_TTL_MS; request đồng thời dùng chung 1 lần chạy asr.py). Lỗi không được cache. */
    asrModels() {
      if (asrList && performance.now() - asrList.at < ASR_LIST_TTL_MS) return asrList.promise;
      const entry = { at: performance.now() };
      entry.promise = repo
        .runAsr(["list"])
        .then((r) => JSON.parse(r.stdout))
        .catch((err) => {
          if (asrList === entry) asrList = null;
          throw httpError(500, `Không đọc được danh sách mô hình: ${String(err.message).slice(0, 200)}`);
        });
      asrList = entry;
      return entry.promise;
    },
    async setVad(id) {
      if (!validModelId(id)) throw httpError(400, "Bộ lọc không hợp lệ.");
      try {
        await repo.runAsr(["set-vad", id]);
      } catch {
        throw httpError(400, "Bộ lọc giọng nói này chưa tải hoặc không tồn tại.");
      }
      asrList = null;
      return { ok: true };
    },
    /** Tác vụ nền tải mô hình: {ok, task_id} hoặc {ok:false, error} khi đang bận. */
    downloadAsr(id) {
      if (!validModelId(id)) throw httpError(400, "Mô hình không hợp lệ.");
      return tasks.spawnTask("asr_download", tasks.python, ["-u", repo.asrScript, "download", id], id);
    },

    /* ---------- Giọng đọc ---------- */
    voices: () => ({ clones: listClones().map((v) => ({ ...v, id: cloneId(v.slug), kind: "clone" })), presets: PRESET_VOICES }),

    /** Nhận file âm thanh/video tải lên vào thư mục tạm; trả mã để gọi createVoice({ upload }). */
    async uploadVoice(stream, ext, contentLength) {
      const e = String(ext || "").toLowerCase();
      if (!VOICE_EXT.test(e)) throw httpError(400, "Chỉ nhận file âm thanh / video (mp3, wav, m4a, mp4...).");
      if (Number(contentLength) > MAX_VOICE_UPLOAD) throw httpError(413, "File lớn hơn 500 MB.");
      const file = repo.newVoiceTmpFile(e);
      try {
        await repo.saveUpload(stream, file, MAX_VOICE_UPLOAD, "File lớn hơn 500 MB.");
      } catch (err) {
        throw httpError(err.statusCode || 500, err.message);
      }
      return { ok: true, token: path.basename(file) };
    },

    /** Clone giọng từ file tải lên / video nguồn / link. Lỗi của voice_tool.py trả nguyên {ok:false, ...}. */
    async createVoice(body) {
      const name = String(body.name || "").trim().slice(0, 60);
      let src = "";
      let source = "";
      let tmpFile = "";
      if (body.upload) {
        tmpFile = src = repo.voiceTmpFile(body.upload);
        source = `Tải lên: ${String(body.upload_name || "").slice(0, 80)}`;
        if (!repo.exists(src)) src = "";
      } else if (body.rel_path) {
        src = sources.fileOf(body.rel_path);
        source = `Video: ${path.basename(String(body.rel_path))}`;
      } else if (/^https?:\/\/\S+$/i.test(String(body.url || "").trim())) {
        src = source = String(body.url).trim();
      }
      if (!name || !src) throw httpError(400, !name ? "Hãy đặt tên cho giọng." : "Nguồn âm thanh không hợp lệ.");
      const slug = repo.voiceSlug(name, new Set(listClones().map((v) => v.slug)));
      const args = ["clone", "--src", src, "--out", repo.voiceWav(slug)];
      const manual = body.start !== undefined && body.start !== "" && body.end !== undefined && body.end !== "";
      if (manual) args.push("--start", String(Number(body.start) || 0), "--end", String(Number(body.end) || 0));
      const r = await repo.runVoiceTool(args, 15 * 60 * 1000);
      if (tmpFile) repo.removeFile(tmpFile);
      if (!r.ok) return r;
      const voice = {
        slug, name, gender: ["male", "female"].includes(body.gender) ? body.gender : r.gender, f0: r.f0, source,
        start: r.start, end: r.end, created_at: nowIso(),
      };
      repo.writeVoices([...listClones().filter((v) => v.slug !== slug), voice]);
      if (body.project_id) project.addVoice(String(body.project_id), cloneId(slug)); // thêm luôn vào dự án đang mở
      return { ok: true, voice: { ...voice, id: cloneId(slug), kind: "clone" } };
    },

    updateVoice(body) {
      const voices = listClones();
      const v = voices.find((x) => x.slug === body.slug);
      if (!v) throw httpError(404, "Không tìm thấy giọng.");
      if (body.name !== undefined) v.name = String(body.name).trim().slice(0, 60) || v.name;
      if (["male", "female", ""].includes(body.gender)) v.gender = body.gender;
      repo.writeVoices(voices);
      return { ok: true };
    },

    removeVoice(slug) {
      if (!validSlug(slug)) throw httpError(400, "Giọng không hợp lệ.");
      if (dub.busyError()) throw httpError(409, "Đang lồng tiếng. Hãy dừng tiến trình trước khi xóa giọng.");
      repo.removeFile(repo.voiceWav(slug));
      repo.writeVoices(repo.readVoicesRaw().filter((v) => v.slug !== slug));
      project.dropVoice(cloneId(slug)); // gỡ khỏi mọi dự án đang chọn giọng này
      return { ok: true };
    },

    /** Tên file .wav mẫu gốc của 1 giọng clone trong voicesDir ("" nếu mã sai). */
    sampleName: (slug) => (validSlug(slug) ? `${slug}.wav` : ""),
    voicesDir: repo.VOICES_DIR,

    /** Máy đọc thử 1 câu; kết quả giữ lại theo (giọng, câu). Trả {ok:true, name} (file trong previewDir) hoặc lỗi của voice_tool.py. */
    async previewVoice(voice, rawText) {
      const v = String(voice || "");
      const text = String(rawText || "").trim().slice(0, 200);
      if (!validVoice(v) || !/\p{L}/u.test(text)) throw httpError(400, "Giọng hoặc câu nghe thử không hợp lệ.");
      let stamp = "";
      if (v.startsWith("vieneu-clone:")) {
        const wav = repo.voiceWav(v.split(":")[1]);
        if (!repo.exists(wav)) throw httpError(404, "Không tìm thấy giọng.");
        stamp = String(repo.mtimeMs(wav)); // clone lại cùng tên thì không phát bản nghe thử cũ
      }
      const key = crypto.createHash("sha1").update(`${v}|${stamp}|${text}`).digest("hex");
      const out = repo.previewFile(key);
      if (!repo.exists(out)) {
        const r = await repo.queuePreview(() =>
          repo.exists(out) ? { ok: true } : repo.runVoiceTool(["preview", "--voice", v, "--text", text, "--out", out], 5 * 60 * 1000)
        );
        if (!r.ok) return r;
      }
      return { ok: true, name: path.basename(out) };
    },
    previewDir: repo.VOICE_PREVIEW_DIR,
  };
}
