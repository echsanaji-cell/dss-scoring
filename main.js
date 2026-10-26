const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// ===== PENGATURAN (tersimpan di file, tetap ada setelah aplikasi ditutup) =====
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const settings = {
  roundTime: 120,    // detik per ronde
  restTime: 60,      // detik istirahat
  gamjeomLimit: 5,   // 5 gam-jeom dalam 1 ronde = lawan menang ronde
  pointGapOn: true,
  pointGap: 15,      // selisih poin per ronde (aturan WT: 15)
  kyeshiTime: 60,    // detik kyeshi
  ivrQuota: 1,       // jatah IVR coach per pertandingan
  judgeCount: 1,     // 1, 2, atau 3 juri (menentukan pemberi suara Woo-se-girok)
};
try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch (e) {}
function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings)); } catch (e) {}
}

// ===== DATA ATURAN =====
const TECH = { punch: 1, trunk: 2, head: 3, 'trunk-turn': 4, 'head-turn': 6 };

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

const isPassive = (code) => {
  const r = META.gj.find((x) => x[0] === code);
  return !!(r && r[2]);
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
    events: [],       // log kejadian (sumber semua poin)
    points: { chung: [0, 0, 0], hong: [0, 0, 0] },   // dihitung dari events
    gamjeom: { chung: [0, 0, 0], hong: [0, 0, 0] },  // dihitung dari events
    roundWinner: [null, null, null],
    winner: null,
    endedBy: null,    // 'round' | 'injury'
    savedTime: 0,
    settings,
    meta: META,
    injuryTime: 0,
    ivr: { chung: settings.ivrQuota, hong: settings.ivrQuota },
    ivrBy: null,      // coach yang meminta (khusus IVR coach)
    ivrKind: null,    // 'coach' | 'referee' | 'technical'
    ivrTime: 0,
    ivrResult: null,
    ivrResultTime: 0,
    tie: null,
  };
}
let state = newMatch();

// ===== LOG KEJADIAN & PERHITUNGAN =====
const other = (s) => (s === 'chung' ? 'hong' : 'chung');
const cur = () => state.round - 1;
const wins = (s) => state.roundWinner.filter((w) => w === s).length;

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

function removeEvent(id) {
  const idx = state.events.findIndex((e) => e.id === id && e.round === state.round);
  if (idx < 0) return false;
  state.events.splice(idx, 1);
  recompute();
  return true;
}

// ===== ATURAN RONDE =====
function endRound(winner) {
  state.savedTime = state.timeLeft;
  state.tie = null;
  state.roundWinner[cur()] = winner;
  state.endedBy = 'round';
  if (wins(winner) >= 2) {
    state.phase = 'ended';
    state.winner = winner;
  } else {
    state.phase = 'rest';
    state.timeLeft = settings.restTime;
  }
}

function checkRound() {
  if (state.phase !== 'running' && state.phase !== 'paused') return;
  const i = cur();
  for (const s of ['chung', 'hong']) {
    if (state.gamjeom[s][i] >= settings.gamjeomLimit) return endRound(other(s));
  }
  if (settings.pointGapOn) {
    const gap = state.points.chung[i] - state.points.hong[i];
    if (gap >= settings.pointGap) return endRound('chung');
    if (-gap >= settings.pointGap) return endRound('hong');
  }
}

// Jika log dihapus saat ronde sudah selesai, ronde dibuka kembali
function reopenIfNeeded() {
  const p = state.phase;
  if (p === 'rest' || p === 'tie' || p === 'ended') {
    state.tie = null;
    state.roundWinner[cur()] = null;
    state.winner = null;
    state.endedBy = null;
    state.phase = 'paused';
    state.timeLeft = state.savedTime;
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
  // poin yang DITERIMA s dari gam-jeom lawan
  const gjp = (s) => ev.filter((e) => e.kind === 'gj' && e.side === other(s)).reduce((a, e) => a + e.pts, 0);
  return [
    { title: 'POIN TENDANGAN PUTAR', chung: sum('chung', isTurn), hong: sum('hong', isTurn) },
    { title: 'TEKNIK KEPALA (3 POIN)', chung: cnt('chung', isHead), hong: cnt('hong', isHead) },
    { title: 'TEKNIK BADAN (2 POIN)', chung: cnt('chung', isTrunk), hong: cnt('hong', isTrunk) },
    { title: 'TEKNIK PUKULAN (1 POIN)', chung: cnt('chung', isPunch), hong: cnt('hong', isPunch) },
    { title: 'TOTAL POIN DARI GAM-JEOM', chung: gjp('chung'), hong: gjp('hong') },
  ];
}

function startTie() {
  const steps = tieSteps();
  const decidedIdx = steps.findIndex((s) => s.chung !== s.hong);
  state.phase = 'tie';
  state.timeLeft = 0;
  state.savedTime = 0;
  state.tie = {
    steps,
    decidedIdx,       // -1 = semua kriteria sama -> Woo-se-girok
    shown: 0,         // kriteria yang sedang tampil di scoreboard
    hold: 3,          // detik tiap kriteria ditampilkan
    stage: 'steps',   // 'steps' | 'vote'
    winner: decidedIdx >= 0 ? (steps[decidedIdx].chung > steps[decidedIdx].hong ? 'chung' : 'hong') : null,
    votes: [null, null, null],
  };
}

function timeUp() {
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
      else if (TECH[a.kind]) addScore(a.side, a.kind, 'Koreksi IVR');
    } else {
      const last = [...state.events].reverse().find((e) =>
        e.round === state.round && e.side === a.side &&
        (a.kind === 'gj' ? e.kind === 'gj' : (e.kind === 'score' && e.tech === a.kind)));
      if (last) removeEvent(last.id);
    }
  }
}

// ===== PERINTAH DARI OPERATOR / JOYSTICK =====
function handle(type, p = {}) {
  const scoring = state.phase === 'running' || state.phase === 'paused';
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
    case 'gj': // p = { side (yang dikenai), passive }
      // Gam-jeom pasif hanya sah di 10 detik terakhir ronde
      if (scoring && (!p.passive || state.timeLeft <= 10)) {
        addGamjeom(p.side, !!p.passive);
        checkRound();
      }
      break;

    case 'undo':
    case 'del': { // hapus kejadian terakhir / kejadian tertentu (p = { id })
      const okPhase = ['running', 'paused', 'rest', 'tie'].includes(state.phase) ||
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

    case 'setTime': // p = { seconds } koreksi waktu
      if (['waiting', 'paused', 'ivr'].includes(state.phase)) {
        state.timeLeft = Math.max(0, Math.min(5999, Math.floor(Number(p.seconds) || 0)));
      }
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

    case 'test':
      if (state.phase === 'waiting') state.phase = 'test';
      else if (state.phase === 'test') state.phase = 'waiting';
      break;

    case 'kyeshi': // timer cedera / dokter
      if (scoring) {
        state.phase = 'kyeshi';
        state.injuryTime = settings.kyeshiTime;
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
        state.phase = 'ivr';
        state.ivrTime = 30;
      }
      break;
    case 'ivrCancel': // batal, kuota tidak berkurang
      if (state.phase === 'ivr') {
        state.phase = 'paused';
        state.ivrBy = null;
        state.ivrKind = null;
      }
      break;
    case 'ivrDecide': { // p = { result, reason, requester, adjs }
      if (state.phase !== 'ivr') break;
      const kind = state.ivrKind;
      const by = kind === 'coach' ? state.ivrBy : (kind === 'technical' ? (p.requester || 'wasit') : null);
      state.phase = 'paused';
      if (p.result === 'accept') applyAdjs(p.adjs || []);
      if (p.result === 'reject') {
        if (kind === 'coach') state.ivr[by] = Math.max(0, state.ivr[by] - 1);
        // kartu teknis ditolak: Gam-jeom untuk atlet coach pemohon (kuota kartu tidak berkurang)
        if (kind === 'technical' && (by === 'chung' || by === 'hong')) {
          addGamjeom(by, state.timeLeft <= 10, 'Kartu teknis ditolak');
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
      Object.assign(settings, p);
      saveSettings();
      if (state.phase === 'waiting') {
        state.timeLeft = settings.roundTime;
        if (state.round === 1) state.ivr = { chung: settings.ivrQuota, hong: settings.ivrQuota };
      }
      checkRound();
      break;
    case 'setInfo':
      state.category = p.category;
      state.matchNo = p.matchNo;
      state.chung = { name: p.chungName, country: p.chungCountry };
      state.hong = { name: p.hongName, country: p.hongCountry };
      break;
    case 'newMatch':
      state = newMatch();
      nextId = 1;
      break;
  }
  broadcast();
}

// ===== TIMER (jalan tiap 1 detik) =====
setInterval(() => {
  if (state.phase === 'running') {
    state.timeLeft--;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      timeUp();
    }
    broadcast();
  } else if (state.phase === 'rest') {
    state.timeLeft--;
    if (state.timeLeft <= 0) {
      state.round++;
      state.phase = 'waiting';
      state.timeLeft = settings.roundTime;
    }
    broadcast();
  } else if (state.phase === 'kyeshi') {
    if (state.injuryTime > 0) state.injuryTime--;
    broadcast();
  } else if (state.phase === 'tie' && state.tie.stage === 'steps') {
    const t = state.tie;
    t.hold--;
    if (t.hold <= 0) {
      if (t.decidedIdx >= 0 && t.shown >= t.decidedIdx) endRound(t.winner);
      else if (t.shown < t.steps.length - 1) { t.shown++; t.hold = 3; }
      else t.stage = 'vote'; // semua kriteria sama -> Woo-se-girok
    }
    broadcast();
  }

  // hasil IVR tampil 3 detik di scoreboard
  if (state.ivrResultTime > 0) {
    state.ivrResultTime--;
    if (state.ivrResultTime === 0) state.ivrResult = null;
    broadcast();
  }
}, 1000);

// ===== JENDELA =====
const windows = [];

function createWindow(file, opts = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    ...opts,
  });
  win.loadFile(file);
  windows.push(win);
  win.on('closed', () => windows.splice(windows.indexOf(win), 1));
  return win;
}

function broadcast() {
  for (const w of windows) w.webContents.send('state', state);
}

ipcMain.handle('getState', () => state);
ipcMain.on('cmd', (e, type, payload) => handle(type, payload));
ipcMain.on('fullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  w.setFullScreen(!w.isFullScreen());
});

app.whenReady().then(() => {
  createWindow('scoreboard.html');
  createWindow('operator.html', { x: 80, y: 60, width: 1100, height: 760 });
});

app.on('window-all-closed', () => app.quit());