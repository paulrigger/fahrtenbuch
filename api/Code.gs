/**
 * Fahrtenbuch API – v2.2 (eigenes Apps-Script-Projekt, läuft PARALLEL zur bestehenden Web-App)
 *
 * Bereitstellen als Web-App:  Ausführen als: Ich   |   Zugriff: Jeder
 * Einmalig: Funktion setup() ausführen -> API-Key steht im Log (Ausführungsprotokoll).
 *
 * GET  ?key=…&action=all                         -> { ok, version, drivers, cars }
 * POST (text/plain) {key, action:"start", sheet, startKM?, driver}
 *                   {key, action:"end",   sheet, startKM?, endKM, driver}
 *                                                -> { ok, mode, start, end?, distance?, warning?, cars }
 * Fehler immer als { ok:false, error:"…" }
 */

// Sheet-ID kommt aus den Skripteigenschaften (Projekteinstellungen → Skripteigenschaften → SHEET_ID),
// damit der Code ohne private Daten im öffentlichen Repo liegen kann.
function sheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID fehlt – in den Skripteigenschaften eintragen.');
  return id;
}
const VERSION = '2.2';
const MAX_TRIP_KM = 3000;
// Personen und Haushalte kommen aus der Skripteigenschaft HOUSEHOLDS (JSON), z. B.
//   {"Anna":"PK","Ben":"PK","Clara":"TM","David":"TM"}
// Reihenfolge = Reihenfolge in der Namensauswahl. Haushalts-Kürzel: PK und TM.
const HOUSEHOLDS = (function () {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('HOUSEHOLDS') || '{}'); }
  catch (e) { return {}; }
})();
const DRIVERS = Object.keys(HOUSEHOLDS);
const HH_LABELS = ['PK', 'TM'].reduce(function (o, h) {
  o[h] = DRIVERS.filter(function (n) { return HOUSEHOLDS[n] === h; }).join(' & ') || h;
  return o;
}, {});
// Reihenfolge = Anzeigereihenfolge
const CARS = {
  'Schwitzkarre':   { label: 'Schwitzkarre' },
  'Julia Brettner': { label: 'Julia Brettner' }
};

let SS_CACHE = null;
function ss_() { return SS_CACHE || (SS_CACHE = SpreadsheetApp.openById(sheetId_())); }

// ---------------------------------------------------------------- Setup

/** Einmal im Editor ausführen: erzeugt den API-Key und schreibt ihn ins Log. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('API_KEY', key);
  }
  ss_().getName();   // löst die Berechtigungsabfrage für das Sheet aus
  Logger.log('API_KEY: ' + key);
  Logger.log('App-Link: https://paulrigger.github.io/fahrtenbuch/?k=' + key);
}

// ---------------------------------------------------------------- HTTP

function doGet(e) {
  return handle_(function () {
    const p = (e && e.parameter) || {};
    checkKey_(p.key);
    const action = p.action || 'all';
    if (action === 'all') return all_();
    if (action === 'expenses') return expensesResponse_();
    throw new Error('Unbekannte Aktion: ' + action);
  });
}

function doPost(e) {
  return handle_(function () {
    const d = JSON.parse(e.postData.contents || '{}');
    checkKey_(d.key);
    if (['addExpense', 'updateExpense', 'deleteExpense'].indexOf(d.action) >= 0) {
      return expenseAction_(d.action, d, checkDriver_(d.driver));
    }
    if (!CARS[d.sheet]) throw new Error('Unbekanntes Auto: ' + d.sheet);
    const driver = checkDriver_(d.driver);
    let r;
    if (d.action === 'start')      r = startTrip_(d.sheet, d.startKM, driver);
    else if (d.action === 'end')   r = endTrip_(d.sheet, d.endKM, d.startKM, driver);
    else throw new Error('Unbekannte Aktion: ' + d.action);
    r.cars = all_().cars;
    return r;
  });
}

function all_() {
  return { ok: true, version: VERSION, drivers: DRIVERS, sheetUrl: ss_().getUrl(),
           households: HOUSEHOLDS, hhLabels: HH_LABELS, cars: Object.keys(CARS).map(getStatus) };
}

function handle_(fn) {
  let out;
  try { out = fn(); }
  catch (err) { out = { ok: false, error: (err && err.message) ? err.message : String(err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  const k = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!k) throw new Error('API nicht eingerichtet – setup() ausführen.');
  if (!DRIVERS.length) throw new Error('Skripteigenschaft HOUSEHOLDS fehlt.');
  if (key !== k) throw new Error('Ungültiger Zugangsschlüssel. Bitte den Link aus der Gruppe neu öffnen.');
}

function checkDriver_(d) {
  const s = String(d || '').trim();
  const hit = DRIVERS.filter(function (x) { return x.toLowerCase() === s.toLowerCase(); })[0];
  if (!hit) throw new Error('Bitte zuerst auswählen, wer fährt.');
  return hit;
}

function resolveDriver_(driver) { return driver; }   // bereits geprüft

// ---------------------------------------------------------------- Status

function getStatus(sheetName) {
  const st = state_(sheetName);
  const tz = Session.getScriptTimeZone();
  const res = {
    sheet: sheetName,
    label: CARS[sheetName] ? CARS[sheetName].label : sheetName,
    open: st.open,
    driver: st.driver || '',
    date: st.date instanceof Date ? Utilities.formatDate(st.date, tz, 'dd.MM.yyyy') : '',
    startKM: st.startKM,
    endKM: st.endKM,
    distance: st.open ? null : st.endKM - st.startKM,
    lastKM: st.lastKM
  };

  if (sheetName === 'Schwitzkarre') {
    const sh = ss_().getSheetByName('MG5-Data');
    if (sh) {
      sh.getRange('A1:C10').getValues().forEach(function (r) {
        if (r[0] === 'Aktueller Ladezustand') { res.soc = Number(r[1]); res.socUpdated = String(r[2] || ''); }
        if (r[0] === 'Aktuelle Reichweite')   { res.range = Number(r[1]); }
      });
    }
  }
  return res;
}

// ---------------------------------------------------------------- Kernlogik

function startTrip_(sheetName, startKM, driver) {
  return withLock_(function () {
    const sh = sheet_(sheetName);
    const st = state_(sheetName, sh);
    if (st.open) {
      throw new Error('Es ist bereits eine Fahrt offen (' + st.driver + ', Start ' + st.startKM + ' km). Bitte zuerst beenden.');
    }
    const start = isEmpty_(startKM) ? st.lastKM : toKM_(startKM, 'Start-KM');
    const warn = checkStart_(start, st.lastKM);

    sh.getRange(st.row + 1, 1, 1, 5).setValues([[new Date(), start, '', '', resolveDriver_(driver)]]);
    return { ok: true, mode: 'started', sheet: sheetName, start: start, warning: warn };
  });
}

function endTrip_(sheetName, endKM, startKM, driver) {
  return withLock_(function () {
    const sh = sheet_(sheetName);
    const st = state_(sheetName, sh);
    const end = toKM_(endKM, 'End-KM');

    if (st.open) {
      // offene Fahrt beenden (Start optional korrigierbar)
      const start = isEmpty_(startKM) ? st.startKM : toKM_(startKM, 'Start-KM');
      checkTrip_(start, end);
      if (start !== st.startKM) sh.getRange(st.row, 2).setValue(start);
      sh.getRange(st.row, 3).setValue(end);
      setDiffFormula_(sh, st.row);
      return { ok: true, mode: 'closed', sheet: sheetName, start: start, end: end, distance: end - start };
    }

    // keine offene Fahrt -> direkt komplette Fahrt eintragen
    const start = isEmpty_(startKM) ? st.lastKM : toKM_(startKM, 'Start-KM');
    const warn = checkStart_(start, st.lastKM);
    checkTrip_(start, end);
    sh.getRange(st.row + 1, 1, 1, 5).setValues([[new Date(), start, end, '', resolveDriver_(driver)]]);
    setDiffFormula_(sh, st.row + 1);
    return { ok: true, mode: 'direct', sheet: sheetName, start: start, end: end, distance: end - start, warning: warn };
  });
}

// ---------------------------------------------------------------- Helfer

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Blatt nicht gefunden: ' + name);
  return sh;
}

/** letzte Zeile mit Start-KM in Spalte B – robust gegen Formeln in F etc. */
function state_(sheetName, sh) {
  sh = sh || sheet_(sheetName);
  const n = sh.getLastRow();
  let row = 1;
  if (n >= 2) {
    const b = sh.getRange(1, 2, n, 1).getValues();
    for (let i = n - 1; i >= 1; i--) {
      if (b[i][0] !== '' && b[i][0] !== null) { row = i + 1; break; }
    }
  }
  if (row === 1) return { row: 1, open: false, startKM: 0, endKM: 0, lastKM: 0, driver: '', date: null };

  const v = sh.getRange(row, 1, 1, 5).getValues()[0];
  const open = v[2] === '' || v[2] === null;
  const startKM = Number(v[1]);
  const endKM = open ? null : Number(v[2]);
  return { row: row, open: open, date: v[0], startKM: startKM, endKM: endKM,
           lastKM: open ? startKM : endKM, driver: v[4] };
}

function toKM_(v, what) {
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  if (isNaN(n)) throw new Error(what + ' ist keine gültige Zahl: ' + v);
  return n;
}

function checkStart_(start, lastKM) {
  if (start < lastKM) throw new Error('Start-KM (' + start + ') ist kleiner als der letzte Stand (' + lastKM + ').');
  if (start > lastKM) return 'Lücke von ' + (start - lastKM) + ' km seit dem letzten Eintrag.';
  return null;
}

function checkTrip_(start, end) {
  if (end < start) throw new Error('End-KM (' + end + ') ist kleiner als Start-KM (' + start + ').');
  if (end - start > MAX_TRIP_KM) throw new Error('Fahrt mit ' + (end - start) + ' km ist unplausibel (max. ' + MAX_TRIP_KM + ').');
}

/** Spalte D als Formel =Cx-Bx, damit Korrekturen an B/C automatisch durchrechnen */
function setDiffFormula_(sh, row) {
  sh.getRange(row, 4).setFormula('=C' + row + '-B' + row);
}

function isEmpty_(v) { return v === undefined || v === null || String(v).trim() === ''; }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Gerade trägt jemand anderer ein – bitte nochmal versuchen.');
  try { return fn(); }
  finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

// ================================================================ Ausgaben (v2.2)
//
// Tab "Buchungen": A ID | B Datum | C Fahrzeug | D Kategorie | E Betrag | F Bezahlt von (PK/TM)
//   G Aufteilung (km | 50:50 | PK | TM | fix) | H Anteil PK (fix) | I km-Stand | J Liter | K Vollgetankt
//   L Notiz | M Status (offen/abgerechnet) | N Erfasst von | O Geändert von | P Geändert am
//   Q Anteil PK (berechnet) | R Ausgleich (+ TM→PK / − PK→TM)   <- wird von der API geschrieben
//
// Tank-Logik (nur Julia Brettner, Aufteilung "km"):
//   Kosten aller Tankungen zwischen zwei Volltankungen werden nach den km verteilt, die PK bzw. TM
//   zwischen den km-Ständen dieser Volltankungen gefahren sind. Tankungen nach der letzten
//   Volltankung sind "vorläufig" (Vorschau bis zum aktuellen km-Stand).

const EXP_SHEET = 'Buchungen';
const EXP_COLS = 18;
const CATEGORIES = ['Tanken', 'Versicherung', 'Service', 'Reifen', 'Schaden', 'Sonstiges', 'Laden'];
const NEW_CATEGORIES = { 'Julia Brettner': ['Tanken', 'Versicherung', 'Service', 'Reifen', 'Schaden', 'Sonstiges'],
                         'Schwitzkarre':   ['Versicherung', 'Service', 'Reifen', 'Schaden', 'Sonstiges'] };
const SPLITS = ['km', '50:50', 'PK', 'TM', 'fix'];
const TANK_CAR = 'Julia Brettner';

/** Haushalt zu einem Fahrer-Eintrag im Fahrtenbuch (Name oder E-Mail, die den Vornamen enthält) */
function household_(name) {
  const n = String(name || '').toLowerCase();
  for (let i = 0; i < DRIVERS.length; i++) {
    if (n.indexOf(DRIVERS[i].toLowerCase()) >= 0) return HOUSEHOLDS[DRIVERS[i]];
  }
  return null;
}

/** Haushalt-Kürzel (PK/TM) aus Kürzel, ausgeschriebenem Namen ("Katrin & Paul") oder Person */
function hhCode_(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === 'PK' || s === 'TM') return s;
  const l = s.toLowerCase();
  if (HH_LABELS.PK && l === HH_LABELS.PK.toLowerCase()) return 'PK';
  if (HH_LABELS.TM && l === HH_LABELS.TM.toLowerCase()) return 'TM';
  return household_(s);
}
/** Aufteilung lesen/schreiben: km | 50:50 | fix | PK | TM  <->  im Sheet ausgeschrieben */
function splitCode_(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' ) return '50:50';
  if (s === 'km' || s === '50:50' || s === 'fix') return s;
  return hhCode_(s.replace(/^nur\s+/i, '')) || s;
}
function splitLabel_(c) { return (c === 'PK' || c === 'TM') ? 'nur ' + HH_LABELS[c] : c; }

function expSheet_() {
  const sh = ss_().getSheetByName(EXP_SHEET);
  if (!sh) throw new Error('Tab "' + EXP_SHEET + '" fehlt im Sheet.');
  return sh;
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  return s;
}
function num_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[€\s]/g, '');
  if (s === '') return null;
  const n = parseFloat(s.indexOf(',') >= 0 ? s.replace(/\./g, '').replace(',', '.') : s);
  return isNaN(n) ? null : n;
}
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 1; }

function readExpenses_() {
  const sh = expSheet_();
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, EXP_COLS).getValues().map(function (r, i) {
    return {
      row: i + 2, id: String(r[0]), date: fmtDate_(r[1]), car: String(r[2]), cat: String(r[3]),
      amount: num_(r[4]) || 0, payer: hhCode_(r[5]) || String(r[5]), split: splitCode_(r[6]), fixShare: num_(r[7]),
      km: num_(r[8]), liter: num_(r[9]), full: bool_(r[10]), note: String(r[11] || ''),
      status: String(r[12] || 'offen'), createdBy: String(r[13] || ''), changedBy: String(r[14] || ''),
      changedAt: r[15] instanceof Date ? Utilities.formatDate(r[15], Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm') : String(r[15] || '')
    };
  }).filter(function (e) { return e.id; });
}

function readTrips_(sheetName) {
  const sh = sheet_(sheetName);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 2, n - 1, 4).getValues().map(function (r) {
    return { s: num_(r[0]), e: num_(r[1]), hh: household_(r[3]) };
  }).filter(function (t) { return t.s != null && t.e != null && t.e > t.s && t.hh; });
}

/** km je Haushalt im km-Intervall [a, b] (Fahrten anteilig) */
function kmSplit_(trips, a, b) {
  const r = { PK: 0, TM: 0 };
  trips.forEach(function (t) {
    const o = Math.min(t.e, b) - Math.max(t.s, a);
    if (o > 0) r[t.hh] += o;
  });
  return r;
}
function shareOf_(k) { const tot = k.PK + k.TM; return tot > 0 ? k.PK / tot : 0.5; }

/** berechnet share (Anteil PK), provisional, window je Buchung */
function allocate_(exps) {
  const trips = readTrips_(TANK_CAR);
  const lastKM = state_(TANK_CAR).lastKM;
  exps.forEach(function (e) {
    e.provisional = false;
    if (e.split === 'fix') e.share = e.fixShare == null ? 0.5 : e.fixShare;
    else if (e.split === 'PK') e.share = 1;
    else if (e.split === 'TM') e.share = 0;
    else if (e.split === '50:50') e.share = 0.5;
  });
  const tanks = exps.filter(function (e) {
    return e.cat === 'Tanken' && e.car === TANK_CAR && e.km != null && (e.split === 'km' || (e.split === 'fix' && e.full));
  }).sort(function (x, y) { return x.km - y.km || (x.date < y.date ? -1 : 1); });

  let prevFull = null, pending = [];
  tanks.forEach(function (t) {
    if (t.split === 'fix') { prevFull = t.km; pending = []; return; }      // Anker / Altdaten
    pending.push(t);
    if (t.full) {
      const from = prevFull == null ? t.km : prevFull;
      const k = kmSplit_(trips, from, t.km), sh = shareOf_(k);
      pending.forEach(function (p) { p.share = sh; p.window = { from: from, to: t.km, pk: k.PK, tm: k.TM }; });
      prevFull = t.km; pending = [];
    }
  });
  const openFrom = prevFull == null ? lastKM : prevFull;
  const kOpen = kmSplit_(trips, openFrom, lastKM);
  pending.forEach(function (p) {
    p.share = shareOf_(kOpen); p.provisional = true;
    p.window = { from: openFrom, to: lastKM, pk: kOpen.PK, tm: kOpen.TM };
  });
  // km-Tankungen ohne km-Stand
  exps.forEach(function (e) { if (e.share == null) { e.share = 0.5; e.provisional = true; } });
  exps.forEach(function (e) {
    e.share = Math.round(e.share * 10000) / 10000;
    e.balance = Math.round((e.payer === 'PK' ? e.amount * (1 - e.share) : -e.amount * e.share) * 100) / 100;
  });
  return { tankWindow: { from: openFrom, to: lastKM, pk: kOpen.PK, tm: kOpen.TM } };
}

function expensesResponse_() {
  const exps = readExpenses_();
  const meta = allocate_(exps);
  const open = exps.filter(function (e) { return e.status !== 'abgerechnet'; });
  const saldo = Math.round(open.reduce(function (a, e) { return a + e.balance; }, 0) * 100) / 100;
  exps.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.row < b.row ? 1 : -1); });
  return {
    ok: true,
    expenses: exps.map(function (e) { delete e.row; return e; }),
    saldo: saldo,                                   // + = TM schuldet PK, − = PK schuldet TM
    saldoProvisional: open.some(function (e) { return e.provisional; }),
    tankWindow: meta.tankWindow,
    categories: NEW_CATEGORIES
  };
}

function writeComputed_() {
  const exps = readExpenses_();
  if (!exps.length) return;
  allocate_(exps);
  const out = exps.map(function (e) { return [e.share, e.balance]; });
  expSheet_().getRange(2, 17, out.length, 2).setValues(out);
}

function validateExpense_(x) {
  const e = {
    date: fmtDate_(x.date) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    car: String(x.car || ''), cat: String(x.cat || ''), amount: num_(x.amount),
    payer: hhCode_(x.payer) || '', split: x.split ? splitCode_(x.split) : '', km: num_(x.km),
    liter: num_(x.liter), full: bool_(x.full), note: String(x.note || '').slice(0, 300),
    status: x.status === 'abgerechnet' ? 'abgerechnet' : 'offen'
  };
  if (!CARS[e.car]) throw new Error('Bitte ein Auto wählen.');
  if (CATEGORIES.indexOf(e.cat) < 0) throw new Error('Unbekannte Kategorie: ' + e.cat);
  if (!(e.amount > 0) || e.amount > 20000) throw new Error('Bitte einen gültigen Betrag eingeben.');
  if (e.payer !== 'PK' && e.payer !== 'TM') throw new Error('Bitte angeben, wer bezahlt hat.');
  if (e.cat === 'Tanken' && e.car !== TANK_CAR) throw new Error('Tanken gibt es nur bei der Julia Brettner.');
  if (!e.split) e.split = e.cat === 'Tanken' ? 'km' : '50:50';
  if (SPLITS.indexOf(e.split) < 0) throw new Error('Unbekannte Aufteilung: ' + e.split);
  if (e.split === 'km' && e.cat !== 'Tanken') throw new Error('Aufteilung nach km gibt es nur beim Tanken.');
  if (e.split === 'km' && e.km == null) throw new Error('Bitte den km-Stand beim Tanken angeben.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('Ungültiges Datum.');
  return e;
}

function expenseAction_(action, d, driver) {
  const res = withLock_(function () {
    const sh = expSheet_();
    const now = new Date();
    if (action === 'addExpense') {
      const e = validateExpense_(d.expense || {});
      const id = 'B' + now.getTime().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
      if (readExpenses_().some(function (x) { return x.id === id; })) throw new Error('Bitte nochmal speichern.');
      sh.appendRow([id, e.date, e.car, e.cat, e.amount, HH_LABELS[e.payer], splitLabel_(e.split), '', e.km == null ? '' : e.km,
                    e.liter == null ? '' : e.liter, e.cat === 'Tanken' ? e.full : '', e.note, 'offen', driver, '', '']);
      return { id: id, mode: 'added' };
    }
    const exps = readExpenses_();
    const hit = exps.filter(function (x) { return x.id === String(d.id); })[0];
    if (!hit) throw new Error('Buchung nicht gefunden.');
    if (action === 'deleteExpense') {
      if (hit.status === 'abgerechnet') throw new Error('Abgerechnete Buchungen können nicht gelöscht werden.');
      sh.deleteRow(hit.row);
      return { id: hit.id, mode: 'deleted' };
    }
    // updateExpense
    const x = d.expense || {};
    if (hit.status === 'abgerechnet' && x.status !== 'offen') throw new Error('Abgerechnete Buchungen können nicht geändert werden.');
    const e = validateExpense_(Object.assign({}, hit, x));
    const fix = e.split === 'fix' ? (hit.fixShare == null ? 0.5 : hit.fixShare) : '';
    sh.getRange(hit.row, 2, 1, 15).setValues([[e.date, e.car, e.cat, e.amount, HH_LABELS[e.payer], splitLabel_(e.split), fix,
      e.km == null ? '' : e.km, e.liter == null ? '' : e.liter, e.cat === 'Tanken' ? e.full : '',
      e.note, e.status, hit.createdBy, driver, now]]);
    return { id: hit.id, mode: 'updated' };
  });
  writeComputed_();
  const out = expensesResponse_();
  out.result = res;
  return out;
}

/** Einmalig im Editor ausführen: schreibt Haushalte im Tab "Buchungen" aus (statt PK/TM) und setzt Überschriften. */
function migrateLabels() {
  withLock_(function () {
    const sh = expSheet_();
    const n = sh.getLastRow();
    sh.getRange(1, 6, 1, 3).setValues([['Bezahlt von', 'Aufteilung', 'Anteil ' + HH_LABELS.PK + ' (fix)']]);
    sh.getRange(1, 17, 1, 2).setValues([['Anteil ' + HH_LABELS.PK + ' (berechnet)',
      'Ausgleich (+ ' + HH_LABELS.TM + ' → ' + HH_LABELS.PK + ' / − umgekehrt)']]);
    if (n < 2) return;
    const fg = sh.getRange(2, 6, n - 1, 2).getValues().map(function (r) {
      const p = hhCode_(r[0]);
      return [p ? HH_LABELS[p] : r[0], splitLabel_(splitCode_(r[1]))];
    });
    sh.getRange(2, 6, fg.length, 2).setValues(fg);
  });
  writeComputed_();
  Logger.log('Fertig: Haushalte ausgeschrieben.');
}

/** Einmalig/bei Bedarf im Editor ausführen: rechnet Spalten Q/R neu. */
function recomputeExpenses() { writeComputed_(); Logger.log(JSON.stringify(expensesResponse_().saldo)); }
