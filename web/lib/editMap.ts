/** Bản đồ {id: giá trị mới} dùng cho sửa lời / người nói hàng loạt: chỉ giữ khi khác giá trị gốc. */
export function setMap(map: Record<string, string>, setter: (m: Record<string, string>) => void, key: string, val: string, orig: string) {
  const next = { ...map };
  if (val !== orig) next[key] = val;
  else delete next[key];
  setter(next);
}
