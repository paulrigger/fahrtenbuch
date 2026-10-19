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
const VERSION = '2.5';
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
    if (action === 'expenses') { ensureRecurring_(); return expensesResponse_(); }
    if (action === 'stats') return statsResponse_();
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
    if (['addOrder', 'changeOrderAmount', 'endOrder', 'confirmDraft'].indexOf(d.action) >= 0) {
      return orderAction_(d.action, d, checkDriver_(d.driver));
    }
    if (['settle', 'confirmSettlement', 'cancelSettlement'].indexOf(d.action) >= 0) {
      return settlementAction_(d.action, d, checkDriver_(d.driver));
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
const EXP_COLS = 20;   // S = Abrechnungs-ID, T = Dauerauftrag (ID@Fälligkeit)
const CATEGORIES = ['Tanken', 'Versicherung', 'Service', 'Reifen', 'Schaden', 'Sonstiges', 'Laden'];   // inkl. Altdaten
// Manuell erfassbar (Versicherung nur über Daueraufträge)
const NEW_CATEGORIES = { 'Julia Brettner': ['Tanken', 'Service', 'Schaden', 'Sonstiges'],
                         'Schwitzkarre':   ['Service', 'Schaden', 'Sonstiges'] };
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
  if (v instanceof Date) return '50:50';                 // Sheets hat "50:50" als Uhrzeit gelesen
  const s = String(v == null ? '' : v).trim(), l = s.toLowerCase();
  if (s === '' || l === '50:50' || l === '50:50:00' || l === 'je zur hälfte') return '50:50';
  if (l === 'km' || l === 'nach km') return 'km';
  if (l === 'fix') return 'fix';
  return hhCode_(s.replace(/^nur\s+/i, '')) || s;
}
/** so steht die Aufteilung im Sheet (Text, den Sheets nicht umdeutet) */
function splitLabel_(c) {
  if (c === 'PK' || c === 'TM') return 'nur ' + HH_LABELS[c];
  if (c === '50:50') return 'je zur Hälfte';
  if (c === 'km') return 'nach km';
  return c;
}

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
      status: String(r[12] || 'offen'), settlement: String(r[18] || ''), order: String(r[19] || ''), createdBy: String(r[13] || ''), changedBy: String(r[14] || ''),
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
  const open = exps.filter(function (e) { return e.status === 'offen'; });
  const saldo = Math.round(open.reduce(function (a, e) { return a + e.balance; }, 0) * 100) / 100;
  exps.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.row < b.row ? 1 : -1); });
  return {
    ok: true,
    expenses: exps.map(function (e) { delete e.row; return e; }),
    saldo: saldo,                                   // + = TM schuldet PK, − = PK schuldet TM
    saldoProvisional: open.some(function (e) { return e.provisional; }),
    tankWindow: meta.tankWindow,
    categories: NEW_CATEGORIES,
    orders: ordersView_(),
    settlements: readSettlements_().filter(function (x) { return x.status === 'offen'; }).map(function (x) { delete x.row; return x; })
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
    status: x.status ? String(x.status) : 'offen'
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
      if (hit.status !== 'offen') throw new Error('Buchungen in einer Abrechnung können nicht gelöscht werden.');
      if (hit.order) throw new Error('Diese Buchung stammt aus einem Dauerauftrag – Betrag dort ändern oder den Auftrag beenden.');
      sh.deleteRow(hit.row);
      return { id: hit.id, mode: 'deleted' };
    }
    // updateExpense
    const x = d.expense || {};
    if (hit.status !== 'offen') throw new Error('Buchungen in einer Abrechnung können nicht geändert werden.');
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

// ================================================================ Abrechnungen (v2.3)
//
// Tab "Abrechnungen": A ID | B Erstellt am | C Erstellt von | D Von (zahlt) | E An (erhält) | F Betrag
//                     G Anzahl Buchungen | H Status (offen/bestätigt/zurückgezogen) | I Erledigt am | J Erledigt von
// Ablauf: zahlende Partei löst "settle" aus -> alle offenen Buchungen bekommen Status "in Abrechnung"
//         + Abrechnungs-ID (Spalte S), km-Anteile werden fixiert. Empfänger bestätigt -> "abgerechnet".
//         Zahlende Partei kann zurückziehen -> Buchungen wieder "offen".

const SET_SHEET = 'Abrechnungen';
const SET_HEAD = ['ID', 'Erstellt am', 'Erstellt von', 'Von (zahlt)', 'An (erhält)', 'Betrag', 'Anzahl Buchungen',
                  'Status', 'Erledigt am', 'Erledigt von'];

function setSheet_() {
  let sh = ss_().getSheetByName(SET_SHEET);
  if (!sh) {
    sh = ss_().insertSheet(SET_SHEET);
    sh.getRange(1, 1, 1, SET_HEAD.length).setValues([SET_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readSettlements_() {
  const sh = ss_().getSheetByName(SET_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const tz = Session.getScriptTimeZone();
  const f = function (v) { return v instanceof Date ? Utilities.formatDate(v, tz, 'dd.MM.yyyy') : String(v || ''); };
  return sh.getRange(2, 1, sh.getLastRow() - 1, SET_HEAD.length).getValues().map(function (r, i) {
    return { row: i + 2, id: String(r[0]), created: f(r[1]), createdBy: String(r[2]), from: hhCode_(r[3]), to: hhCode_(r[4]),
             amount: num_(r[5]) || 0, count: num_(r[6]) || 0, status: String(r[7] || 'offen'),
             doneAt: f(r[8]), doneBy: String(r[9] || '') };
  }).filter(function (x) { return x.id; });
}

function settlementAction_(action, d, driver) {
  const me = HOUSEHOLDS[driver];
  const res = withLock_(function () {
    const ex = expSheet_();
    if (action === 'settle') {
      const exps = readExpenses_();
      allocate_(exps);
      const open = exps.filter(function (e) { return e.status === 'offen'; });
      const saldo = Math.round(open.reduce(function (a, e) { return a + e.balance; }, 0) * 100) / 100;
      if (!open.length || Math.abs(saldo) < 0.01) throw new Error('Es gibt keinen offenen Saldo.');
      const from = saldo > 0 ? 'TM' : 'PK', to = saldo > 0 ? 'PK' : 'TM';
      if (me !== from) throw new Error('Abrechnen kann nur die zahlende Seite (' + HH_LABELS[from] + ').');
      const id = 'R' + new Date().getTime().toString(36).toUpperCase();
      // Buchungen markieren; km-Anteile fixieren, damit sich die Abrechnung später nicht mehr verschiebt
      open.forEach(function (e) {
        if (e.split === 'km') {
          ex.getRange(e.row, 7, 1, 2).setValues([['fix', e.share]]);
        }
        ex.getRange(e.row, 13).setValue('in Abrechnung');
        ex.getRange(e.row, 19).setValue(id);
      });
      setSheet_().appendRow([id, new Date(), driver, HH_LABELS[from], HH_LABELS[to], Math.abs(saldo), open.length, 'offen', '', '']);
      return { id: id, mode: 'settled', amount: Math.abs(saldo), from: from, to: to };
    }
    const st = readSettlements_().filter(function (x) { return x.id === String(d.id); })[0];
    if (!st) throw new Error('Abrechnung nicht gefunden.');
    if (st.status !== 'offen') throw new Error('Diese Abrechnung ist bereits erledigt.');
    const rows = readExpenses_().filter(function (e) { return e.settlement === st.id; });
    const sh = setSheet_();
    if (action === 'confirmSettlement') {
      if (me !== st.to) throw new Error('Bestätigen kann nur die empfangende Seite (' + HH_LABELS[st.to] + ').');
      rows.forEach(function (e) { ex.getRange(e.row, 13).setValue('abgerechnet'); });
      sh.getRange(st.row, 8, 1, 3).setValues([['bestätigt', new Date(), driver]]);
      return { id: st.id, mode: 'confirmed' };
    }
    // cancelSettlement
    if (me !== st.from) throw new Error('Zurückziehen kann nur die zahlende Seite (' + HH_LABELS[st.from] + ').');
    rows.forEach(function (e) { ex.getRange(e.row, 13).setValue('offen'); ex.getRange(e.row, 19).setValue(''); });
    sh.getRange(st.row, 8, 1, 3).setValues([['zurückgezogen', new Date(), driver]]);
    return { id: st.id, mode: 'cancelled' };
  });
  writeComputed_();
  const out = expensesResponse_();
  out.result = res;
  return out;
}

// ================================================================ Daueraufträge (v2.4)
//
// Tab "Daueraufträge" – eine Zeile pro Preisstufe, gleiche ID = gleicher Auftrag:
//   A ID | B Fahrzeug | C Kategorie | D Bezeichnung | E Betrag | F Intervall (monatlich/jährlich)
//   G Fällig am Tag | H Fällig im Monat (nur jährlich) | I gültig ab | J gültig bis | K Bezahlt von
//   L Aufteilung | M Jährliche Anpassung am (TT.MM, optional) | N Angelegt von
// Erste Fälligkeit = frühestes "gültig ab". Betrag je Fälligkeit = Stufe mit dem jüngsten "gültig ab" ≤ Fälligkeit.
// Monatlich -> Buchung "offen". Jährlich -> Buchung "Entwurf" (zahlende Seite bestätigt/korrigiert den Betrag).

const ORD_SHEET = 'Daueraufträge';
const ORD_HEAD = ['ID', 'Fahrzeug', 'Kategorie', 'Bezeichnung', 'Betrag', 'Intervall', 'Fällig am Tag', 'Fällig im Monat',
                  'gültig ab', 'gültig bis', 'Bezahlt von', 'Aufteilung', 'Jährliche Anpassung am', 'Angelegt von'];
const ORD_CATEGORIES = ['Versicherung', 'Sonstiges'];

function ordSheet_(create) {
  let sh = ss_().getSheetByName(ORD_SHEET);
  if (!sh && create) {
    sh = ss_().insertSheet(ORD_SHEET);
    sh.getRange(1, 1, 1, ORD_HEAD.length).setValues([ORD_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function iso_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function today_() { return iso_(new Date()); }
function ymd_(s) { const p = String(s).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
function pad_(n) { return ('0' + n).slice(-2); }
function lastDay_(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function due_(y, m, day) { return y + '-' + pad_(m) + '-' + pad_(Math.min(day, lastDay_(y, m))); }

function readOrders_() {
  const sh = ordSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, ORD_HEAD.length).getValues();
  const map = {};
  rows.forEach(function (r, i) {
    const id = String(r[0] || '').trim();
    if (!id) return;
    const o = map[id] || (map[id] = { id: id, stages: [], until: '' });
    const from = fmtDate_(r[8]);
    o.car = String(r[1]); o.cat = String(r[2] || 'Versicherung'); o.label = String(r[3] || '');
    o.interval = String(r[5]).toLowerCase().indexOf('j') === 0 ? 'jährlich' : 'monatlich';
    o.day = num_(r[6]) || 1; o.month = num_(r[7]) || null;
    o.payer = hhCode_(r[10]) || 'PK'; o.split = splitCode_(r[11]);
    o.adjust = String(r[12] || '').trim();
    if (r[12] instanceof Date) o.adjust = Utilities.formatDate(r[12], Session.getScriptTimeZone(), 'dd.MM');
    o.createdBy = o.createdBy || String(r[13] || '');
    if (fmtDate_(r[9])) o.until = fmtDate_(r[9]);
    o.stages.push({ row: i + 2, from: from, amount: num_(r[4]) || 0 });
  });
  return Object.keys(map).map(function (k) {
    const o = map[k];
    o.stages.sort(function (a, b) { return a.from < b.from ? -1 : 1; });
    o.start = o.stages[0].from;
    return o;
  });
}

function amountAt_(o, date) {
  let a = null;
  o.stages.forEach(function (st) { if (st.from <= date) a = st.amount; });
  return a == null ? o.stages[0].amount : a;
}

/** alle Fälligkeiten von start bis einschließlich "to" */
function dueDates_(o, to) {
  const out = [], st = ymd_(o.start), end = o.until && o.until < to ? o.until : to;
  if (o.interval === 'jährlich') {
    const mo = o.month || st.m;
    for (let y = st.y; y <= ymd_(end).y + 1; y++) {
      const d = due_(y, mo, o.day);
      if (d >= o.start && d <= end) out.push(d);
    }
  } else {
    let y = st.y, m = st.m;
    for (let i = 0; i < 600; i++) {
      const d = due_(y, m, o.day);
      if (d > end) break;
      if (d >= o.start) out.push(d);
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return out;
}

function nextDue_(o) {
  const t = today_();
  const ds = dueDates_(Object.assign({}, o, { until: '' }), (ymd_(t).y + 2) + '-12-31').filter(function (d) { return d > t; });
  const n = ds[0] || '';
  return o.until && n > o.until ? '' : n;
}

/** legt fehlende Buchungen bis heute an (idempotent über Schlüssel ID@Datum in Spalte T) */
function ensureRecurring_() {
  const orders = readOrders_();
  if (!orders.length) return 0;
  const t = today_();
  const have = {};
  readExpenses_().forEach(function (e) { if (e.order) have[e.order] = true; });
  const todo = [];
  orders.forEach(function (o) {
    dueDates_(o, t).forEach(function (d) {
      const key = o.id + '@' + d;
      if (!have[key]) todo.push({ o: o, d: d, key: key });
    });
  });
  if (!todo.length) return 0;
  withLock_(function () {
    const fresh = {};
    readExpenses_().forEach(function (e) { if (e.order) fresh[e.order] = true; });
    const sh = expSheet_();
    todo.forEach(function (x, i) {
      if (fresh[x.key]) return;
      const o = x.o, draft = o.interval === 'jährlich';
      const id = 'B' + new Date().getTime().toString(36).toUpperCase() + i.toString(36).toUpperCase();
      const row = [id, x.d, o.car, o.cat, amountAt_(o, x.d), HH_LABELS[o.payer], splitLabel_(o.split), '', '', '', '',
                   o.label + (draft ? ' – Betrag prüfen' : ''), draft ? 'Entwurf' : 'offen', 'Dauerauftrag', '', '', '', '', '', x.key];
      sh.appendRow(row);
    });
  });
  writeComputed_();
  return todo.length;
}

function ordersView_() {
  const t = today_();
  return readOrders_().map(function (o) {
    const next = nextDue_(o);
    const cur = amountAt_(o, t < o.start ? o.start : t);
    let remind = false, adjustDate = '';
    if (o.adjust && /^\d{1,2}\.\d{1,2}$/.test(o.adjust) && (!o.until || o.until > t)) {
      const pa = o.adjust.split('.'), ty = ymd_(t).y;
      adjustDate = due_(ty, +pa[1], +pa[0]);
      if (adjustDate <= t) adjustDate = due_(ty + 1, +pa[1], +pa[0]);
      const a = ymd_(adjustDate), monthBefore = new Date(Date.UTC(a.y, a.m - 2, a.d));
      const hasNew = o.stages.some(function (st) { return st.from >= adjustDate; });
      remind = t >= iso_(monthBefore) && !hasNew;
    }
    return { id: o.id, car: o.car, cat: o.cat, label: o.label, interval: o.interval, day: o.day, month: o.month,
             payer: o.payer, split: o.split, amount: cur, next: next, until: o.until, start: o.start,
             adjust: o.adjust, adjustDate: adjustDate, remind: remind,
             stages: o.stages.map(function (s) { return { from: s.from, amount: s.amount }; }) };
  });
}

function orderAction_(action, d, driver) {
  const res = withLock_(function () {
    const now = new Date();
    if (action === 'confirmDraft') {
      const e = readExpenses_().filter(function (x) { return x.id === String(d.id); })[0];
      if (!e || e.status !== 'Entwurf') throw new Error('Entwurf nicht gefunden.');
      if (HOUSEHOLDS[driver] !== e.payer) throw new Error('Bestätigen kann nur ' + HH_LABELS[e.payer] + ' (zahlende Seite).');
      const amt = num_(d.amount);
      if (!(amt > 0)) throw new Error('Bitte einen gültigen Betrag eingeben.');
      const ex = expSheet_();
      ex.getRange(e.row, 5).setValue(amt);
      ex.getRange(e.row, 12).setValue(e.note.replace(/ – Betrag prüfen$/, ''));
      ex.getRange(e.row, 13).setValue('offen');
      ex.getRange(e.row, 15, 1, 2).setValues([[driver, now]]);
      // neuen Betrag als Preisstufe für Folgejahre übernehmen
      const oid = String(e.order).split('@')[0], o = readOrders_().filter(function (x) { return x.id === oid; })[0];
      if (o && Math.abs(amountAt_(o, e.date) - amt) > 0.004) addStage_(o, amt, e.date, driver);
      return { id: e.id, mode: 'draftConfirmed' };
    }
    const sh = ordSheet_(true);
    if (action === 'addOrder') {
      const x = d.order || {};
      if (!CARS[x.car]) throw new Error('Bitte ein Auto wählen.');
      const amt = num_(x.amount); if (!(amt > 0)) throw new Error('Bitte einen gültigen Betrag eingeben.');
      const first = fmtDate_(x.first); if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('Bitte die erste Fälligkeit angeben.');
      const payer = hhCode_(x.payer); if (!payer) throw new Error('Bitte angeben, wer bezahlt.');
      const interval = x.interval === 'jährlich' ? 'jährlich' : 'monatlich';
      const cat = ORD_CATEGORIES.indexOf(x.cat) >= 0 ? x.cat : 'Versicherung';
      const label = String(x.label || '').trim() || (cat + ' ' + x.car);
      const split = x.split ? splitCode_(x.split) : '50:50';
      const adj = String(x.adjust || '').trim();
      if (adj && !/^\d{1,2}\.\d{1,2}\.?$/.test(adj)) throw new Error('Anpassung bitte als TT.MM angeben, z. B. 01.10');
      const f = ymd_(first), id = 'D' + now.getTime().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
      if (readOrders_().some(function (o) { return o.id === id; })) throw new Error('Bitte nochmal speichern.');
      sh.appendRow([id, x.car, cat, label, amt, interval, f.d, interval === 'jährlich' ? f.m : '', first, '',
                    HH_LABELS[payer], splitLabel_(split), adj.replace(/\.$/, ''), driver]);
      return { id: id, mode: 'orderAdded' };
    }
    const o = readOrders_().filter(function (x) { return x.id === String(d.id); })[0];
    if (!o) throw new Error('Dauerauftrag nicht gefunden.');
    if (action === 'changeOrderAmount') {
      const amt = num_(d.amount); if (!(amt > 0)) throw new Error('Bitte einen gültigen Betrag eingeben.');
      const from = fmtDate_(d.from); if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('Bitte „gültig ab" angeben.');
      addStage_(o, amt, from, driver);
      // bereits erzeugte, noch offene Buchungen ab diesem Datum anpassen
      const ex = expSheet_();
      readExpenses_().forEach(function (e) {
        if (e.order && e.order.split('@')[0] === o.id && e.date >= from && (e.status === 'offen' || e.status === 'Entwurf')) {
          ex.getRange(e.row, 5).setValue(amt);
          ex.getRange(e.row, 15, 1, 2).setValues([[driver, now]]);
        }
      });
      return { id: o.id, mode: 'amountChanged' };
    }
    // endOrder
    const until = fmtDate_(d.until) || today_();
    o.stages.forEach(function (st) { sh.getRange(st.row, 10).setValue(until); });
    return { id: o.id, mode: 'ended' };
  });
  ensureRecurring_();
  writeComputed_();
  const out = expensesResponse_();
  out.result = res;
  return out;
}

function addStage_(o, amt, from, driver) {
  const sh = ordSheet_(true);
  const same = o.stages.filter(function (st) { return st.from === from; })[0];
  if (same) { sh.getRange(same.row, 5).setValue(amt); return; }
  sh.appendRow([o.id, o.car, o.cat, o.label, amt, o.interval, o.day, o.interval === 'jährlich' ? (o.month || '') : '', from,
                o.until || '', HH_LABELS[o.payer], splitLabel_(o.split), o.adjust, driver]);
}

// ================================================================ Statistik (v2.5)
// Liefert kompakte Monatswerte; das Frontend aggregiert nach Zeitraum.
//   trips: [{ m:'2026-10', car, p:'Paul', h:'PK', km }]   (Fahrten ohne Datum erben das Datum der Vorzeile)
//   costs: [{ m:'2026-10', car, cat, amount }]          (ohne Entwürfe)

function statsResponse_() {
  const tz = Session.getScriptTimeZone(), agg = {};
  Object.keys(CARS).forEach(function (car) {
    const sh = sheet_(car), n = sh.getLastRow();
    if (n < 2) return;
    let lastM = '';
    sh.getRange(2, 1, n - 1, 5).getValues().forEach(function (r) {
      let m = '';
      if (r[0] instanceof Date) m = Utilities.formatDate(r[0], tz, 'yyyy-MM');
      else if (fmtDate_(r[0])) m = fmtDate_(r[0]).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) lastM = m; else m = lastM;
      const s = num_(r[1]), e = num_(r[2]), h = household_(r[4]);
      if (!m || s == null || e == null || e <= s || e - s > MAX_TRIP_KM || !h) return;
      const p = DRIVERS.filter(function (d) { return String(r[4]).toLowerCase().indexOf(d.toLowerCase()) >= 0; })[0] || h;
      const k = m + '|' + car + '|' + p;
      (agg[k] = agg[k] || { m: m, car: car, p: p, h: h, km: 0 }).km += e - s;
    });
  });
  const costs = {};
  readExpenses_().forEach(function (e) {
    if (e.status === 'Entwurf') return;
    const k = e.date.slice(0, 7) + '|' + e.car + '|' + e.cat;
    (costs[k] = costs[k] || { m: e.date.slice(0, 7), car: e.car, cat: e.cat, amount: 0 }).amount += e.amount;
  });
  return {
    ok: true,
    trips: Object.keys(agg).map(function (k) { return agg[k]; }),
    costs: Object.keys(costs).map(function (k) { const c = costs[k]; c.amount = Math.round(c.amount * 100) / 100; return c; })
  };
}

/** Einmalig im Editor ausführen: schreibt Haushalte im Tab "Buchungen" aus (statt PK/TM) und setzt Überschriften. */
function migrateLabels() {
  withLock_(function () {
    const sh = expSheet_();
    const n = sh.getLastRow();
    sh.getRange(1, 6, 1, 3).setValues([['Bezahlt von', 'Aufteilung', 'Anteil ' + HH_LABELS.PK + ' (fix)']]);
    sh.getRange(1, 17, 1, 4).setValues([['Anteil ' + HH_LABELS.PK + ' (berechnet)',
      'Ausgleich (+ ' + HH_LABELS.TM + ' → ' + HH_LABELS.PK + ' / − umgekehrt)', 'Abrechnung', 'Dauerauftrag']]);
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
