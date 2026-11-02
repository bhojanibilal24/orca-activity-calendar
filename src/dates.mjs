export function dateKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(value, count) {
  const d = new Date(value); d.setDate(d.getDate() + count); return d;
}
export function rangeDays(anchor, span = 7) {
  let first = new Date(anchor); first.setHours(0, 0, 0, 0);
  if (span === 7) first = addDays(first, -(first.getDay() + 6) % 7);
  return Array.from({ length: span }, (_, i) => {
    const d = addDays(first, i);
    return { start: d.getTime(), end: addDays(d, 1).getTime(), label: dateKey(d) };
  });
}
