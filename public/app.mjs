import { time, kyivDate, stateBetween, compareDay, readAddresses } from './overlap.mjs';
import { API_BASE } from './config.mjs';
import streets from './streets.mjs';

const $ = id => document.getElementById(id);
const labels = { on: 'On', off: 'Off', unknown: 'Unknown' };
const storageKey = 'power-overlap-addresses-v1';
const fields = [];
let schedules = [null, null, null], errors = ['', '', ''], selectedDate = kyivDate(), busy = false, generation = 0;
let savedAddresses;
try { savedAddresses = readAddresses(window.localStorage); } catch { /* Browser storage can be disabled. */ }
let addresses = savedAddresses || Array.from({ length: 3 }, () => ({ name: '', street: '', house: '' }));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function message(text) { $('form-message').textContent = text; $('form-message').hidden = !text; }
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(addresses)); }
  catch { $('storage-note').textContent = 'Browser storage is unavailable. Addresses will not be remembered.'; }
}
async function api(path, params = {}) {
  if (!API_BASE && location.hostname.endsWith('.github.io')) throw new Error('The DTEK lookup service is not connected yet.');
  const response = await fetch(`${API_BASE}${path}?${new URLSearchParams(params)}`, { cache: 'no-store', signal: AbortSignal.timeout(45000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('The schedule service returned an unreadable response. Please try again.'); }
  if (!response.ok) throw new Error(data.error || 'DTEK could not be reached. Please try again.');
  return data;
}
function invalidate() {
  generation++;
  schedules = [null, null, null]; errors = ['', '', ''];
  message('Addresses changed. Check again to update the schedules.'); render();
}
function setBusy(value) { busy = value; for (const id of ['check', 'samples', 'forget']) $(id).disabled = value; $('check').textContent = value ? 'Checking DTEK…' : 'Find shared time ↗'; $('address-form').setAttribute('aria-busy', String(value)); }

for (let i = 0; i < 3; i++) {
  const group = el('fieldset', 'friend');
  group.append(el('legend', '', `Address ${i + 1}`));
  const inputs = {};
  function input(key, label, placeholder, required, list) {
    const field = el('label', `field ${key === 'name' ? 'name-field' : ''}`, label);
    const control = el('input');
    control.id = `${key}-${i}`; control.name = `${key}-${i}`; control.placeholder = placeholder; control.value = addresses[i][key]; control.required = required; control.autocomplete = 'off'; control.maxLength = key === 'name' ? 60 : key === 'street' ? 200 : 30;
    control.setAttribute('aria-label', `Address ${i + 1} ${label}`);
    if (list) control.setAttribute('list', `${key}-list-${i}`);
    control.addEventListener('input', () => { addresses[i][key] = control.value; if (key === 'street') { addresses[i].house = ''; inputs.house.value = ''; } save(); invalidate(); });
    field.append(control); inputs[key] = control; return field;
  }
  const addressFields = el('div', 'address-fields');
  addressFields.append(input('street', 'Street', 'Start typing in Ukrainian', true, true), input('house', 'Building', 'No.', true, false));
  group.append(addressFields);
  const streetList = el('datalist');
  streetList.id = `street-list-${i}`; group.append(streetList);
  inputs.street.addEventListener('input', () => {
    const q = inputs.street.value.trim().toLocaleLowerCase('uk');
    streetList.replaceChildren(...(q.length < 2 ? [] : streets.filter(street => street.toLocaleLowerCase('uk').includes(q)).slice(0, 40)).map(value => { const option = el('option'); option.value = value; return option; }));
  });
  fields.push(inputs); $('friends').append(group);
}

function name(i) { return `Address ${i + 1}`; }
function dateLabel(date) { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Kyiv' }).format(new Date(`${date}T12:00:00Z`)); }
function dateName(date) {
  const today = kyivDate();
  const next = new Date(`${today}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return date === today ? 'Today' : date === next.toISOString().slice(0, 10) ? 'Tomorrow' : dateLabel(date);
}
function duration(minutes) { return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} h ` : ''}${minutes % 60 ? `${minutes % 60} min` : ''}`.trim(); }
function render() {
  const dates = [...new Set([kyivDate(), ...schedules.flatMap(s => s?.days?.map(d => d.date) ?? [])])].filter(d => d >= kyivDate()).sort();
  if (!dates.includes(selectedDate)) selectedDate = dates[0];
  $('date-tabs').replaceChildren(...dates.map(date => {
    const b = el('button', 'date-tab'); b.type = 'button'; b.setAttribute('aria-pressed', String(date === selectedDate)); b.append(el('strong', '', dateName(date)), el('span', '', dateLabel(date))); b.addEventListener('click', () => { selectedDate = date; render(); }); return b;
  }));
  const { rows, windows } = compareDay(schedules, selectedDate);
  const hasResult = schedules.some(Boolean), allLoaded = schedules.every(Boolean);
  const allPublished = schedules.every(s => s?.days?.some(d => d.date === selectedDate && d.slots?.length));
  const root = $('windows'); root.replaceChildren();
  if (windows.length && allLoaded && allPublished) {
    const list = el('div', 'window-list');
    for (const w of windows) { const chip = el('div', 'window-chip'); chip.append(el('strong', '', `${time(w.start)} – ${time(w.end)}`), el('span', '', duration(w.end - w.start))); list.append(chip); }
    root.append(list);
  } else {
    const empty = el('div', 'empty'); empty.append(el('span', 'empty-icon', '◷'));
    const copy = el('div');
    let title = 'Enter three addresses to compare.', detail = '';
    if (errors.some(Boolean)) { title = 'Waiting for all three schedules.'; detail = 'A schedule could not be verified. See the address tables below, then try again.'; }
    else if (hasResult && !allPublished) { title = 'A schedule is not published for this date.'; detail = 'Shared windows appear only when DTEK provides all three schedules.'; }
    else if (allLoaded) { title = 'No shared power-on window on this date.'; detail = 'Try another published date or check again after DTEK updates the schedules.'; }
    copy.append(el('strong', '', title)); if (detail) copy.append(el('p', '', detail)); empty.append(copy); root.append(empty);
  }
  const fetched = schedules.map(s => s?.fetchedAt).filter(Boolean).sort().at(-1);
  $('result-meta').hidden = !fetched;
  if (fetched) $('result-meta').textContent = `Checked ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(new Date(fetched))} Kyiv time · Only published power-on periods count. Recheck before playing.`;
  $('schedule-date').textContent = `${dateLabel(selectedDate)} · Kyiv time`;
  const timeline = $('timeline'); timeline.replaceChildren(el('span'));
  for (let hour = 0; hour < 24; hour += 2) timeline.append(el('span', 'tick', time(hour * 60)));
  for (const [label, slots] of [['Shared (all three)', windows.map(w => ({ ...w, state: 'on' }))], ...rows.map((row, i) => [name(i), row])]) {
    timeline.append(el('span', `timeline-label ${label === 'Shared (all three)' ? 'shared' : ''}`, label));
    for (let start = 0; start < 1440; start += 30) {
      const state = stateBetween(slots, start, start + 30), cell = el('span', `cell ${state}`);
      const text = `${label}: ${time(start)}–${time(start + 30)}, ${labels[state]}`;
      cell.title = text; cell.setAttribute('aria-hidden', 'true'); timeline.append(cell);
    }
  }
  $('tables').replaceChildren(...rows.map((slots, i) => {
    const card = el('article', 'schedule-card'); card.append(el('h3', '', `${name(i)} schedule`));
    card.append(el('p', 'address', addresses[i].street ? `${addresses[i].street}${addresses[i].house ? `, ${addresses[i].house}` : ''}` : 'No address added yet'));
    const table = el('table'); table.append(el('caption', 'sr-only', `${name(i)} power schedule for ${dateLabel(selectedDate)}`));
    const head = el('thead'), tr = el('tr'); for (const title of ['Time', 'Power']) { const th = el('th', '', title); th.scope = 'col'; tr.append(th); } head.append(tr); table.append(head);
    const body = el('tbody');
    const points = [...new Set([0, 1440, ...slots.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
    const merged = [];
    for (let j = 0; j < points.length - 1; j++) { const start = points[j], end = points[j + 1], state = stateBetween(slots, start, end); const prev = merged.at(-1); if (prev?.state === state && prev.end === start) prev.end = end; else merged.push({ start, end, state }); }
    for (const slot of merged) { const row = el('tr'); row.append(el('td', '', `${time(slot.start)} – ${time(slot.end)}`), el('td', `state-${slot.state}`, labels[slot.state])); body.append(row); }
    table.append(body); card.append(table);
    if (errors[i]) card.append(el('p', 'card-note card-error', errors[i]));
    else if (schedules[i]?.warning) card.append(el('p', 'card-note', schedules[i].warning));
    else if (schedules[i] && !slots.length) card.append(el('p', 'card-note', 'DTEK has not published this date.'));
    return card;
  }));
}

async function check() {
  if (busy || !$('address-form').reportValidity()) return;
  addresses = addresses.map(a => ({ name: a.name.trim(), street: a.street.trim(), house: a.house.trim() })); save();
  const version = ++generation; schedules = [null, null, null]; errors = ['', '', '']; setBusy(true); message('Fetching the latest published schedules from DTEK…'); render();
  try {
    const data = await api('/api/schedules', { addresses: JSON.stringify(addresses.map(({ street, house }) => ({ street, house }))) });
    if (!Array.isArray(data.results) || data.results.length !== 3) throw new Error('DTEK returned an unsupported schedule.');
    if (generation === version) {
      data.results.forEach((result, i) => {
        if (result.ok && Array.isArray(result.days) && result.fetchedAt) schedules[i] = result;
        else errors[i] = result.error || 'This schedule is not available.';
      });
      render();
    }
    if (generation === version) message(errors.some(Boolean) ? 'Some schedules could not be verified. Shared windows require all three. Please try again.' : '');
  } catch (error) {
    if (generation === version) {
      const detail = error.name === 'TimeoutError' ? 'DTEK took too long to respond. Try again shortly.' : error.message;
      errors = Array(3).fill(detail); message(detail); render();
    }
  } finally { setBusy(false); }
}
$('address-form').addEventListener('submit', e => { e.preventDefault(); check(); });
$('forget').addEventListener('click', () => {
  generation++; try { localStorage.removeItem(storageKey); } catch { /* Storage can be disabled. */ }
  addresses = Array.from({ length: 3 }, () => ({ name: '', street: '', house: '' }));
  fields.forEach(group => Object.values(group).forEach(input => { input.value = ''; })); schedules = [null, null, null]; errors = ['', '', '']; message('Saved addresses cleared.'); render();
});
$('samples').addEventListener('click', async () => {
  if (busy) return;
  addresses = ['вул. Хрещатик', 'вул. Саксаганського', 'вул. Ревуцького'].map(street => ({ name: '', street, house: '1' }));
  fields.forEach((group, i) => { for (const key of ['street', 'house']) group[key].value = addresses[i][key]; });
  save(); invalidate(); await check();
});
render();
if (addresses.every(a => a.street && a.house)) check();
