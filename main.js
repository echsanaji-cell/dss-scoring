const { app, BrowserWindow, ipcMain } = require('electron');

// ===== PENGATURAN (nanti bisa diubah dari layar operator) =====
const settings = {
  roundTime: 120,    // detik per ronde
  restTime: 60,      // detik istirahat antar ronde
  gamjeomLimit: 5,   // 5 gam-jeom dalam 1 ronde = lawan menang ronde
  pointGapOn: true,
  pointGap: 15,      // selisih poin per ronde (aturan WT: 15)
};

// ===== STATE PERTANDINGAN =====
function newMatch() {
  return {
    category: 'Male -58 kg',
    matchNo: '001',
    chung: { name: 'Hassan Idman', country: 'IRI' },
    hong: { name: 'James Stuart', country: 'GBR' },
    round: 1,
    phase: 'waiting', // waiting | running | paused | rest | superiority | ended
    timeLeft: settings.roundTime,
    points: { chung: [0, 0, 0], hong: [0, 0, 0] },
    gamjeom: { chung: [0, 0, 0], hong: [0, 0, 0] },
    roundWinner: [null, null, null],
    winner: null,
  };
}
let state = newMatch();

// ===== ATURAN =====
const other = (s) => (s === 'chung' ? 'hong' : 'chung');
const wins = (s) => state.roundWinner.filter((w) => w === s).length;
const cur = () => state.round - 1;

function endRound(winner) {
  state.roundWinner[cur()] = winner;
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

function timeUp() {
  const i = cur();
  const c = state.points.chung[i];
  const h = state.points.hong[i];
  if (c === h) {
    state.phase = 'superiority'; // seri: operator pilih pemenang ronde (keputusan juri)
    state.timeLeft = 0;
  } else {
    endRound(c > h ? 'chung' : 'hong');
  }
}

// ===== PERINTAH DARI OPERATOR / JOYSTICK =====
function handle(type, p = {}) {
  const i = cur();
  const scoring = state.phase === 'running' || state.phase === 'paused';
  switch (type) {
    case 'start': // Shijak / Kye-sok
      if (state.phase === 'waiting' || state.phase === 'paused') state.phase = 'running';
      break;
    case 'pause': // Kal-yeo
      if (state.phase === 'running') state.phase = 'paused';
      break;
    case 'add': // p = { side: 'chung'|'hong', pts: 1 }  (pts boleh negatif untuk koreksi)
      if (!scoring) break;
      state.points[p.side][i] = Math.max(0, state.points[p.side][i] + p.pts);
      checkRound();
      break;
    case 'gamjeom': // p = { side, delta: 1 | -1 }, 1 gam-jeom = +1 poin untuk lawan
      if (!scoring) break;
      state.gamjeom[p.side][i] = Math.max(0, state.gamjeom[p.side][i] + p.delta);
      state.points[other(p.side)][i] = Math.max(0, state.points[other(p.side)][i] + p.delta);
      checkRound();
      break;
    case 'superiority': // p = { side } pemenang ronde seri
      if (state.phase === 'superiority') endRound(p.side);
      break;
    case 'newMatch':
      state = newMatch();
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

app.whenReady().then(() => {
  createWindow('scoreboard.html');
  // createWindow('operator.html'); // <- kita aktifkan di langkah berikutnya
});

app.on('window-all-closed', () => app.quit());