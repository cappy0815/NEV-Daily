/* =====================================================================
   NEV Daily – Trainings- und Hallenplan des Neusser EV fürs Handy
   Datenquelle: Google Sheet "NEV Trainingsplan", ein Tabellenblatt pro
   Monat mit dem Namen "<Monat> <Jahr>" (z. B. "November 2026").
   Layout des Blatts:
     - irgendwo oben: "NEV-Trainingsplan <Monat> <Jahr>" und "Stand TT.MM.JJJJ"
     - Kopfzeile: Spalte C.. = Mannschaften ("U13-Knaben A\nLandesliga")
     - Datenzeilen: Spalte A = Tag (1..31), Spalte B = Wochentag (MO..SO)
   Zellinhalt (mehrzeilig):
     "17.35 - 18.30 K2"           Eiszeit, Kabine K2
     "15.00 - 16.15\nK3/K4/K5"    Eiszeit, Kabinen in Folgezeile
     "18.45 - 19.30 Off-Ice A"    Off-Ice, Raum A
     "18.15 - 19.15\nEissporthalle Moers"  Eiszeit extern
     "LS 15.00 - 15.45" / "TW 11.30 - …"   Laufschule / Torwart
     "H 20.00\nGegner"            Heimspiel,  "A 18.00\nGegner" Auswärtsspiel
     "H 20.30 @ Moers\nGegner", "A 12.45\n@ Ratingen"  Spielort extern
   ===================================================================== */

const CONFIG = {
  SHEET_ID: '1s2QkXiJff1gNqS_ZArzkhFCoRYuKUIdJaWfZAs79Y10',
  // ANNAHME: Im Sheet steht nur die Anfangszeit eines Spiels.
  // Für "Halle belegt" wird diese Dauer angesetzt (Minuten).
  GAME_DURATION_MIN: 150,
  // Lücke zwischen zwei Belegungen bis zu dieser Länge = Eisaufbereitung (meist 15 min)
  MAX_GAP_MIN: 30,
  REFRESH_MS: 5 * 60 * 1000,   // Daten neu laden
  TICK_MS: 30 * 1000,          // "Jetzt"-Anzeige aktualisieren
  // Tabellenblatt mit dem Wochen-Belegungsplan der Stadt (Viertelstunden-Raster,
  // verbundene Zellen = Belegungsblock). Wird per htmlview geladen, weil nur
  // dort die verbundenen Zellen (colspan/rowspan) mitgeliefert werden.
  CITY_GID: '1732916025',
  CACHE_KEY: 'nevDaily.cache.v2',
  TEAM_KEY: 'nevDaily.team',
};

const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const WD_SHEET = ['SO','MO','DI','MI','DO','FR','SA'];
const WD_LONG = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

/* ---------------- Zustand ---------------- */
const state = {
  months: new Map(),      // "2026-10" (Monat 0-basiert) -> {status, stand, teams, entries}
  city: null,             // Belegungsplan Stadt: {status, blocks:[{wd,start,end,label,kind,notes}], notes}
  dayOffset: 0,           // Tag-Ansicht: 0 = heute
  weekOffset: 0,          // Wochen-Ansicht: 0 = aktuelle Woche
  team: safeGet(CONFIG.TEAM_KEY) || '',
  view: 'today',
  lastLoad: null,
  loading: false,
  error: null,
};

/* ---------------- Hilfsfunktionen ---------------- */
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const monthKey = (y, m) => `${y}-${m}`;
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const normTeam = s => s.toLowerCase().replace(/[\s\-–]+/g, ' ').trim();

/* CSV-Parser (RFC 4180, mit Zeilenumbrüchen in Anführungszeichen) */
function parseCSV(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/* ---------------- Zell-Parser ---------------- */
const RE_TRAIN = /^(?:(LS|TW)\s+)?(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2})\s*(.*)$/i;
const RE_GAME = /^(H|A)\s+(\d{1,2})[.:](\d{2})\b\s*(.*)$/;

function classifyPlace(place) {
  if (/off-?\s?ice/i.test(place)) {
    const rooms = place.replace(/off-?\s?ice/i, '').trim().toUpperCase();
    return { type: 'office', label: rooms ? `Off-Ice ${rooms.split('').join('+')}` : 'Off-Ice' };
  }
  if (/\bK\d/i.test(place)) return { type: 'ice', label: place.replace(/\s+/g, ' ') };
  // Extern nur, wenn es nach einem anderen Ort aussieht ("Eissporthalle Moers", "@ Ratingen").
  // Sonstiger Text ("Fotoshooting") ist ein Hinweis zu einer Eiszeit in Neuss.
  if (/@|halle|eisbahn|arena|stadion/i.test(place)) return { type: 'ext', label: place.replace(/^@\s*/, '') };
  return { type: 'ice', label: place };   // ohne Ortsangabe -> Eis (Halle Neuss)
}

function parseCell(raw) {
  const lines = raw.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  const isStart = l => RE_TRAIN.test(l) || RE_GAME.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if ((m = l.match(RE_TRAIN))) {
      let place = m[6].trim();
      if (!place && lines[i + 1] && !isStart(lines[i + 1])) place = lines[++i];
      const p = classifyPlace(place);
      out.push({
        kind: 'training', tag: (m[1] || '').toUpperCase(),
        start: +m[2] * 60 + +m[3], end: +m[4] * 60 + +m[5],
        type: p.type, place: p.label,
      });
    } else if ((m = l.match(RE_GAME))) {
      let extra = m[4].trim(), at = '', opponent = '';
      const atM = extra.match(/@\s*(.+)$/);
      if (atM) { at = atM[1].trim(); extra = extra.slice(0, atM.index).trim(); }
      if (lines[i + 1] && !isStart(lines[i + 1])) {
        const n = lines[++i];
        if (n.startsWith('@')) at = n.slice(1).trim(); else opponent = n;
      }
      const start = +m[2] * 60 + +m[3];
      const home = m[1] === 'H';
      out.push({
        kind: home ? 'home' : 'away', start, end: start + CONFIG.GAME_DURATION_MIN,
        note: extra, opponent, at,
        type: home && !at ? 'game' : 'ext',
      });
    } else if (out.length) {
      // unbekannte Zeile an den vorigen Eintrag hängen statt verwerfen
      const e = out[out.length - 1]; e.extra = e.extra ? `${e.extra} · ${l}` : l;
    } else {
      out.push({ kind: 'info', start: null, end: null, type: 'ext', place: l });
    }
  }
  return out;
}

/* belegt der Eintrag die Halle in Neuss? (Eis oder Off-Ice-Raum) */
const inHall = e => e.type === 'ice' || e.type === 'office' || e.type === 'game';
const onIce = e => e.type === 'ice' || e.type === 'game';

/* ---------------- Laden eines Monatsblatts ---------------- */
function sheetUrl(name, range) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&headers=0` +
    `&sheet=${encodeURIComponent(name)}&range=${range}&_=${Date.now()}`;
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Google Sheets antwortet mit HTTP ${r.status}`);
  return r.text();
}

async function loadMonth(y, m) {
  const name = `${MONTHS[m]} ${y}`;
  // Spalte A oben (Titel + Stand) und der Datenblock getrennt abrufen:
  // gviz verwirft sonst Textzeilen in der Zahlenspalte A.
  const [metaTxt, dataTxt] = await Promise.all([
    fetchText(sheetUrl(name, 'A1:A7')),
    fetchText(sheetUrl(name, 'A1:Z50')),
  ]);
  const metaText = parseCSV(metaTxt).flat().join(' ');
  const rows = parseCSV(dataTxt);

  // Wichtig: Existiert das Blatt nicht, liefert Google stillschweigend das
  // erste Blatt. Erkennung über Wochentage und Titel:
  //  - Wochentag der ersten Datenzeile muss zum angefragten Monat passen.
  //  - Ein abweichender Titel (z. B. kopiertes Blatt, Titel nicht angepasst)
  //    wird toleriert – außer der Monat im Titel beginnt am selben Wochentag,
  //    dann ist nicht unterscheidbar, ob es das Ersatzblatt von Google ist.
  const isDayRow = r => /^\d{1,2}$/.test((r[0] || '').trim()) && WD_SHEET.includes((r[1] || '').trim().toUpperCase());
  const first = rows.findIndex(isDayRow);
  if (first < 1) return { status: 'missing', name };
  const d0 = +rows[first][0];
  if (rows[first][1].trim().toUpperCase() !== WD_SHEET[new Date(y, m, d0).getDay()]) return { status: 'missing', name };

  const titleMatch = metaText.match(/Trainingsplan\s+(\S+)\s+(\d{4})/i);
  if (titleMatch && (titleMatch[1] !== MONTHS[m] || +titleMatch[2] !== y)) {
    const tm = MONTHS.indexOf(titleMatch[1]);
    // tm < 0: Monatsname im Titel nicht lesbar (Tippfehler) -> Blatt akzeptieren
    if (tm >= 0 && new Date(+titleMatch[2], tm, d0).getDay() === new Date(y, m, d0).getDay()) return { status: 'missing', name };
  }

  // Kopfzeile = letzte Zeile mit Inhalt vor der ersten Datenzeile
  let hi = first - 1;
  while (hi > 0 && rows[hi].slice(2).every(c => !c.trim())) hi--;
  const header = rows[hi];
  const teams = [];
  for (let j = 2; j < header.length; j++) {
    const h = (header[j] || '').trim();
    if (!h) continue;
    const parts = h.split('\n').map(s => s.trim()).filter(Boolean);
    let short = parts.shift() || h;
    if (short.endsWith('&') && parts.length) short = `${short} ${parts.shift()}`;
    teams.push({ col: j, id: normTeam(short), name: short, league: parts.join(' ') });
  }

  const entries = [];
  for (let i = first; i < rows.length && isDayRow(rows[i]); i++) {
    const day = +rows[i][0];
    const date = new Date(y, m, day);
    if (date.getMonth() !== m) continue;
    for (const t of teams) {
      const cell = (rows[i][t.col] || '').trim();
      if (!cell) continue;
      for (const e of parseCell(cell)) entries.push({ ...e, date: dateKey(date), team: t.id });
    }
  }
  const stand = (metaText.match(/Stand\s+([\d.]+)/i) || [])[1] || '';
  return { status: 'ok', name, stand, teams, entries };
}

async function ensureMonths(dates, force = false) {
  const need = [...new Set(dates.map(d => monthKey(d.getFullYear(), d.getMonth())))];
  await Promise.all(need.map(async k => {
    const cur = state.months.get(k);
    if (!force && cur && cur.status !== 'error' && !cur.fromCache) return;
    const [y, m] = k.split('-').map(Number);
    try {
      state.months.set(k, await loadMonth(y, m));
    } catch (err) {
      console.error(err);
      if (!cur) state.months.set(k, { status: 'error', name: `${MONTHS[m]} ${y}`, error: err.message });
      state.error = err.message;
    }
  }));
  saveCache();
}

/* ---------------- Belegungsplan Stadt ----------------
   Aufbau: Zeile "Zeit" = Stunden (je 4 Spalten verbunden), Zeile "Tag" =
   Minuten 0/15/30/45. Pro Wochentag ein Zeilenband (Spalte A, verbunden,
   "Montag\n2,0 Std"), darin verbundene Zellen als Belegungsblöcke, z. B.
   "NSK\n(1,3)", "Öffentl.\nOldie-Disco", "Schule". Ziffern in Klammern
   verweisen auf die Fußnoten unter der Tabelle ("1  An Feiertagen …"). */
const WD_PREFIX = { mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 0 };

function cityKind(label) {
  if (/\bNEV\b/i.test(label)) return 'nev';
  if (/\bNSK\b/i.test(label)) return 'nsk';
  if (/öffent/i.test(label)) return 'public';
  if (/kinder/i.test(label)) return 'kita';
  if (/schul/i.test(label)) return 'school';
  return 'other';
}

function parseCityHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('Belegungsplan Stadt: keine Tabelle gefunden');

  // Raster mit colspan/rowspan aufbauen; Zeilenköpfe (<th>) ignorieren
  const grid = [];           // grid[r][c] = {text, cs, rs, r0, c0}
  let r = 0;
  for (const tr of table.querySelectorAll('tr')) {
    const tds = [...tr.children].filter(el => el.tagName === 'TD');
    if (!tds.length) continue;
    grid[r] = grid[r] || [];
    let c = 0;
    for (const td of tds) {
      while (grid[r][c]) c++;
      const cs = +td.getAttribute('colspan') || 1, rs = +td.getAttribute('rowspan') || 1;
      const text = (td.textContent || '').replace(/ /g, ' ').trim();
      const cell = { text, cs, rs, r0: r, c0: c };
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) {
        grid[r + i] = grid[r + i] || [];
        grid[r + i][c + j] = cell;
      }
      c += cs;
    }
    r++;
  }
  const textOf = cell => cell ? cell.text : '';

  const hourRow = grid.findIndex(row => row && /^zeit$/i.test(textOf(row[0])));
  const minRow = grid.findIndex(row => row && /^tag$/i.test(textOf(row[0])));
  if (hourRow < 0 || minRow < 0) throw new Error('Belegungsplan Stadt: Zeitleiste nicht gefunden');
  const nCols = Math.max(...grid.map(row => row ? row.length : 0));
  const colMin = [];
  for (let c = 1; c < nCols; c++) {
    const h = parseInt(textOf(grid[hourRow][c]), 10), m = parseInt(textOf(grid[minRow][c]), 10);
    colMin[c] = Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  }
  const lastCol = colMin.reduce((a, v, i) => (v != null ? i : a), 1);
  const timeAt = c => (c <= lastCol ? colMin[c] : colMin[lastCol] + (c - lastCol) * 15);

  const blocks = [], seen = new Set(), notes = {};
  for (let r = minRow + 1; r < grid.length; r++) {
    const row = grid[r]; if (!row) continue;
    const head = row[0];
    const wd = head ? WD_PREFIX[textOf(head).slice(0, 2).toLowerCase()] : undefined;
    if (wd === undefined) {
      // Fußnoten: Zelle mit einzelner Ziffer, rechts daneben der Text
      for (let c = 1; c < row.length; c++) {
        const cell = row[c]; if (!cell || cell.c0 !== c || cell.r0 !== r) continue;
        if (/^\d$/.test(cell.text)) {
          const nxt = row[c + cell.cs];
          if (nxt && nxt.text) notes[cell.text] = nxt.text.replace(/\s+/g, ' ');
        }
      }
      continue;
    }
    for (let c = 1; c < row.length; c++) {
      const cell = row[c];
      if (!cell || !cell.text || cell.c0 !== c || seen.has(cell)) continue;
      seen.add(cell);
      const start = timeAt(c), end = timeAt(c + cell.cs);
      if (start == null || end == null) continue;
      const refs = (cell.text.match(/\(([\d,\s]+)\)/) || [])[1];
      const label = cell.text.replace(/\(([\d,\s]+)\)/, '').replace(/(\p{Ll})-\s*\n\s*(\p{Ll})/gu, '$1$2').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      blocks.push({ wd, start, end, label, kind: cityKind(label), refs: refs ? refs.split(/[,\s]+/).filter(Boolean) : [] });
    }
  }
  if (!blocks.length) throw new Error('Belegungsplan Stadt: keine Belegungen erkannt');
  blocks.sort((a, b) => a.wd - b.wd || a.start - b.start);
  return { status: 'ok', blocks, notes };
}

async function loadCity(force = false) {
  if (!force && state.city && state.city.status === 'ok' && !state.city.fromCache) return;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/htmlview/sheet?headers=false&gid=${CONFIG.CITY_GID}&_=${Date.now()}`;
    let html = await fetchText(url);
    html = html.replace(/<br\s*\/?>/gi, '\n');
    state.city = parseCityHtml(html);
  } catch (err) {
    console.error(err);
    if (!state.city) state.city = { status: 'error', blocks: [], notes: {} };
  }
}

const CITY_NAMES = { nsk: 'NSK (Kunstlauf)', public: 'Öffentlicher Lauf', school: 'Schule / Kindergarten', nev: 'NEV-Vereinszeit', other: '' };
function cityTitle(b) {
  if (b.kind === 'public') {
    const rest = b.label.replace(/öffent\w*\.?/i, '').trim();
    return rest ? `Öffentlicher Lauf · ${rest}` : 'Öffentlicher Lauf';
  }
  if (b.kind === 'nsk') {
    const rest = b.label.replace(/\bNSK\b/i, '').trim();
    return rest ? `NSK ${rest}` : 'NSK (Kunstlauf)';
  }
  return b.label;
}
function cityBlocksOn(d) {
  return state.city && state.city.status === 'ok' ? state.city.blocks.filter(b => b.wd === d.getDay()) : [];
}

function saveCache() {
  const obj = {};
  for (const [k, v] of state.months) if (v.status === 'ok') obj[k] = v;
  const city = state.city && state.city.status === 'ok' ? state.city : null;
  safeSet(CONFIG.CACHE_KEY, JSON.stringify({ t: Date.now(), months: obj, city }));
}
function loadCache() {
  try {
    const c = JSON.parse(safeGet(CONFIG.CACHE_KEY) || 'null');
    if (!c) return;
    for (const [k, v] of Object.entries(c.months)) state.months.set(k, { ...v, fromCache: true });
    if (c.city) state.city = { ...c.city, fromCache: true };
    state.lastLoad = new Date(c.t);
  } catch { /* Cache defekt -> ignorieren */ }
}

/* ---------------- Datenzugriff ---------------- */
function monthFor(d) { return state.months.get(monthKey(d.getFullYear(), d.getMonth())); }
function entriesOn(d) {
  const mo = monthFor(d);
  return mo && mo.status === 'ok' ? mo.entries.filter(e => e.date === dateKey(d)) : [];
}
function teamInfo(id) {
  for (const mo of state.months.values()) {
    if (mo.status !== 'ok') continue;
    const t = mo.teams.find(t => t.id === id);
    if (t) return t;
  }
  return { id, name: id, league: '' };
}
const teamName = id => teamInfo(id).name;

/* Einträge mit gleicher Zeit + Ort zusammenfassen (z. B. U7 + U9 gemeinsam) */
function groupSlots(list) {
  const map = new Map();
  for (const e of list) {
    const key = e.kind === 'training' ? `t|${e.start}|${e.end}|${e.type}|${e.place}|${e.tag}` : `g|${e.team}|${e.start}|${e.kind}|${e.opponent}`;
    if (!map.has(key)) map.set(key, { ...e, teams: [] });
    map.get(key).teams.push(e.team);
  }
  return [...map.values()].sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999) || (a.end ?? 0) - (b.end ?? 0));
}

/* ---------------- Rendering: Bausteine ---------------- */
function placeBadges(e) {
  if (e.kind === 'home' || e.kind === 'away') {
    const b = [`<span class="badge ${e.kind}">${e.kind === 'home' ? 'Heimspiel' : 'Auswärts'}</span>`];
    if (e.note) b.push(`<span class="badge">${esc(e.note)}</span>`);
    if (e.at) b.push(`<span>in ${esc(e.at)}</span>`);
    if (e.opponent) b.push(`<span>vs. ${esc(e.opponent)}</span>`);
    return b.join('');
  }
  if (e.kind === 'info') return `<span>${esc(e.place)}</span>`;
  const label = { ice: 'Eis', office: 'Off-Ice', ext: 'Extern' }[e.type];
  const b = [`<span class="badge ${e.type}">${label}</span>`];
  if (e.tag) b.push(`<span class="badge">${e.tag === 'LS' ? 'Laufschule' : 'Torwart'}</span>`);
  if (e.type === 'ice' && e.place) b.push(`<span>${esc(e.place)}</span>`);
  if (e.type === 'office' && e.place !== 'Off-Ice') b.push(`<span>Raum ${esc(e.place.replace('Off-Ice ', ''))}</span>`);
  if (e.type === 'ext') b.push(`<span>${esc(e.place)}</span>`);
  if (e.extra) b.push(`<span class="muted">${esc(e.extra)}</span>`);
  return b.join('');
}
function timeHtml(e) {
  if (e.start == null) return '<div class="t">–</div>';
  if (e.kind === 'home' || e.kind === 'away') return `<div class="t">${fmtMin(e.start)}<small>Beginn</small></div>`;
  return `<div class="t">${fmtMin(e.start)}<small>bis ${fmtMin(e.end)}</small></div>`;
}
const teamsHtml = ids => ids.map(id => esc(teamName(id))).join(' + ');

/* ---------------- Rendering: Jetzt ---------------- */
function renderNow() {
  const body = $('#nowBody');
  const today = startOfDay(new Date());
  const mo = monthFor(today);
  if (!mo) { body.innerHTML = '<div class="muted">Lade Plan …</div>'; return; }
  if (mo.status !== 'ok') { body.innerHTML = `<div class="muted">Kein Plan für ${esc(mo.name)} gefunden.</div>`; return; }

  const now = nowMinutes();
  const list = entriesOn(today).filter(e => e.start != null);
  const iceNow = groupSlots(list.filter(e => onIce(e) && e.start <= now && now < e.end));
  const offNow = groupSlots(list.filter(e => e.type === 'office' && e.start <= now && now < e.end));
  const nextIce = groupSlots(list.filter(e => onIce(e) && e.start > now))[0];

  let html = '';
  if (iceNow.length) {
    for (const s of iceNow) {
      const pct = Math.min(100, Math.max(0, (now - s.start) / (s.end - s.start) * 100));
      const what = s.kind === 'home' ? `Heimspiel${s.opponent ? ' vs. ' + esc(s.opponent) : ''}` : esc(s.place || 'Eis');
      html += `<div class="now-team">${teamsHtml(s.teams)}</div>
        <div class="now-meta"><span>${s.kind === 'home' ? 'seit ' + fmtMin(s.start) + ' (Ende geschätzt)' : fmtMin(s.start) + ' – ' + fmtMin(s.end)}</span><span>${what}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>`;
    }
  } else {
    // Kein NEV laut Trainingsplan -> Belegungsplan der Stadt fragen.
    // Reihenfolge: 1. Fremdbelegung laut Stadt (NSK, öffentlich, Schule)
    //              2. Übergang zwischen zwei Belegungen (<= MAX_GAP) = Eisaufbereitung
    //              3. NEV-Block laut Stadt, der im Trainingsplan (noch) nicht belegt ist
    //              4. Keine Belegung
    const cityAll = cityBlocksOn(today);
    const cityNow = cityAll.filter(b => b.kind !== 'nev' && b.start <= now && now < b.end);
    // Tatsächliche Nutzung: NEV laut Trainingsplan + Fremdbelegung laut Stadt.
    // NEV-Blöcke der Stadt zählen nicht – wer sie nutzt, steht im Trainingsplan.
    const uses = [
      ...groupSlots(list.filter(onIce)).map(s => ({ start: s.start, end: s.end, label: teamsHtml(s.teams) + (s.kind === 'home' ? ' (Heimspiel)' : '') })),
      ...cityAll.filter(b => b.kind !== 'nev').map(b => ({ start: b.start, end: b.end, label: esc(cityTitle(b)) })),
    ];
    const prevUse = uses.filter(u => u.end <= now).sort((a, b) => b.end - a.end)[0];
    const nextUse = uses.filter(u => u.start > now).sort((a, b) => a.start - b.start)[0];
    const gapOk = prevUse && nextUse && nextUse.start - prevUse.end <= CONFIG.MAX_GAP_MIN;

    if (!state.city || state.city.status !== 'ok') {
      html += `<div class="now-free">Kein NEV-Training</div><div class="now-meta muted">Belegungsplan Stadt konnte nicht geladen werden.</div>`;
    } else if (cityNow.length) {
      for (const b of cityNow) {
        const pct = Math.min(100, Math.max(0, (now - b.start) / (b.end - b.start) * 100));
        html += `<div class="now-team city-${b.kind}">${esc(cityTitle(b))}</div>
          <div class="now-meta"><span>${fmtMin(b.start)} – ${fmtMin(b.end)}</span></div>
          <div class="bar city"><i style="width:${pct}%"></i></div>`;
      }
      html += `<div class="now-src">laut Belegungsplan Stadt (Wochenplan)</div>`;
    } else if (gapOk) {
      const pct = Math.min(100, Math.max(0, (now - prevUse.end) / (nextUse.start - prevUse.end) * 100));
      html += `<div class="now-team zamboni">Eisaufbereitung</div>
        <div class="now-meta"><span>${fmtMin(prevUse.end)} – ${fmtMin(nextUse.start)}</span><span>danach: ${nextUse.label}</span></div>
        <div class="bar zamboni"><i style="width:${pct}%"></i></div>`;
    } else {
      const nevBlock = cityAll.find(b => b.kind === 'nev' && b.start <= now && now < b.end);
      if (nevBlock) {
        const pct = Math.min(100, Math.max(0, (now - nevBlock.start) / (nevBlock.end - nevBlock.start) * 100));
        const soon = groupSlots(list.filter(e => onIce(e) && e.start > now && e.start < nevBlock.end))[0];
        const hint = soon ? `ab ${fmtMin(soon.start)}: ${teamsHtml(soon.teams)}` : 'im Trainingsplan nicht belegt';
        html += `<div class="now-team">NEV-Vereinszeit</div>
          <div class="now-meta"><span>${fmtMin(nevBlock.start)} – ${fmtMin(nevBlock.end)}</span><span>${hint}</span></div>
          <div class="bar city"><i style="width:${pct}%"></i></div>
          <div class="now-src">laut Belegungsplan Stadt (Wochenplan)</div>`;
      } else {
        html += `<div class="now-free">Keine Belegung</div>
          <div class="now-meta muted">${nextUse ? `ab ${fmtMin(nextUse.start)}: ${nextUse.label}` : 'heute nichts mehr'}</div>`;
      }
    }
  }
  const sub = [];
  if (offNow.length) sub.push(`<div class="row"><span class="k">Off-Ice jetzt</span>${offNow.map(s => `<b>${teamsHtml(s.teams)}</b> · ${esc(s.place)} bis ${fmtMin(s.end)}`).join('<br>')}</div>`);
  if (nextIce) sub.push(`<div class="row"><span class="k">Nächste NEV-Eiszeit</span><b>${fmtMin(nextIce.start)}</b> · ${teamsHtml(nextIce.teams)}${nextIce.kind === 'home' ? ' (Heimspiel)' : ''}</div>`);
  else sub.push(`<div class="row muted">Heute keine weitere NEV-Eiszeit.</div>`);
  html += `<div class="now-sub">${sub.join('')}</div>`;
  body.innerHTML = html;
}

/* ---------------- Rendering: Tagesplan ---------------- */
function dayLabel(d, offset) {
  const base = `${WD_SHEET[d.getDay()].charAt(0)}${WD_SHEET[d.getDay()].charAt(1).toLowerCase()}, ${d.getDate()}. ${MONTHS[d.getMonth()].slice(0, 3)}.`;
  if (offset === 0) return `Heute · ${base}`;
  if (offset === 1) return `Morgen · ${base}`;
  if (offset === -1) return `Gestern · ${base}`;
  return base;
}

function renderDay() {
  const d = addDays(startOfDay(new Date()), state.dayOffset);
  $('#dayTitle').textContent = dayLabel(d, state.dayOffset);
  const ul = $('#dayList');
  const mo = monthFor(d);
  if (!mo) { ul.innerHTML = '<li class="empty">Lade …</li>'; return; }
  if (mo.status === 'missing') { ul.innerHTML = `<li class="empty">Der Plan für ${esc(mo.name)} ist noch nicht online.</li>`; return; }
  if (mo.status === 'error') { ul.innerHTML = `<li class="empty">Plan konnte nicht geladen werden.</li>`; return; }

  const onlyHall = $('#onlyHall').checked;
  let list = entriesOn(d);
  if (onlyHall) list = list.filter(inHall);
  const slots = groupSlots(list);
  // Fremdbelegung (NSK, öffentlicher Lauf, Schule) aus dem Belegungsplan Stadt.
  // NEV-Blöcke daraus werden nicht gezeigt – maßgeblich ist der Trainingsplan.
  if ($('#showCity').checked) {
    for (const b of cityBlocksOn(d)) {
      if (b.kind === 'nev') continue;
      slots.push({ kind: 'city', type: 'city', cityKind: b.kind, start: b.start, end: b.end, label: cityTitle(b), refs: b.refs, teams: [] });
    }
    slots.sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999) || (a.end ?? 0) - (b.end ?? 0));
  }
  if (!slots.length) { ul.innerHTML = `<li class="empty">${onlyHall ? 'Keine Belegung der Halle.' : 'Keine Termine.'}</li>`; return; }

  const isToday = state.dayOffset === 0, now = nowMinutes();
  ul.innerHTML = slots.map(s => {
    const live = isToday && s.start != null && s.start <= now && now < s.end;
    const past = (state.dayOffset < 0) || (isToday && s.end != null && s.end <= now);
    const cls = ['slot', s.type, `k-${s.kind}`, live ? 'live' : '', past && !live ? 'past' : ''].join(' ');
    if (s.kind === 'city') {
      return `<li class="${cls} city-${s.cityKind}">${timeHtml(s)}<div>
        <div class="who">${esc(s.label)}${live ? ' <span class="badge live">jetzt</span>' : ''}</div>
        <div class="where"><span class="badge city">Stadt-Plan</span></div></div></li>`;
    }
    return `<li class="${cls}">${timeHtml(s)}<div>
      <div class="who">${teamsHtml(s.teams)}${live ? ' <span class="badge live">jetzt</span>' : ''}</div>
      <div class="where">${placeBadges(s)}</div></div></li>`;
  }).join('');
}

/* ---------------- Rendering: Mannschaft / Woche ---------------- */
function weekDays() {
  const today = startOfDay(new Date());
  const mon = addDays(today, -((today.getDay() + 6) % 7) + state.weekOffset * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

function fillTeamSelect() {
  const sel = $('#teamSelect');
  const seen = new Map();
  const keys = [...state.months.keys()].sort();
  for (const k of keys) {
    const mo = state.months.get(k);
    if (mo.status === 'ok') for (const t of mo.teams) if (!seen.has(t.id)) seen.set(t.id, t);
  }
  if (state.team && !seen.has(state.team)) seen.set(state.team, teamInfo(state.team));
  const opts = ['<option value="">Mannschaft wählen …</option>'];
  for (const t of seen.values()) opts.push(`<option value="${esc(t.id)}"${t.id === state.team ? ' selected' : ''}>${esc(t.name)}${t.league ? ' – ' + esc(t.league) : ''}</option>`);
  sel.innerHTML = opts.join('');
}

function renderWeek() {
  const days = weekDays();
  const a = days[0], b = days[6];
  const kw = isoWeek(a);
  $('#weekTitle').textContent = `KW ${kw} · ${a.getDate()}.${a.getMonth() + 1}. – ${b.getDate()}.${b.getMonth() + 1}.`;
  const box = $('#weekList');
  if (!state.team) { box.innerHTML = '<div class="empty">Wähle oben eine Mannschaft.</div>'; return; }

  const todayKey = dateKey(new Date());
  const now = nowMinutes();
  box.innerHTML = days.map(d => {
    const mo = monthFor(d);
    let inner;
    if (!mo) inner = '<div class="wnone">Lade …</div>';
    else if (mo.status !== 'ok') inner = `<div class="wnone">Plan ${esc(mo.name)} noch nicht online</div>`;
    else {
      const list = groupSlots(entriesOn(d).filter(e => e.team === state.team));
      inner = list.length ? `<div>${list.map(s => {
        const live = dateKey(d) === todayKey && s.start <= now && now < s.end;
        const time = s.start == null ? '' : (s.kind === 'home' || s.kind === 'away') ? fmtMin(s.start) : `${fmtMin(s.start)} – ${fmtMin(s.end)}`;
        return `<div class="wentry"><span class="t">${time}</span>${live ? ' <span class="badge live">jetzt</span>' : ''}
          <div class="where">${placeBadges(s)}</div></div>`;
      }).join('')}</div>` : '<div class="wnone">frei</div>';
    }
    const hasEntries = !inner.includes('wnone');
    const cls = ['wday', dateKey(d) === todayKey ? 'today' : '', hasEntries ? '' : 'off'].join(' ');
    return `<div class="${cls}"><div class="wd">${WD_SHEET[d.getDay()]}<small>${d.getDate()}.${d.getMonth() + 1}.</small></div>${inner}</div>`;
  }).join('');
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}

/* ---------------- Status / Uhr ---------------- */
function renderStatus() {
  const n = new Date();
  $('#clock').textContent = `${WD_LONG[n.getDay()]}, ${n.getDate()}. ${MONTHS[n.getMonth()]} · ${pad(n.getHours())}:${pad(n.getMinutes())} Uhr`;
  const mo = monthFor(n);
  const parts = [];
  if (mo && mo.stand) parts.push(`Plan ${mo.name}: Stand ${mo.stand}`);
  if (state.lastLoad) parts.push(`geladen ${pad(state.lastLoad.getHours())}:${pad(state.lastLoad.getMinutes())}`);
  if (state.error) parts.push(`⚠ ${state.error}`);
  $('#status').textContent = parts.join(' · ') || '–';
}

function renderAll() {
  renderStatus();
  renderNow();
  renderDay();
  fillTeamSelect();
  renderWeek();
}

/* ---------------- Laden ---------------- */
async function refresh(force = true) {
  if (state.loading) return;
  state.loading = true; state.error = null;
  $('#refreshBtn').classList.add('spin');
  const today = startOfDay(new Date());
  const dates = [today, addDays(today, state.dayOffset), ...weekDays()];
  try {
    await Promise.all([ensureMonths(dates, force), loadCity(force)]);
    saveCache();
    state.lastLoad = new Date();
  } finally {
    state.loading = false;
    $('#refreshBtn').classList.remove('spin');
    renderAll();
  }
}

/* nur nachladen, wenn durch Blättern ein neuer Monat gebraucht wird */
async function ensureVisible() {
  const dates = [addDays(startOfDay(new Date()), state.dayOffset), ...weekDays()];
  const missing = dates.some(d => !monthFor(d) || monthFor(d).fromCache);
  renderAll();
  if (missing) { await ensureMonths(dates); renderAll(); }
}

/* ---------------- Events ---------------- */
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  state.view = btn.dataset.view;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${state.view}`));
  window.scrollTo({ top: 0 });
}));
$('#dayPrev').addEventListener('click', () => { state.dayOffset--; ensureVisible(); });
$('#dayNext').addEventListener('click', () => { state.dayOffset++; ensureVisible(); });
$('#dayTitle').addEventListener('click', () => { state.dayOffset = 0; ensureVisible(); });
$('#weekPrev').addEventListener('click', () => { state.weekOffset--; ensureVisible(); });
$('#weekNext').addEventListener('click', () => { state.weekOffset++; ensureVisible(); });
$('#weekTitle').addEventListener('click', () => { state.weekOffset = 0; ensureVisible(); });
// Standard: aus (alle Termine inkl. Auswärtsspiele). Auswahl wird gemerkt.
$('#onlyHall').checked = safeGet('nevDaily.onlyHall') === '1';
$('#onlyHall').addEventListener('change', e => { safeSet('nevDaily.onlyHall', e.target.checked ? '1' : '0'); renderDay(); });
// Standard: aus. Neuer Schlüssel, damit ein alter gespeicherter Wert nicht greift.
$('#showCity').checked = safeGet('nevDaily.showCity.v2') === '1';
$('#showCity').addEventListener('change', e => { safeSet('nevDaily.showCity.v2', e.target.checked ? '1' : '0'); renderDay(); });
$('#teamSelect').addEventListener('change', e => { state.team = e.target.value; safeSet(CONFIG.TEAM_KEY, state.team); renderWeek(); });
$('#refreshBtn').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!state.lastLoad || Date.now() - state.lastLoad > CONFIG.REFRESH_MS)) refresh(true);
});

/* ---------------- Start ---------------- */
loadCache();
if (state.team) { state.view = 'today'; }
renderAll();
refresh(true);
setInterval(() => { renderStatus(); renderNow(); if (state.dayOffset === 0) renderDay(); }, CONFIG.TICK_MS);
setInterval(() => refresh(true), CONFIG.REFRESH_MS);
