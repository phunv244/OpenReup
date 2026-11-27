/** Phân trang: luôn hiện trang đầu/cuối và ±2 trang quanh trang hiện tại. */

export function Pager({ page, pages, go }: { page: number; pages: number; go: (n: number) => void }) {
  if (pages <= 1) return null;
  const nums = [...new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) out.push(<span key={`g${n}`} className="gap">…</span>);
    out.push(
      <button key={n} type="button" className={n === page ? "active" : ""} onClick={() => go(n)}>
        {n}
      </button>
    );
    prev = n;
  }
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => go(page - 1)}>
        ‹ Trước
      </button>
      {out}
      <button type="button" disabled={page >= pages} onClick={() => go(page + 1)}>
        Sau ›
      </button>
    </div>
  );
}
