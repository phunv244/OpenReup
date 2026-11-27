"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Topbar } from "@/components/Shell";
import { useToast } from "@/components/Toasts";
import { Callout, Seg } from "@/components/ui";
import { VoiceLibrary } from "@/components/VoiceLibrary";
import { FontInfo, postJSON, uploadFile } from "@/lib/api";
import { useStudio } from "@/lib/studio";

type Tab = "fonts" | "voices";

const SAMPLE = "Xin chào các bạn — Phụ đề tiếng Việt 0123";
const EXTS = ["ttf", "otf", "ttc", "otc"];

function FontRow({ f }: { f: FontInfo }) {
  const toast = useToast();
  const { reload } = useStudio();
  async function remove() {
    if (!confirm(`Xóa font "${f.family}${f.style ? " " + f.style : ""}"?\n\nVideo đang dùng font này sẽ quay về font mặc định ở lần xuất lại sau.`)) return;
    const d = await postJSON("/api/fonts/delete", { id: f.id });
    if (!d.ok) return toast(d.error || "Không xóa được font", "error");
    toast("Đã xóa font", "success");
    reload();
  }
  return (
    <div className="font-row">
      <div className="font-main">
        <div className="font-name">
          {f.family}
          {f.style && <span className="badge gray">{f.style}</span>}
          {!f.vi && <span className="badge amber">Thiếu dấu tiếng Việt</span>}
        </div>
        {/* Chữ mẫu vẽ bằng chính font đã tải (trình duyệt nạp qua @font-face) */}
        <div className="font-sample" style={{ fontFamily: `"rf-${f.id}", sans-serif` }}>
          {SAMPLE}
        </div>
        <div className="font-sub">
          {f.original_name} · {f.size_kb >= 1024 ? `${(f.size_kb / 1024).toFixed(1)} MB` : `${f.size_kb} KB`}
        </div>
      </div>
      <button className="icon-btn danger" type="button" title="Xóa font" aria-label={`Xóa font ${f.family}`} onClick={remove}>
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
}

export default function ResourcesPage() {
  const toast = useToast();
  const { fonts, systemFonts, voices, reload, loaded } = useStudio();
  const [tab, setTab] = useState<Tab>("fonts");
  // Liên kết từ chỗ chọn giọng mở thẳng mục Giọng đọc (?tab=voices)
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "voices") setTab("voices");
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drag = useRef(0); // dragenter/leave bắn cả ở phần tử con: đếm để biết khi nào thật sự rời khung
  const [busy, setBusy] = useState(false);
  const [showSys, setShowSys] = useState(false);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    let ok = 0;
    for (const file of list) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!EXTS.includes(ext)) {
        toast(`${file.name}: chỉ nhận file ${EXTS.join(", ")}`, "error");
        continue;
      }
      const d = await uploadFile<{ font: FontInfo }>(`/api/fonts/upload?name=${encodeURIComponent(file.name)}`, file);
      if (!d.ok) {
        toast(`${file.name}: ${d.error || "không tải lên được"}`, "error");
        continue;
      }
      ok++;
      if (!d.font.vi) toast(`Font "${d.font.family}" không có đủ dấu tiếng Việt — phụ đề có thể bị lỗi chữ.`, "error");
    }
    setBusy(false);
    if (ok) {
      toast(ok === 1 ? "Đã thêm font" : `Đã thêm ${ok} font`, "success");
      reload();
    }
  }

  return (
    <>
      <Topbar title="Tài nguyên" />
      {/* @font-face cho chữ mẫu */}
      <style>{fonts.map((f) => `@font-face{font-family:"rf-${f.id}";src:url("/api/fonts/file?id=${f.id}")}`).join("")}</style>
      <main className="content">
        <div className="toolbar">
          <Seg<Tab>
            value={tab}
            onChange={setTab}
            items={[
              { v: "fonts", label: "Font chữ ", count: fonts.length },
              { v: "voices", label: "Giọng đọc ", count: voices.clones.length + voices.presets.length },
            ]}
          />
        </div>
        {!loaded ? null : tab === "voices" ? <VoiceLibrary /> : <>
        <Callout tone="info" icon="type">
          Font tải lên ở đây dùng được cho phụ đề Việt của <b>mọi dự án</b> (chọn khi lồng tiếng, hoặc mở video → tab <b>Hình &amp; phụ đề</b> → ô <b>Font chữ</b>). Chọn font có đủ dấu
          tiếng Việt.
        </Callout>

        {/* Kéo file vào bất kỳ đâu trong khối này để tải lên; vùng nét đứt chỉ hiện khi đang kéo file. */}
        <section
          className="card drop-host"
          onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); drag.current++; setOver(true); } }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
          onDragLeave={() => { if (--drag.current <= 0) { drag.current = 0; setOver(false); } }}
          onDrop={(e) => { e.preventDefault(); drag.current = 0; setOver(false); upload(e.dataTransfer.files); }}
        >
          <header className="card-head">
            <h3>Font chữ của bạn</h3>
            <button className="btn btn-primary btn-sm" type="button" disabled={busy} title="Hoặc kéo thả file font vào khung này" onClick={() => input.current?.click()}>
              <Icon name={busy ? "clock" : "plus"} size={15} /> {busy ? "Đang tải lên…" : "Tải font lên"}
            </button>
          </header>
          <input ref={input} type="file" hidden multiple accept=".ttf,.otf,.ttc,.otc" onChange={(e) => { upload(e.target.files || []); e.target.value = ""; }} />
          {over && (
            <div className="drop-zone over" aria-hidden="true">
              <Icon name="download" size={22} />
              <b>Thả để tải font lên</b>
              <span className="muted">{EXTS.map((e) => `.${e}`).join("  ")} · tối đa 40 MB mỗi file</span>
            </div>
          )}
          {fonts.length ? (
            fonts.map((f) => <FontRow key={f.id} f={f} />)
          ) : (
            <div className="voice-empty muted">Chưa có font nào. Phụ đề đang dùng font có sẵn trong máy (DejaVu Sans).</div>
          )}
        </section>

        <section className="card">
          <header className="card-head">
            <h3>
              Font có sẵn trong máy <span className="badge gray">{systemFonts.length}</span>
            </h3>
            <button className="btn btn-quiet btn-sm" type="button" onClick={() => setShowSys(!showSys)}>
              {showSys ? "Ẩn" : "Xem danh sách"}
            </button>
          </header>
          {showSys ? (
            <div className="sys-fonts">
              {systemFonts.map((f) => (
                <span key={f} style={{ fontFamily: `"${f}", sans-serif` }}>
                  {f}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted pad">Các font tiếng Việt cài sẵn trong hệ điều hành, luôn dùng được cho phụ đề mà không cần tải lên.</p>
          )}
        </section>
        </>}
      </main>
    </>
  );
}
