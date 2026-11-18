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

// atlet yang benar-benar bertanding (hasil sungguhan, bukan WDR otomatis)
function playedIds(b) {
  const set = new Set();
  forEachMatch(b, (r, i) => {
    const res = b.results && b.results[key(r, i)];
    if (!res || res.auto) return;
    entries(b, r, i).forEach((e) => { if (e) set.add(e.id); });
  });
  return set;
}

// atlet yang mundur (WDR) sebelum pernah bertanding dianggap tidak masuk arena: tidak dapat medali
function enteredSet(b) {
  const played = playedIds(b);
  const wd = new Set(b.wd || []);
  const set = new Set();
  b.slots.filter(Boolean).forEach((s) => { if (!wd.has(s.id) || played.has(s.id)) set.add(s.id); });
  return set;
}

// medali satu bagan: emas = juara, perak = kalah di final, perunggu = dua yang kalah di semifinal
function medals(b) {
  const rounds = roundsOf(b);
  const out = { done: false, gold: null, silver: null, bronze: [] };
  const fin = b.results && b.results[key(rounds - 1, 0)];
  if (!fin) return out;
  out.done = true;
  const entered = enteredSet(b);
  const ok = (e) => (e && entered.has(e.id) ? e : null);
  const [f1, f2] = entries(b, rounds - 1, 0);
  out.gold = ok(fin.winner);
  out.silver = ok([f1, f2].find((e) => e && e.id !== fin.winner.id) || null);
  if (rounds >= 2) {
    for (let i = 0; i < 2; i++) {
      const res = b.results && b.results[key(rounds - 2, i)];
      if (!res) continue; // pasangan babak 1 berisi bye tidak punya kalah
      const loser = ok(entries(b, rounds - 2, i).find((e) => e && e.id !== res.winner.id) || null);
      if (loser) out.bronze.push(loser);
    }
  }
  return out;
}

// perolehan medali per kontingen (juara umum), tanpa poin: urut emas, perak, perunggu;
// kontingen dengan medali yang sama persis diberi peringkat sama dan ditandai tie (diputuskan panitia)
function standings(brackets) {
  const teams = new Map();
  const team = (club) => {
    const name = String(club || '').trim() || '(tanpa kontingen)';
    const k = name.toLowerCase();
    if (!teams.has(k)) teams.set(k, { name, gold: 0, silver: 0, bronze: 0 });
    return teams.get(k);
  };
  brackets.forEach((b) => {
    const m = medals(b);
    if (m.gold) team(m.gold.club).gold++;
    if (m.silver) team(m.silver.club).silver++;
    m.bronze.forEach((e) => team(e.club).bronze++);
  });
  const rows = [...teams.values()];
  const keyOf = (t) => [t.gold, t.silver, t.bronze];
  const cmp = (a, c) => {
    const ka = keyOf(a);
    const kc = keyOf(c);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kc[i]) return kc[i] - ka[i];
    return a.name.localeCompare(c.name);
  };
  rows.sort(cmp);
  rows.forEach((t, i) => {
    const prev = rows[i - 1];
    const same = prev && keyOf(prev).join() === keyOf(t).join();
    t.rank = same ? prev.rank : i + 1;
    t.tie = !!same || (rows[i + 1] && keyOf(rows[i + 1]).join() === keyOf(t).join());
  });
  return rows;
}

const api = { key, roundsOf, forEachMatch, isPlayed, entries, setResult, clearResult, autoAdvance, markWd, unmarkWd, eliminated, champion, playedIds, enteredSet, medals, standings };
if (typeof module !== 'undefined' && module.exports) module.exports = api;