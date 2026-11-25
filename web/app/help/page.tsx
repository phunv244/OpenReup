"use client";
import { Topbar } from "@/components/Shell";

const STEPS: [string, React.ReactNode][] = [
  ["Tạo dự án", "Mỗi bộ truyện / phim là một dự án. Nhập bối cảnh và nhân vật để AI dịch đúng xưng hô."],
  ["Thêm video", <>Trong dự án, bấm <b>Thêm video</b> và dán link Bilibili / YouTube; hoặc tải từ <b>Kho Douyin</b>.</>],
  ["Lồng tiếng", <>Bấm <b>Lồng tiếng</b> ở video. Máy tự nhận diện lời thoại → dịch → tạo giọng Việt → xuất video.</>],
  ["Sửa lời & xuất lại", <>Bấm <b>Sửa lời</b>, chỉnh câu chưa ưng rồi xuất lại — chỉ câu và đoạn bị sửa mới phải làm lại.</>],
];

const FILES: [string, React.ReactNode][] = [
  ["downloads/bilibili/", "Video tải từ Bilibili / YouTube"],
  ["downloads/", "Video tải từ Douyin"],
  ["downloads/dubbed/", <>Bản lồng tiếng Việt (<code>.mp4</code>) và phụ đề (<code>.srt</code>)</>],
  ["data/projects/", "Ngữ cảnh AI của từng dự án"],
  ["data/voices/", "Giọng clone (file .wav) dùng chung mọi dự án"],
  ["data/fonts/", "Font chữ phụ đề tải lên ở mục Tài nguyên"],
  ["data/openreup.db", "Câu thoại của các bản lồng tiếng (SQLite)"],
  ["data/dub_work/", "Tiến độ đang dở và cache giọng đọc / video"],
  ["chrome_profile/", "Phiên đăng nhập Douyin"],
];

export default function HelpPage() {
  return (
    <>
      <Topbar title="Hướng dẫn" sub="Quy trình làm việc và mẹo xử lý video rất dài" />
      <main className="content">
        <div className="cols cols-2">
          <section className="card">
            <header className="card-head"><h3>Quy trình 4 bước</h3></header>
            <div className="card-body">
              <ol className="steps">
                {STEPS.map(([title, body], i) => (
                  <li key={i}>
                    <span className="step-badge">{i + 1}</span>
                    <div>
                      <b>{title}</b>
                      <p>{body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
          <section className="card">
            <header className="card-head"><h3>Video rất dài (9 – 90 tiếng)</h3></header>
            <div className="card-body prose">
              <ul>
                <li><b>Chạy tiếp được.</b> Video được xử lý theo khối 10 phút và lưu tiến độ liên tục. Dừng, tắt máy, mất mạng — bấm <b>Tiếp tục</b> là chạy từ chỗ đang dở.</li>
                <li><b>Không tốn RAM.</b> Mỗi lúc chỉ một khối nằm trong bộ nhớ, video 90 tiếng dùng RAM như video 10 phút.</li>
                <li><b>Xóa logo</b> ở bước lồng tiếng (bật <b>Xóa logo khi xuất</b> rồi khoanh vùng): video chỉ bị mã hóa một lần.</li>
                <li><b>Ổ cứng:</b> cần trống khoảng 2,2 lần dung lượng video nếu in phụ đề / xóa logo; khoảng 1,2 lần nếu giữ nguyên hình.</li>
                <li><b>Hàng đợi:</b> bấm lồng tiếng / tải nhiều video liền, máy tự xếp hàng và làm lần lượt (xem cột bên phải). Cứ để máy chạy qua đêm.</li>
                <li><b>Cache:</b> giọng đọc và các đoạn video đã mã hóa được giữ lại để xuất lại nhanh. Lấy lại ổ cứng bằng <b>⋯ → Xóa cache</b>.</li>
              </ul>
            </div>
          </section>
        </div>
        <div className="cols cols-2">
          <section className="card">
            <header className="card-head"><h3>Câu hỏi thường gặp</h3></header>
            <div className="card-body">
              <details className="faq">
                <summary>Bấm lồng tiếng khi máy đang bận?</summary>
                <p>Tác vụ được xếp vào <b>Hàng đợi</b> ở cột bên phải và tự chạy khi tác vụ trước xong. Bấm <b>×</b> để bỏ khỏi hàng đợi; bấm <b>Dừng</b> để dừng tác vụ đang chạy — tiến độ lồng tiếng vẫn được lưu.</p>
              </details>
              <details className="faq">
                <summary>Một số câu bị “chưa dịch”?</summary>
                <p>AI lỗi tạm thời ở vài lô. Mở <b>Sửa lời</b>, tick <b>Chỉ câu chưa dịch</b> để điền tay, hoặc chọn <b>Lồng tiếng lại</b>.</p>
              </details>
              <details className="faq">
                <summary>Video Bilibili vẫn còn logo?</summary>
                <p>Bật <b>Xóa logo khi xuất</b> trong hộp thoại lồng tiếng hoặc <b>Sửa lời</b> (hoặc <b>⋯ → Xóa logo video gốc</b>) rồi kéo chuột quanh đúng logo.</p>
              </details>
              <details className="faq">
                <summary>Đổi font, màu chữ, nền, viền của phụ đề?</summary>
                <p>Khi lồng tiếng (hoặc ở <b>Sửa lời</b>), mục <b>Kiểu phụ đề Việt</b> → <b>Tùy chỉnh</b>; ảnh xem trước vẽ trên khung hình thật. Font riêng tải lên ở mục <b>Tài nguyên</b> (cần đủ dấu tiếng Việt).</p>
              </details>
              <details className="faq">
                <summary>Phụ đề Việt đè lên chữ Trung?</summary>
                <p>Bật <b>Che phụ đề gốc</b> khi lồng tiếng (hoặc trong <b>Sửa lời</b>) rồi khoanh vùng chữ Trung: vùng đó được làm mờ và phụ đề Việt hiện ngay trong khung.</p>
              </details>
              <details className="faq">
                <summary>Nhận diện sót câu nói nhỏ / thì thầm?</summary>
                <p>Vào <b>Mô hình nhận diện</b>, chọn bộ lọc <b>FireRedVAD</b> (bắt câu ngắn, thì thầm tốt nhất) và mô hình <b>SenseVoice-Small</b>.</p>
              </details>
              <details className="faq">
                <summary>Quét kênh Douyin dừng sớm hoặc tải bị lỗi 403?</summary>
                <p>Do mạng chậm, Douyin đòi xác minh, hoặc link tải hết hạn. Vào <b>Kho Douyin → Quét kênh</b>, bấm <b>Quét nối tiếp</b> rồi tải lại.</p>
              </details>
            </div>
          </section>
          <section className="card">
            <header className="card-head"><h3>Vị trí các file</h3></header>
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {FILES.map(([path, desc]) => (
                    <tr key={path}>
                      <td><code>{path}</code></td>
                      <td>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
