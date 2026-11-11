const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.commandLine.appendSwitch('log-level', '3'); // sembunyikan pesan log GPU Chromium yang tidak berbahaya

// ===== PENGATURAN (tersimpan di file, tetap ada setelah aplikasi ditutup) =====
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const settings = {
  roundTime: 120,    // detik per ronde
  restTime: 60,      // detik istirahat
  gamjeomLimit: 5,   // 5 gam-jeom dalam 1 ronde = lawan menang ronde
  pointGapOn: true,
  pointGap: 15,      // selisih poin per ronde (aturan WT: 15)
  maxPoints: 0,      // batas poin maksimal per ronde (0 = nonaktif): mencapainya = menang ronde
  kyeshiTime: 60,    // detik kyeshi
  whistleOn: true,   // peluit saat istirahat selesai (ronde berikutnya mulai)
  ivrQuota: 1,       // jatah IVR coach per pertandingan
  judgeCount: 1,     // 1, 2, atau 3 juri (menentukan pemberi suara Woo-se-girok)
  consensusMs: 1000, // jendela waktu konsensus juri (milidetik)
  eventName: '',     // nama event, tampil di scoreboard
};
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (e) {}
function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch (e) {}
}

// ===== DATA ATURAN =====
const TECH = { punch: 1, trunk: 2, head: 3, 'trunk-turn': 4, 'head-turn': 6 };
// poin teknikal: tambahan untuk tendangan putar (dasar 2 + 2 = 4, dasar 3 + 3 = 6)
const TECH_BONUS = { trunk: 2, head: 3 };
const TECH_BONUS_KEY = { trunk: 'trunk-tech', head: 'head-tech' };

const META = {
  // [kode, nama, pasif?]  Gam-jeom pasif di 10 detik terakhir ronde = 2 poin untuk lawan
  gj: [
    ['umum', 'Umum / lainnya', false],
    ['keluar-garis', 'Keluar garis', true],
    ['jatuh', 'Jatuh', true],
    ['menghindar', 'Menghindar / melarikan diri / menunda', true],
    ['pegang', 'Memegang / mendorong', false],
    ['bawah', 'Tendangan di bawah pinggang', false],
    ['setelah-kalyeo', 'Menyerang setelah Kal-yeo', false],
    ['pukul-kepala', 'Memukul kepala dengan tangan', false],
    ['lutut', 'Lutut / sundulan', false],
    ['lawan-jatuh', 'Menyerang lawan yang jatuh', false],
    ['tidak-sportif', 'Perilaku tidak sportif', false],
    ['kartu-ditolak', 'Kartu teknis ditolak', true],
  ],
  ivr: {
    coach: [
      'Gam-jeom lawan: jatuh / keluar garis / serang setelah Kal-yeo / serang lawan jatuh',
      'Poin teknik (juri)',
      'Gam-jeom terhadap atlet sendiri',
      'Salah identifikasi pelaku pukulan (biru/merah)',
      'Tendangan kepala tidak terhitung (hanya jika Head PSS tidak dipakai)',
    ],
    referee: [
      '5 detik terakhir: jatuh / keluar garis / serang setelah Kal-yeo / serang lawan jatuh',
      'Pura-pura cedera (sebelum Gam-jeom)',
      'Hitungan 8/10, poin kepala tidak keluar',
      'Permintaan Corner Judge',
    ],
    technical: [
      'Masalah waktu',
      'Poin hantu (phantom points)',
      'Salah input scoreboard',
      'Tes PSS',
      'Wasit lupa membatalkan poin setelah Gam-jeom',
    ],
  },
};

// nama hasil pertandingan (dipakai scoreboard dan Record Paper)
META.result = {
  PTF: 'Win by Final Score',
  RSC: 'Referee Stop Contest',
  WDR: 'Withdrawal',
  DSQ: 'Disqualification',
  DQB: 'Disqualification for Unsportsmanlike Behavior',
};

// ===== STATE PERTANDINGAN =====
let nextId = 1;

function newMatch() {
  return {
    category: 'Male -58 kg',
    matchNo: '001',
    chung: { name: 'Hassan Idman', country: 'IRI' },
    hong: { name: 'James Stuart', country: 'GBR' },
    round: 1,
    phase: 'waiting', // waiting | running | paused | rest | tie | kyeshi | ivr | test | ended
    timeLeft: settings.roundTime,
    tenths: 0,        // sepersepuluh detik (0-9), untuk tampilan 10 detik terakhir
    savedTenths: 0,
    events: [],       // log kejadian (sumber semua poin)
    points: { chung: [0, 0, 0], hong: [0, 0, 0] },   // dihitung dari events
    gamjeom: { chung: [0, 0, 0], hong: [0, 0, 0] },  // dihitung dari events
    roundWinner: [null, null, null],
    winner: null,
    endedBy: null,    // 'round' | 'injury' | 'manual'
    resultCode: null, // PTF | RSC | WDR | DSQ | DQB
    uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), // identitas pertandingan ini
    scheduleId: null, // id baris jadwal yang dimuat (jika ada)
    recorded: false,  // hasil sudah masuk riwayat
    savedTime: 0,
    settings,
    meta: META,
    injuryTime: 0,
    ivr: { chung: settings.ivrQuota, hong: settings.ivrQuota },
    ivrBy: null,      // coach yang meminta (khusus IVR coach)
    ivrKind: null,    // 'coach' | 'referee' | 'technical'
    ivrFrom: 'paused',
    ivrTime: 0,
    ivrResult: null,
    ivrResultTime: 0,
    tie: null,
  };
}
let state = newMatch();

// ===== PEMULIHAN OTOMATIS =====
// Kondisi pertandingan disimpan ke file dan dipulihkan saat aplikasi dibuka lagi.
const matchFile = path.join(app.getPath('userData'), 'match-state.json');
let saveTimer = null;

function saveMatchNow() {
  try {
    const data = JSON.stringify({ v: 1, savedAt: Date.now(), state: { ...state, settings: undefined, meta: undefined } });
    fs.writeFileSync(matchFile + '.tmp', data);
    fs.renameSync(matchFile + '.tmp', matchFile);
  } catch (e) {}
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveMatchNow(); }, 500);
}

function loadSavedMatch() {
  try {
    const raw = JSON.parse(fs.readFileSync(matchFile, 'utf8'));
    if (!raw || raw.v !== 1 || !raw.state || !Array.isArray(raw.state.events)) return;
    if (Date.now() - raw.savedAt > 12 * 3600 * 1000) return; // lebih dari 12 jam: anggap sesi baru
    const restored = Object.assign(newMatch(), raw.state, { settings, meta: META });
    restored.restoredFrom = restored.phase;
    if (restored.phase === 'running') restored.phase = 'paused'; // jam tidak langsung jalan
    if (restored.phase === 'test') restored.phase = 'waiting';
    restored.restoredAt = Date.now();
    nextId = restored.events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    state = restored;
  } catch (e) {}
}
loadSavedMatch();
app.on('before-quit', saveMatchNow);

// ===== JADWAL & RIWAYAT HASIL (disimpan di userData/tournament.json) =====
const tournamentFile = path.join(app.getPath('userData'), 'tournament.json');
const tournament = { schedule: [], results: [] };
try { Object.assign(tournament, JSON.parse(fs.readFileSync(tournamentFile, 'utf8'))); } catch (e) {}

function saveTournament() {
  try {
    fs.writeFileSync(tournamentFile + '.tmp', JSON.stringify(tournament));
    fs.renameSync(tournamentFile + '.tmp', tournamentFile);
  } catch (e) {}
}
function broadcastTournament() {
  for (const w of windows) w.webContents.send('tournament', tournament);
}

// buang karakter yang bisa membentuk tag HTML dan batasi panjang (nama/kategori dari Excel atau input)
const clean = (s, max = 60) => String(s == null ? '' : s).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);

// baca baris Excel/CSV (array of array) menjadi daftar pertandingan
function parseSchedule(aoa) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hi = aoa.findIndex((r) => r.some((c) => String(c).trim() !== ''));
  if (hi < 0) return { rows: [], error: 'File kosong.' };
  const idx = {};
  const NO = ['no', 'nomor', 'nomatch', 'nomormatch', 'match', 'matchno', 'partai', 'nopartai', 'nomorpartai', 'urut', 'nourut'];
  aoa[hi].forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const side = /chung|biru|blue/.test(n) ? 'chung' : /hong|merah|red/.test(n) ? 'hong' : '';
    const isCountry = /negara|country|kontingen|dojang|klub|club|team/.test(n);
    let key = null;
    if (side) key = side + (isCountry ? 'Country' : 'Name');
    else if (/kategori|category|kelas|class|divisi/.test(n)) key = 'category';
    else if (NO.includes(n)) key = 'no';
    if (key && idx[key] === undefined) idx[key] = i;
  });
  if (idx.chungName === undefined || idx.hongName === undefined) {
    return { rows: [], error: 'Kolom nama Chung/Hong tidak ditemukan. Judul kolom yang terbaca: ' + aoa[hi].filter(Boolean).join(', ') + '. Coba pakai template.' };
  }
  const cell = (r, k) => (idx[k] === undefined ? '' : clean(r[idx[k]]));
  const rows = [];
  aoa.slice(hi + 1).forEach((r) => {
    const chungName = cell(r, 'chungName');
    const hongName = cell(r, 'hongName');
    if (!chungName && !hongName) return;
    rows.push({
      id: rows.length + 1,
      no: cell(r, 'no') || String(rows.length + 1).padStart(3, '0'),
      category: cell(r, 'category'),
      chungName, chungCountry: cell(r, 'chungCountry'),
      hongName, hongCountry: cell(r, 'hongCountry'),
      status: 'belum', result: '',
    });
  });
  return { rows, error: '' };
}

// satu baris hasil dari pertandingan yang sedang selesai
function buildResultRow() {
  const w = state.winner;
  return {
    uid: state.uid, no: state.matchNo, category: state.category,
    chung: { ...state.chung }, hong: { ...state.hong },
    winner: w, winnerName: w ? state[w].name : '', code: state.resultCode || '',
    rounds: state.round,
    roundsWon: {
      chung: state.roundWinner.filter((x) => x === 'chung').length,
      hong: state.roundWinner.filter((x) => x === 'hong').length,
    },
    points: { chung: [...state.points.chung], hong: [...state.points.hong] },
    gamjeom: { chung: [...state.gamjeom.chung], hong: [...state.gamjeom.hong] },
  };
}

let lastResultJson = '';
function markSchedule(status, text) {
  const r = tournament.schedule.find((x) => x.id === state.scheduleId);
  if (r) { r.status = status; r.result = text || ''; }
}
// hasil masuk riwayat saat pertandingan selesai; dicabut lagi kalau hasilnya dibatalkan
function syncResult() {
  if (state.phase === 'ended') {
    const row = buildResultRow();
    const json = JSON.stringify(row);
    if (state.recorded && json === lastResultJson) return;
    lastResultJson = json;
    const i = tournament.results.findIndex((x) => x.uid === state.uid);
    row.endedAt = i >= 0 ? tournament.results[i].endedAt : Date.now();
    if (i >= 0) tournament.results[i] = row; else tournament.results.push(row);
    state.recorded = true;
    markSchedule('selesai', `${row.winnerName} (${row.code})`);
    saveTournament();
    broadcastTournament();
  } else if (state.recorded) {
    tournament.results = tournament.results.filter((x) => x.uid !== state.uid);
    state.recorded = false;
    lastResultJson = '';
    markSchedule('belum', '');
    saveTournament();
    broadcastTournament();
  }
}

// ===== LOG KEJADIAN & PERHITUNGAN =====
const other = (s) => (s === 'chung' ? 'hong' : 'chung');
const cur = () => state.round - 1;
const wins = (s) => state.roundWinner.filter((w) => w === s).length;
// aktif hanya saat waktu sudah di bawah 10,00 detik (mulai 9,99)
const inLast10 = () => state.timeLeft < 10;

function recompute() {
  const pts = { chung: [0, 0, 0], hong: [0, 0, 0] };
  const gj = { chung: [0, 0, 0], hong: [0, 0, 0] };
  for (const e of state.events) {
    const r = e.round - 1;
    if (e.kind === 'score') pts[e.side][r] += e.pts;
    else if (e.kind === 'gj') { gj[e.side][r] += 1; pts[other(e.side)][r] += e.pts; }
  }
  state.points = pts;
  state.gamjeom = gj;
}

function logEvent(ev) {
  state.events.push({ id: nextId++, round: state.round, t: state.timeLeft, ...ev });
  recompute();
}

function addScore(side, tech, note) {
  logEvent({ kind: 'score', side, tech, pts: TECH[tech], note });
}

// side = atlet yang DIKENAI gam-jeom
// passive = true: Gam-jeom tetap tercatat 1, tetapi lawan mendapat 2 poin
function addGamjeom(side, passive, note) {
  logEvent({ kind: 'gj', side, passive: !!passive, pts: passive ? 2 : 1, note });
}

// tendangan dasar (badan/kepala) terakhir sisi ini di ronde ini yang belum punya teknikal
function pendingBase(side, kind) {
  const linked = new Set(state.events.filter((e) => e.base).map((e) => e.base));
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i];
    if (e.round === state.round && e.kind === 'score' && e.side === side && e.tech === kind && !linked.has(e.id)) return e;
  }
  return null;
}

function addTechnical(side, kind, note) {
  const base = pendingBase(side, kind);
  if (!base) return false;
  logEvent({
    kind: 'score', side, tech: TECH_BONUS_KEY[kind], pts: TECH_BONUS[kind], base: base.id,
    note: note || (kind === 'head' ? 'putar kepala' : 'putar badan'),
  });
  return true;
}

function removeEvent(id) {
  const idx = state.events.findIndex((e) => e.id === id && e.round === state.round);
  if (idx < 0) return false;
  state.events.splice(idx, 1);
  state.events = state.events.filter((e) => e.base !== id); // teknikal yang menempel ikut terhapus
  recompute();
  return true;
}

// ===== ATURAN RONDE =====
function endRound(winner) {
  state.savedTime = state.timeLeft;
  state.savedTenths = state.tenths;
  state.tenths = 0;
  state.tie = null;
  state.roundWinner[cur()] = winner;
  state.endedBy = 'round';
  if (wins(winner) >= 2) {
    state.phase = 'ended';
    state.winner = winner;
    state.resultCode = 'PTF';
  } else {
    state.phase = 'roundEnd'; // tampilkan pemenang ronde; istirahat dimulai oleh operator
    state.timeLeft = settings.restTime;
  }
}

function checkRound() {
  if (state.phase !== 'running' && state.phase !== 'paused' && state.phase !== 'timeUp') return;
  const i = cur();
  for (const s of ['chung', 'hong']) {
    if (state.gamjeom[s][i] >= settings.gamjeomLimit) return endRound(other(s));
  }
  if (settings.pointGapOn) {
    const gap = state.points.chung[i] - state.points.hong[i];
    if (gap >= settings.pointGap) return endRound('chung');
    if (-gap >= settings.pointGap) return endRound('hong');
  }
  if (settings.maxPoints > 0) {
    const c = state.points.chung[i];
    const h = state.points.hong[i];
    if ((c >= settings.maxPoints || h >= settings.maxPoints) && c !== h) return endRound(c > h ? 'chung' : 'hong');
  }
}

// Jika log dihapus saat ronde sudah selesai, ronde dibuka kembali
function reopenIfNeeded() {
  const p = state.phase;
  if (p === 'roundEnd' || p === 'rest' || p === 'tie' || p === 'ended') {
    state.tie = null;
    state.roundWinner[cur()] = null;
    state.winner = null;
    state.resultCode = null;
    state.endedBy = null;
    state.timeLeft = state.savedTime;
    state.tenths = state.savedTenths || 0;
    // waktu ronde sudah habis -> kembali ke masa edit "waktu habis"; jika belum -> Kal-yeo
    state.phase = state.timeLeft === 0 && state.tenths === 0 ? 'timeUp' : 'paused';
  }
}

// ===== TIEBREAKER (Pasal 15.5) =====
function tieSteps() {
  const ev = state.events.filter((e) => e.round === state.round);
  const sc = (s, f) => ev.filter((e) => e.kind === 'score' && e.side === s && f(e));
  const isTurn = (e) => e.tech.endsWith('-turn');
  const isHead = (e) => e.tech === 'head' || e.tech === 'head-turn';
  const isTrunk = (e) => e.tech === 'trunk' || e.tech === 'trunk-turn';
  const isPunch = (e) => e.tech === 'punch';
  const sum = (s, f) => sc(s, f).reduce((a, e) => a + e.pts, 0);
  const cnt = (s, f) => sc(s, f).length;
  // teknikal + tendangan dasar yang ditempelinya = satu tendangan putar (poin dasar + teknikal)
  const techTurn = (s) => ev.filter((e) => e.kind === 'score' && e.side === s && e.base).reduce((a, e) => {
    const base = ev.find((b) => b.id === e.base);
    return a + e.pts + (base ? base.pts : 0);
  }, 0);
  // poin yang DITERIMA s dari gam-jeom lawan
  const gjp = (s) => ev.filter((e) => e.kind === 'gj' && e.side === other(s)).reduce((a, e) => a + e.pts, 0);
  return [
    { title: 'POIN TENDANGAN PUTAR', chung: sum('chung', isTurn) + techTurn('chung'), hong: sum('hong', isTurn) + techTurn('hong') },
    { title: 'TEKNIK KEPALA (3 POIN)', chung: cnt('chung', isHead), hong: cnt('hong', isHead) },
    { title: 'TEKNIK BADAN (2 POIN)', chung: cnt('chung', isTrunk), hong: cnt('hong', isTrunk) },
    { title: 'TEKNIK PUKULAN (1 POIN)', chung: cnt('chung', isPunch), hong: cnt('hong', isPunch) },
    { title: 'TOTAL POIN DARI GAM-JEOM', chung: gjp('chung'), hong: gjp('hong') },
  ];
}

function startTie() {
  const steps = tieSteps();
  const decided = steps.findIndex((s) => s.chung !== s.hong); // -1 = semua kriteria sama
  state.timeLeft = 0;
  state.tenths = 0;
  state.phase = 'tie';
  state.savedTime = 0;
  state.savedTenths = 0;
  state.tie = {
    steps,
    decided,
    winner: decided >= 0 ? (steps[decided].chung > steps[decided].hong ? 'chung' : 'hong') : null,
    stage: 'summary',   // 'summary' (tabel tampil sebentar) -> 'confirm' (operator konfirmasi) atau 'vote' (Woo-se-girok)
    at: Date.now(),     // saat tabel mulai tampil
    votes: [null, null, null],
  };
}

// waktu ronde habis: ronde belum ditutup, masih ada permintaan coach/wasit yang bisa diproses
function timeUp() {
  state.timeLeft = 0;
  state.tenths = 0;
  state.phase = 'timeUp';
}

// operator mengonfirmasi hasil ronde setelah waktu habis
function finishRound() {
  const i = cur();
  const c = state.points.chung[i];
  const h = state.points.hong[i];
  if (c !== h) return endRound(c > h ? 'chung' : 'hong');
  startTie();
}

// ===== KOREKSI DARI IVR =====
// adj = { side, kind: 'gj'|'punch'|'trunk'|..., sign: 1|-1 }
// untuk kind 'gj', side = atlet yang dikenai gam-jeom
function applyAdjs(adjs) {
  for (const a of adjs) {
    if (a.sign > 0) {
      if (a.kind === 'gj') addGamjeom(a.side, false, 'Koreksi IVR');
      else if (a.kind === 'trunk-tech' || a.kind === 'head-tech') {
        addTechnical(a.side, a.kind === 'head-tech' ? 'head' : 'trunk', 'Koreksi IVR');
      } else if (TECH[a.kind]) addScore(a.side, a.kind, 'Koreksi IVR');
    } else {
      const last = [...state.events].reverse().find((e) =>
        e.round === state.round && e.side === a.side &&
        (a.kind === 'gj' ? e.kind === 'gj' : (e.kind === 'score' && e.tech === a.kind)));
      if (last) removeEvent(last.id);
    }
  }
}

// ===== INPUT JURI (JOYSTICK) =====
// Poin sah jika cukup juri menekan atlet + teknik yang sama dalam jendela waktu.
// 1 juri: langsung sah. 2 atau 3 juri: minimal 2 juri berbeda.
let pendingJudge = []; // { side, tech, judges: [0,1,...], t }

function judgeInput(p) {
  if (state.phase !== 'running') return;
  if (!TECH[p.tech] || (p.side !== 'chung' && p.side !== 'hong')) return;
  const need = settings.judgeCount === 1 ? 1 : 2;
  const now = Date.now();
  pendingJudge = pendingJudge.filter((x) => now - x.t <= settings.consensusMs);
  let item = pendingJudge.find((x) => x.side === p.side && x.tech === p.tech);
  if (!item) {
    item = { side: p.side, tech: p.tech, judges: [], t: now };
    pendingJudge.push(item);
  }
  if (item.judges.includes(p.judge)) return; // juri yang sama menekan lagi: diabaikan
  item.judges.push(p.judge);
  if (item.judges.length >= need) {
    pendingJudge = pendingJudge.filter((x) => x !== item);
    const who = item.judges.map((j) => j + 1).sort().join('+');
    addScore(item.side, item.tech, 'Juri ' + who);
    checkRound();
  }
}

// ===== PERINTAH DARI OPERATOR / JOYSTICK =====
function handle(type, p = {}) {
  const live = state.phase === 'running' || state.phase === 'paused';
  const scoring = live || state.phase === 'timeUp'; // saat waktu habis masih ada permintaan/koreksi
  switch (type) {
    case 'start': // Shijak / Kye-sok
      if (state.phase === 'waiting' || state.phase === 'paused') state.phase = 'running';
      break;
    case 'pause': // Kal-yeo
      if (state.phase === 'running') state.phase = 'paused';
      break;

    case 'score': // p = { side, tech }
      if (scoring && TECH[p.tech]) { addScore(p.side, p.tech); checkRound(); }
      break;
    case 'judge': // dari joystick. p = { judge: 0|1|2, side, tech }
      judgeInput(p);
      break;
    case 'gj': // p = { side (yang dikenai), passive }
      // Gam-jeom pasif hanya sah di 10 detik terakhir ronde
      if (scoring && (!p.passive || inLast10())) {
        addGamjeom(p.side, !!p.passive);
        checkRound();
      }
      break;

    case 'undo':
    case 'del': { // hapus kejadian terakhir / kejadian tertentu (p = { id })
      const okPhase = ['running', 'paused', 'timeUp', 'roundEnd', 'rest', 'tie'].includes(state.phase) ||
        (state.phase === 'ended' && state.endedBy === 'round');
      if (!okPhase) break;
      let id = p.id;
      if (type === 'undo') {
        const last = [...state.events].reverse().find((e) =>
          e.round === state.round && (e.kind === 'score' || e.kind === 'gj'));
        id = last ? last.id : null;
      }
      if (id == null || !removeEvent(id)) break;
      reopenIfNeeded();
      checkRound();
      break;
    }

    case 'technical': // p = { side, kind: 'trunk'|'head' } tambah teknikal ke tendangan dasar terakhir
      if (['running', 'paused', 'timeUp'].includes(state.phase) && TECH_BONUS[p.kind] &&
          (p.side === 'chung' || p.side === 'hong')) {
        if (addTechnical(p.side, p.kind)) checkRound();
      }
      break;
    case 'unscore': // kurangi poin: hapus kejadian poin terakhir (sisi + teknik sama) di ronde ini
    case 'untechnical': // kurangi teknikal: hapus teknikal terakhir (sisi + jenis) di ronde ini
    case 'ungj': {  // kurangi Gam-jeom: hapus kejadian Gam-jeom terakhir sisi ini
      const okPhase = ['running', 'paused', 'timeUp', 'roundEnd', 'rest', 'tie'].includes(state.phase) ||
        (state.phase === 'ended' && state.endedBy === 'round');
      if (!okPhase) break;
      const found = [...state.events].reverse().find((e) => e.round === state.round && e.side === p.side &&
        (type === 'unscore' ? (e.kind === 'score' && e.tech === p.tech)
          : type === 'untechnical' ? (e.kind === 'score' && e.tech === TECH_BONUS_KEY[p.kind])
          : e.kind === 'gj'));
      if (!found || !removeEvent(found.id)) break;
      reopenIfNeeded();
      checkRound();
      break;
    }

    case 'setTime': // p = { seconds } koreksi waktu
      if (['waiting', 'paused', 'ivr', 'timeUp'].includes(state.phase)) {
        state.timeLeft = Math.max(0, Math.min(5999, Math.floor(Number(p.seconds) || 0)));
        state.tenths = 0;
        // waktu habis tapi ternyata masih ada sisa (masalah waktu): ronde dilanjutkan dari Kal-yeo
        if (state.phase === 'timeUp' && state.timeLeft > 0) state.phase = 'paused';
      }
      break;

    case 'finish': // operator mengonfirmasi hasil ronde setelah waktu habis
      if (state.phase === 'timeUp') finishRound();
      break;
    case 'reopen': // buka kembali ronde yang sudah ditutup (ada permintaan/perbaikan)
      if (['roundEnd', 'rest', 'tie'].includes(state.phase) ||
          (state.phase === 'ended' && state.endedBy === 'round')) reopenIfNeeded();
      break;

    case 'startRest': // operator memulai waktu istirahat setelah pemenang ronde tampil
      if (state.phase === 'roundEnd') state.phase = 'rest';
      break;

    case 'confirmTie': // operator mengonfirmasi hasil tiebreaker
      if (state.phase === 'tie' && state.tie.stage === 'confirm') endRound(state.tie.winner);
      break;

    case 'vote': // Woo-se-girok. p = { voter: 0|1|2, side: 'chung'|'hong'|null }
      if (state.phase === 'tie' && state.tie.stage === 'vote') {
        state.tie.votes[p.voter] = p.side;
        const c = state.tie.votes.filter((v) => v === 'chung').length;
        const h = state.tie.votes.filter((v) => v === 'hong').length;
        if (c >= 2) endRound('chung');
        else if (h >= 2) endRound('hong');
      }
      break;

    case 'kyeshi': // timer cedera / dokter
      if (live) {
        state.phase = 'kyeshi';
        state.injuryTime = settings.kyeshiTime;
        state.injuryExtended = false;
      }
      break;
    case 'kyeshiExtend': // dokter minta tambahan waktu: +1 menit (total maksimal 2 menit), satu kali per Kyeshi
      if (state.phase === 'kyeshi' && !state.injuryExtended) {
        state.injuryTime += settings.kyeshiTime;
        state.injuryExtended = true;
      }
      break;
    case 'resume': // selesai kyeshi -> Kal-yeo
      if (state.phase === 'kyeshi') state.phase = 'paused';
      break;
    case 'injuryWin': // p = { side } lawan tidak bisa lanjut
      if (state.phase === 'kyeshi') {
        state.phase = 'ended';
        state.winner = p.side;
        state.endedBy = 'injury';
        state.resultCode = 'RSC';
      }
      break;

    case 'manualResult': // p = { side: pemenang, code: 'RSC'|'WDR'|'DSQ' }
      if (!['ended', 'test', 'ivr', 'tie'].includes(state.phase) &&
          (p.side === 'chung' || p.side === 'hong') && ['RSC', 'WDR', 'DSQ', 'DQB'].includes(p.code)) {
        state.manualFrom = state.phase === 'running' ? 'paused' : state.phase;
        state.savedTime = state.timeLeft;
        state.savedTenths = state.tenths;
        state.tenths = 0;
        state.phase = 'ended';
        state.winner = p.side;
        state.endedBy = 'manual';
        state.resultCode = p.code;
      }
      break;
    case 'cancelResult': // batalkan hasil manual (salah tekan)
      if (state.phase === 'ended' && state.endedBy === 'manual') {
        state.phase = state.manualFrom || 'paused';
        state.timeLeft = state.savedTime;
        state.tenths = state.savedTenths || 0;
        state.winner = null;
        state.endedBy = null;
        state.resultCode = null;
      }
      break;
    case 'ivr': // p = { kind: 'coach'|'referee'|'technical', side? }
      if (scoring) {
        if (p.kind === 'coach') {
          if (!(state.ivr[p.side] > 0)) break;
          state.ivrBy = p.side;
        } else {
          state.ivrBy = null;
        }
        state.ivrKind = p.kind;
        state.ivrFrom = state.phase;
        state.phase = 'ivr';
        state.ivrTime = 30;
      }
      break;
    case 'ivrCancel': // batal, kuota tidak berkurang
      if (state.phase === 'ivr') {
        state.phase = state.ivrFrom === 'timeUp' && state.timeLeft === 0 ? 'timeUp' : 'paused';
        state.ivrBy = null;
        state.ivrKind = null;
      }
      break;
    case 'ivrDecide': { // p = { result, reason, requester, adjs }
      if (state.phase !== 'ivr') break;
      const kind = state.ivrKind;
      const by = kind === 'coach' ? state.ivrBy : (kind === 'technical' ? (p.requester || 'wasit') : null);
      state.phase = state.ivrFrom === 'timeUp' && state.timeLeft === 0 ? 'timeUp' : 'paused';
      if (p.result === 'accept') applyAdjs(p.adjs || []);
      if (p.result === 'reject') {
        if (kind === 'coach') state.ivr[by] = Math.max(0, state.ivr[by] - 1);
        // kartu teknis ditolak: Gam-jeom untuk atlet coach pemohon (kuota kartu tidak berkurang)
        if (kind === 'technical' && (by === 'chung' || by === 'hong')) {
          addGamjeom(by, inLast10(), 'Kartu teknis ditolak');
        }
      }
      logEvent({ kind: 'ivr', ivrKind: kind, by, result: p.result, reason: p.reason || '' });
      state.ivrResult = { kind, by, result: p.result };
      state.ivrResultTime = 3;
      state.ivrBy = null;
      state.ivrKind = null;
      checkRound();
      break;
    }

    case 'setSettings':
      if ('eventName' in p) p.eventName = clean(p.eventName, 80);
      Object.assign(settings, p);
      saveSettings();
      if (state.phase === 'waiting') {
        state.timeLeft = settings.roundTime;
        if (state.round === 1) state.ivr = { chung: settings.ivrQuota, hong: settings.ivrQuota };
      }
      checkRound();
      break;
    case 'setInfo':
      state.category = clean(p.category);
      state.matchNo = clean(p.matchNo, 20);
      state.chung = { name: clean(p.chungName), country: clean(p.chungCountry, 20) };
      state.hong = { name: clean(p.hongName), country: clean(p.hongCountry, 20) };
      break;
    case 'whistleTest': // tes suara peluit dari Pengaturan
      sendWhistle();
      break;
    case 'reverse': // tukar posisi biru/merah di scoreboard dan operator
      settings.reversed = !settings.reversed;
      saveSettings();
      break;
    case 'delSchedule': { // p = { id } hapus satu baris jadwal (sudah selesai maupun belum dimainkan)
      tournament.schedule = tournament.schedule.filter((r) => r.id !== p.id);
      if (state.scheduleId === p.id) state.scheduleId = null;
      saveTournament();
      broadcastTournament();
      break;
    }
    case 'delSchedules': { // p = { ids: [...] } hapus beberapa baris jadwal yang dicentang
      const ids = new Set(Array.isArray(p.ids) ? p.ids : []);
      tournament.schedule = tournament.schedule.filter((r) => !ids.has(r.id));
      if (ids.has(state.scheduleId)) state.scheduleId = null;
      saveTournament();
      broadcastTournament();
      break;
    }
    case 'addSchedule': { // p = { no, category, chungName, chungCountry, hongName, hongCountry } input manual
      const chungName = clean(p.chungName);
      const hongName = clean(p.hongName);
      if (!chungName || !hongName) break;
      const id = tournament.schedule.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      tournament.schedule.push({
        id,
        no: clean(p.no, 20) || String(tournament.schedule.length + 1).padStart(3, '0'),
        category: clean(p.category),
        chungName, chungCountry: clean(p.chungCountry, 20),
        hongName, hongCountry: clean(p.hongCountry, 20),
        status: 'belum', result: '',
      });
      saveTournament();
      broadcastTournament();
      break;
    }
    case 'delDone': // hapus semua baris jadwal yang sudah selesai
      tournament.schedule = tournament.schedule.filter((r) => r.status !== 'selesai');
      if (!tournament.schedule.some((r) => r.id === state.scheduleId)) state.scheduleId = null;
      saveTournament();
      broadcastTournament();
      break;
    case 'loadMatch': { // p = { id } muat pertandingan dari jadwal (memulai pertandingan baru)
      const row = tournament.schedule.find((r) => r.id === p.id);
      if (!row) break;
      state = newMatch();
      nextId = 1;
      state.category = clean(row.category) || state.category;
      state.matchNo = clean(row.no, 20) || state.matchNo;
      state.chung = { name: clean(row.chungName), country: clean(row.chungCountry, 20) };
      state.hong = { name: clean(row.hongName), country: clean(row.hongCountry, 20) };
      state.scheduleId = row.id;
      break;
    }
    case 'newMatch':
      state = newMatch();
      nextId = 1;
      break;
  }
  broadcast();
}

// ===== TIMER (jalan tiap 1 detik) =====
setInterval(() => {
  if (state.phase === 'rest') {
    state.timeLeft--;
    if (state.timeLeft <= 0) {
      state.round++;
      state.phase = 'waiting';
      state.timeLeft = settings.roundTime;
      if (settings.whistleOn !== false) sendWhistle(); // istirahat selesai: peluit tanda ronde berikutnya
    }
    broadcast();
  } else if (state.phase === 'kyeshi') {
    if (state.injuryTime > 0) state.injuryTime--;
    broadcast();
  }

  // hasil IVR tampil 3 detik di scoreboard
  if (state.ivrResultTime > 0) {
    state.ivrResultTime--;
    if (state.ivrResultTime === 0) state.ivrResult = null;
    broadcast();
  }
}, 1000);

// ===== TIMER RONDE (presisi 0,1 detik, berbasis jam sistem) =====
let lastRun = 0;

function tickRunning() {
  if (state.tenths > 0) state.tenths--;
  else if (state.timeLeft > 0) { state.timeLeft--; state.tenths = 9; }
  if (state.timeLeft === 0 && state.tenths === 0) timeUp();
}

setInterval(() => {
  // tabel tiebreaker tampil 3 detik, lalu operator mengonfirmasi (atau Woo-se-girok jika semua sama)
  if (state.phase === 'tie' && state.tie.stage === 'summary' && Date.now() - state.tie.at >= 3000) {
    state.tie.stage = state.tie.winner ? 'confirm' : 'vote';
    broadcast();
  }
  if (state.phase !== 'running') { lastRun = 0; return; }
  const now = Date.now();
  if (!lastRun) lastRun = now;
  let steps = Math.floor((now - lastRun) / 100);
  if (steps < 1) return;
  lastRun += steps * 100;
  const before = state.timeLeft;
  while (steps-- > 0 && state.phase === 'running') tickRunning();
  // di luar 10 detik terakhir cukup kirim tiap detik; di 10 detik terakhir tiap 0,1 detik
  if (state.phase !== 'running' || state.timeLeft !== before || state.timeLeft <= 10) broadcast();
}, 50);

// ===== JENDELA =====
const windows = [];

function createWindow(file, opts = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, autoplayPolicy: 'no-user-gesture-required' },
    ...opts,
  });
  win.loadFile(file);
  windows.push(win);
  // jendela hanya boleh menampilkan file lokal aplikasi
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => windows.splice(windows.indexOf(win), 1));
  return win;
}

// bunyi peluit di scoreboard (istirahat selesai / tes suara)
function sendWhistle() {
  for (const w of windows) w.webContents.send('whistle');
}

function broadcast() {
  syncResult();
  for (const w of windows) w.webContents.send('state', state);
  scheduleSave();
}

ipcMain.handle('getState', () => state);
ipcMain.handle('getTournament', () => tournament);

// impor jadwal dari Excel / CSV
ipcMain.handle('schedule:import', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(parent, {
    properties: ['openFile'],
    filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (parent) parent.focus();
  if (r.canceled || !r.filePaths.length) return { ok: false, msg: '' };
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(r.filePaths[0]);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    const res = parseSchedule(aoa);
    if (!res.rows.length) return { ok: false, msg: res.error || 'Tidak ada pertandingan yang terbaca.' };
    // pertandingan yang sama (nomor + nama) tetap berstatus selesai
    const key = (x) => `${x.no}|${x.chungName}|${x.hongName}`.toLowerCase();
    const old = new Map(tournament.schedule.map((x) => [key(x), x]));
    res.rows.forEach((x) => {
      const o = old.get(key(x));
      if (o) { x.status = o.status; x.result = o.result; }
    });
    // pertandingan yang sedang dimuat tetap menunjuk baris yang sama setelah jadwal diganti
    const curRow = tournament.schedule.find((x) => x.id === state.scheduleId);
    tournament.schedule = res.rows;
    const again = curRow ? res.rows.find((x) => key(x) === key(curRow)) : null;
    state.scheduleId = again ? again.id : null;
    saveTournament();
    broadcastTournament();
    return { ok: true, msg: `${res.rows.length} pertandingan diimpor.` };
  } catch (err) {
    return { ok: false, msg: 'Gagal membaca file: ' + err.message };
  }
});

// template Excel contoh
ipcMain.handle('schedule:template', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(parent, { defaultPath: 'Template-Jadwal-DSS.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (parent) parent.focus();
  if (r.canceled || !r.filePath) return null;
  try {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      ['No', 'Kategori', 'Chung (Biru)', 'Negara Chung', 'Hong (Merah)', 'Negara Hong'],
      ['001', 'Male -58 kg', 'Nama atlet biru', 'INA', 'Nama atlet merah', 'INA'],
      ['002', 'Female -49 kg', 'Nama atlet biru', 'INA', 'Nama atlet merah', 'INA'],
    ]);
    ws['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 26 }, { wch: 14 }, { wch: 26 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Jadwal');
    XLSX.writeFile(wb, r.filePath);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  } catch (err) { return null; }
});

// ekspor riwayat hasil ke Excel / CSV
ipcMain.handle('results:export', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(parent, {
    defaultPath: 'Hasil-Pertandingan.xlsx',
    filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }],
  });
  if (parent) parent.focus();
  if (r.canceled || !r.filePath) return null;
  try {
    const XLSX = require('xlsx');
    const head = ['No', 'Kategori', 'Chung', 'Negara Chung', 'Hong', 'Negara Hong', 'Pemenang', 'Kode hasil',
      'Ronde menang Chung', 'Ronde menang Hong', 'R1 Chung', 'R1 Hong', 'R2 Chung', 'R2 Hong', 'R3 Chung', 'R3 Hong',
      'Gam-jeom Chung', 'Gam-jeom Hong', 'Selesai'];
    const rows = tournament.results.map((x) => {
      const pt = (s, i) => (i < x.rounds ? x.points[s][i] : '');
      const sum = (a) => a.reduce((p, q) => p + q, 0);
      return [x.no, x.category, x.chung.name, x.chung.country, x.hong.name, x.hong.country, x.winnerName, x.code,
        x.roundsWon.chung, x.roundsWon.hong,
        pt('chung', 0), pt('hong', 0), pt('chung', 1), pt('hong', 1), pt('chung', 2), pt('hong', 2),
        sum(x.gamjeom.chung), sum(x.gamjeom.hong), new Date(x.endedAt).toLocaleString('id-ID')];
    });
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hasil');
    XLSX.writeFile(wb, r.filePath);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  } catch (err) { return null; }
});
ipcMain.on('cmd', (e, type, payload) => handle(type, payload));
ipcMain.on('openDevTest', () => {
  createWindow('devtest.html', { width: 1100, height: 780, backgroundColor: '#000000' });
});
// Record Paper: HTML dari operator dijadikan PDF, lalu disimpan lewat dialog
ipcMain.handle('saveRecord', async (e, html, name) => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dss-')), 'record.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const parent = BrowserWindow.fromWebContents(e.sender);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    const r = await dialog.showSaveDialog(parent, { defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, pdf);
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  } finally {
    win.destroy();
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (e) {}
    if (parent) parent.focus();
  }
});

ipcMain.on('fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  w.setFullScreen(!w.isFullScreen());
});

// ===== SCOREBOARD: jendela terpisah, otomatis layar penuh di layar tambahan (HDMI) =====
let operatorWin = null;
let scoreboardWin = null;

function placeScoreboard() {
  if (!scoreboardWin || scoreboardWin.isDestroyed()) return;
  const { screen } = require('electron');
  const mac = process.platform === 'darwin';
  const isFs = () => (mac ? scoreboardWin.isSimpleFullScreen() : scoreboardWin.isFullScreen());
  const setFs = (on) => (mac ? scoreboardWin.setSimpleFullScreen(on) : scoreboardWin.setFullScreen(on));
  // layar tempat operator berada; scoreboard dikirim ke layar lain kalau ada
  const opDisplay = operatorWin && !operatorWin.isDestroyed()
    ? screen.getDisplayMatching(operatorWin.getBounds())
    : screen.getPrimaryDisplay();
  const target = screen.getAllDisplays().find((d) => d.id !== opDisplay.id);
  if (target) {
    const cur = screen.getDisplayMatching(scoreboardWin.getBounds());
    if (!(isFs() && cur.id === target.id)) {
      setFs(false);
      scoreboardWin.setBounds(target.bounds);
      setFs(true);
    }
  } else if (isFs()) {
    // layar tambahan dicabut: kembali jadi jendela biasa di layar operator
    setFs(false);
    scoreboardWin.setBounds({ x: opDisplay.bounds.x + 120, y: opDisplay.bounds.y + 80, width: 1280, height: 720 });
  }
  // scoreboard tidak boleh mengambil fokus (joystick dan keyboard dibaca oleh jendela operator)
  setTimeout(() => { if (operatorWin && !operatorWin.isDestroyed()) operatorWin.focus(); }, 300);
}

function openScoreboard() {
  if (scoreboardWin && !scoreboardWin.isDestroyed()) {
    if (scoreboardWin.isMinimized()) scoreboardWin.restore();
    scoreboardWin.showInactive();
    placeScoreboard();
    return;
  }
  scoreboardWin = createWindow('scoreboard.html', { show: false });
  scoreboardWin.on('closed', () => { scoreboardWin = null; });
  scoreboardWin.once('ready-to-show', () => { scoreboardWin.showInactive(); placeScoreboard(); });
}
ipcMain.on('openScoreboard', openScoreboard);

// hanya satu salinan aplikasi yang boleh berjalan (kalau tidak, file pemulihan dan jadwal saling menimpa)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (operatorWin && !operatorWin.isDestroyed()) {
    if (operatorWin.isMinimized()) operatorWin.restore();
    operatorWin.focus();
  }
});

app.whenReady().then(() => {
  if (!gotLock) return;
  openScoreboard();
  operatorWin = createWindow('operator.html', { x: 80, y: 60, width: 1100, height: 760 });
  operatorWin.on('closed', () => app.quit()); // pertandingan tersimpan otomatis dan dipulihkan saat dibuka lagi
  // layar HDMI dicolok / dicabut / berubah resolusi
  const { screen } = require('electron');
  ['display-added', 'display-removed', 'display-metrics-changed'].forEach((ev) => {
    screen.on(ev, () => setTimeout(placeScoreboard, 800));
  });
});

app.on('window-all-closed', () => app.quit());