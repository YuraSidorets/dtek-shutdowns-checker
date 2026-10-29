export function time(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function kyivDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function stateBetween(slots, start, end) {
  const touching = slots.filter(s => s.start < end && s.end > start);
  if (touching.some(s => s.state === 'off')) return 'off';
  const known = touching.filter(s => s.state === 'on').sort((a, b) => a.start - b.start);
  if (touching.some(s => s.state !== 'on')) return 'unknown';
  let covered = start;
  for (const slot of known) {
    if (slot.start > covered) return 'unknown';
    covered = Math.max(covered, slot.end);
  }
  return covered >= end ? 'on' : 'unknown';
}

export function compareDay(schedules, date) {
  const rows = Array.from({ length: 3 }, (_, i) => schedules[i]?.days?.find(d => d.date === date)?.slots ?? []);
  const boundaries = [...new Set([0, 1440, ...rows.flatMap(row => row.flatMap(s => [s.start, s.end]))])]
    .filter(v => Number.isFinite(v) && v >= 0 && v <= 1440).sort((a, b) => a - b);
  const windows = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i], end = boundaries[i + 1];
    if (!rows.every(row => stateBetween(row, start, end) === 'on')) continue;
    const previous = windows.at(-1);
    if (previous?.end === start) previous.end = end;
    else windows.push({ start, end });
  }
  return { rows, windows };
}

export function readAddresses(storage) {
  try {
    const saved = JSON.parse(storage.getItem('power-overlap-addresses-v1'));
    if (!Array.isArray(saved) || saved.length !== 3) return null;
    return saved.map((a, i) => ({ name: typeof a?.name === 'string' ? a.name.slice(0, 60) : `Friend ${i + 1}`, street: typeof a?.street === 'string' ? a.street.slice(0, 200) : '', house: typeof a?.house === 'string' ? a.house.slice(0, 30) : '' }));
  } catch { return null; }
}
