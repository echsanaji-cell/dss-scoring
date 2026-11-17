// bracket.js: logika bagan gugur tunggal, dipakai bersama oleh main.js dan drawing.html
// b = { size, slots: [{ id, name, club } | null], results: { 'r:i': { winner, code, auto, at } }, wd: [id] }
const key = (r, i) => `${r}:${i}`;
const roundsOf = (b) => Math.log2(b.size);

function forEachMatch(b, fn) {
  const rounds = roundsOf(b);
  for (let r = 0; r < rounds; r++) {
    const count = b.size / Math.pow(2, r + 1);
    for (let i = 0; i < count; i++) fn(r, i);
  }
}

// pasangan babak 1 yang berisi bye tidak dimainkan
function isPlayed(b, r, i) {
  return r > 0 || !!(b.slots[2 * i] && b.slots[2 * i + 1]);
}

// peserta satu pertandingan: [e1, e2]; null = belum diketahui (atau bye di babak 1)
function entries(b, r, i) {
  if (r === 0) return [b.slots[2 * i] || null, b.slots[2 * i + 1] || null];
  const feed = (j) => {
    if (r === 1) { // atlet yang mendapat bye langsung maju
      const a = b.slots[2 * j];
      const c = b.slots[2 * j + 1];
      if (!(a && c)) return a || c || null;
    }
    const res = b.results && b.results[key(r - 1, j)];
    return res ? res.winner : null;
  };
  return [feed(2 * i), feed(2 * i + 1)];
}

function setResult(b, r, i, winner, code, auto) {
  if (!b.results) b.results = {};
  b.results[key(r, i)] = {
    winner: { id: winner.id, name: winner.name, club: winner.club || '' },
    code: code || '',
    auto: !!auto,
    at: Date.now(),
  };
}

// hapus hasil satu pertandingan. Hasil otomatis (WDR) di babak berikutnya ikut dihapus;
// kalau babak berikutnya sudah punya hasil sungguhan, pencabutan ditolak (return false)
function clearResult(b, r, i) {
  if (!b.results || !b.results[key(r, i)]) return true;
  if (r < roundsOf(b) - 1) {
    const nr = r + 1;
    const ni = i >> 1;
    const nxt = b.results[key(nr, ni)];
    if (nxt) {
      if (!nxt.auto) return false;
      if (!clearResult(b, nr, ni)) return false;
    }
  }
  delete b.results[key(r, i)];
  return true;
}

// atlet yang mundur (WDR): lawannya menang otomatis; diulang sampai tidak ada perubahan
function autoAdvance(b) {
  const wd = new Set(b.wd || []);
  if (!wd.size) return 0;
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    forEachMatch(b, (r, i) => {
      if (!isPlayed(b, r, i) || (b.results && b.results[key(r, i)])) return;
      const [e1, e2] = entries(b, r, i);
      if (!e1 || !e2) return;
      const w1 = wd.has(e1.id);
      const w2 = wd.has(e2.id);
      if (w1 === w2) return; // keduanya mundur: diputuskan manual
      setResult(b, r, i, w1 ? e2 : e1, 'WDR', true);
      changed++;
      again = true;
    });
  }
  return changed;
}

function markWd(b, id) {
  if (!b.wd) b.wd = [];
  if (!b.wd.includes(id)) b.wd.push(id);
  return autoAdvance(b);
}

// batalkan status mundur; hasil WDR otomatis yang melibatkan atlet itu dihapus (return false bila ada hasil sungguhan di atasnya)
function unmarkWd(b, id) {
  const snapResults = JSON.parse(JSON.stringify(b.results || {}));
  const snapWd = (b.wd || []).slice();
  b.wd = snapWd.filter((x) => x !== id);
  const hit = [];
  forEachMatch(b, (r, i) => {
    const res = b.results && b.results[key(r, i)];
    if (!res || !res.auto) return;
    const [e1, e2] = entries(b, r, i);
    if ((e1 && e1.id === id) || (e2 && e2.id === id)) hit.push([r, i]);
  });
  for (const [r, i] of hit) {
    if (!clearResult(b, r, i)) {
      b.results = snapResults;
      b.wd = snapWd;
      return false;
    }
  }
  autoAdvance(b);
  return true;
}

// pertandingan yang sudah bisa dimainkan: kedua peserta diketahui, belum ada hasil, tidak ada yang mundur
function readyMatches(b) {
  const wd = new Set(b.wd || []);
  const out = [];
  forEachMatch(b, (r, i) => {
    if (!isPlayed(b, r, i) || (b.results && b.results[key(r, i)])) return;
    const [e1, e2] = entries(b, r, i);
    if (e1 && e2 && !wd.has(e1.id) && !wd.has(e2.id)) out.push({ r, i, e1, e2 });
  });
  return out;
}

// Map(id atlet -> babak (r) tempat kalah)
function eliminated(b) {
  const m = new Map();
  forEachMatch(b, (r, i) => {
    const res = b.results && b.results[key(r, i)];
    if (!res) return;
    entries(b, r, i).forEach((e) => { if (e && e.id !== res.winner.id) m.set(e.id, r); });
  });
  return m;
}

function champion(b) {
  const res = b.results && b.results[key(roundsOf(b) - 1, 0)];
  return res ? res.winner : null;
}

const api = { key, roundsOf, forEachMatch, isPlayed, entries, setResult, clearResult, autoAdvance, markWd, unmarkWd, readyMatches, eliminated, champion };
if (typeof module !== 'undefined' && module.exports) module.exports = api;