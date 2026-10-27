// İsim Şehir oyun motoru: tur akışı, süre, cevap kontrolü, oylama, puanlama.
// Saf mantık: ağ ve zamanlayıcı dışarıdan (server.js) verilir; tick() ile ilerler.
const dict = require('./dict');

class GameError extends Error {}
const ge = m => { throw new GameError(m); };

const FAST = !!process.env.ISIM_FAST;       // testlerde süreleri kısaltır
const T = {
  ready: 3600,          // "harf geliyor" ekranı
  grace: 1800,          // süre bitince son cevapların toplanması
  doneCountdown: 10000, // biri BİTTİ deyince kalan süre
  stepBase: 4200,       // oylama gerekmeyen kategori ekranda kalma süresi
  stepDispute: 16000,   // oylanan kategori için oy süresi
  stepAfterVotes: 2600, // herkes oy verince / karar sonrası gösterim
  scoresAuto: 60000,    // puan listesinde kurucu devam etmezse otomatik yeni tur
};
if (FAST) Object.keys(T).forEach(k => { T[k] = Math.max(120, Math.round(T[k] / 12)); });

const DEFAULTS = { cats: ['isim', 'sehir', 'hayvan', 'bitki', 'esya'], duration: 180, endMode: 'rounds', target: 6, hardLetters: true, priv: false, doneSec: 20 };

function sanitizeSettings(input, cur) {
  const s = { ...(cur || DEFAULTS) };
  if (!input || typeof input !== 'object') return s;
  if (Array.isArray(input.cats)) {
    const set = new Set(input.cats.map(String));
    const cats = dict.CAT_IDS.filter(id => set.has(id));       // katalog sırası korunur
    if (!cats.length) ge('En az bir kategori seç.');
    s.cats = cats;
  }
  if (input.duration !== undefined) {
    const d = Number(input.duration);
    const min = FAST ? 3 : 30;
    if (!Number.isFinite(d) || d < min || d > 600) ge('Tur süresi geçersiz.');
    s.duration = Math.round(d);
  }
  if (input.endMode !== undefined) {
    if (input.endMode !== 'rounds' && input.endMode !== 'points') ge('Bitiş türü geçersiz.');
    s.endMode = input.endMode;
    if (input.target === undefined) s.target = s.endMode === 'rounds' ? 6 : 150;
  }
  if (input.target !== undefined) {
    const t = Math.round(Number(input.target));
    if (s.endMode === 'rounds') { if (!(t >= 1 && t <= 30)) ge('Tur sayısı 1-30 arası olmalı.'); } else if (!(t >= 20 && t <= 1000)) ge('Hedef puan 20-1000 arası olmalı.');
    s.target = t;
  }
  s.hardLetters = true;
  if (input.doneSec !== undefined) { const v = Number(input.doneSec); if (![0, 10, 20, 30].includes(v)) ge('Bitirme süresi geçersiz.'); s.doneSec = v; }
  if (input.priv !== undefined) s.priv = !!input.priv;
  return s;
}

class Game {
  constructor(players, settings, hooks, opts = {}) {
    this.gid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.now = opts.now || Date.now;
    this.hooks = hooks || {};
    this.settings = sanitizeSettings(settings, DEFAULTS);
    this.players = new Map();
    players.forEach(p => this.players.set(p.id, { id: p.id, nick: p.nick, score: 0, online: true, left: false }));
    this.host = players[0] ? players[0].id : null;
    this.round = 0;
    this.usedLetters = [];
    this.rd = null;
    this.phase = 'ready';
    this.winners = [];
    this.changed = false;
    this.startRound();
  }

  // ---------- yardımcılar ----------
  bump() { this.changed = true; }
  active() { return [...this.players.values()].filter(p => !p.left); }
  catLabel(id) { return (dict.CATEGORIES.find(c => c.id === id) || {}).label || id; }
  pickLetter() {
    const pool = dict.LETTERS.concat(this.settings.hardLetters ? dict.HARD_LETTERS : []);
    let free = pool.filter(l => !this.usedLetters.includes(l));
    if (!free.length) { this.usedLetters = []; free = pool.slice(); }
    const l = free[Math.floor(Math.random() * free.length)];
    this.usedLetters.push(l);
    return l;
  }
  needPlayer(pid) { const p = this.players.get(pid); if (!p) ge('Bu oyunda değilsin.'); return p; }

  setOnline(pid, on) { const p = this.players.get(pid); if (p) { p.online = !!on; this.bump(); } }
  setHost(pid) { this.host = pid; this.bump(); }
  leave(pid) {
    const p = this.players.get(pid);
    if (!p || p.left) return;
    p.left = true; p.online = false;
    if (this.active().length === 0 && this.phase !== 'over') this.finish();
    this.bump();
  }
  rejoin(pid) { const p = this.players.get(pid); if (p) { p.left = false; p.online = true; this.bump(); } }
  setNick(pid, nick) { const p = this.players.get(pid); if (p) p.nick = nick; }

  // ---------- tur akışı ----------
  startRound() {
    this.round++;
    const answers = {};
    this.players.forEach((p, id) => { answers[id] = {}; });
    this.rd = {
      n: this.round, letter: this.pickLetter(), cats: this.settings.cats.slice(), answers,
      done: {}, doneBy: null, countdownEnd: null, endsAt: null, readyEnds: this.now() + T.ready,
      graceEnds: null, entries: null, items: null, points: {}, revealIdx: 0, step: null, scoresEnds: null,
    };
    this.phase = 'ready';
    this.bump();
  }

  tick() {
    const now = this.now();
    const rd = this.rd;
    switch (this.phase) {
      case 'ready':
        if (now >= rd.readyEnds) { this.phase = 'play'; rd.endsAt = now + this.settings.duration * 1000; this.bump(); }
        break;
      case 'play': {
        const end = rd.countdownEnd ? Math.min(rd.endsAt, rd.countdownEnd) : rd.endsAt;
        const online = this.active().filter(p => p.online);
        const everyoneDone = online.length > 0 && online.every(p => rd.done[p.id]);
        if (now >= end || everyoneDone) { this.phase = 'grace'; rd.graceEnds = now + (everyoneDone ? 600 : T.grace); this.bump(); }
        break;
      }
      case 'grace':
        if (now >= rd.graceEnds) this.finalizeRound();
        break;
      case 'reveal': this.tickReveal(now); break;
      case 'scores':
        if (now >= rd.scoresEnds) this.startRound();
        break;
      default: break;
    }
    const c = this.changed; this.changed = false; return c;
  }

  // ---------- oyuncu işlemleri ----------
  setAnswers(pid, obj) {
    this.needPlayer(pid);
    if (this.phase !== 'play' && this.phase !== 'grace') return;
    const rd = this.rd;
    const mine = rd.answers[pid] || (rd.answers[pid] = {});
    rd.cats.forEach(c => { if (obj && typeof obj[c] === 'string') mine[c] = dict.cleanText(obj[c]); });
    if (rd.done[pid] && rd.cats.some(c => !mine[c])) { delete rd.done[pid]; this.bump(); }
  }

  done(pid) {
    this.needPlayer(pid);
    if (this.phase !== 'play') ge('Şu an tur oynanmıyor.');
    const rd = this.rd;
    const mine = rd.answers[pid] || {};
    if (rd.cats.some(c => !mine[c])) ge('Önce tüm kutuları doldur.');
    rd.done[pid] = true;
    if (!rd.doneBy) rd.doneBy = pid;
    const ds = this.settings.doneSec === undefined ? 20 : this.settings.doneSec;
    if (!rd.countdownEnd && ds > 0) rd.countdownEnd = Math.min(rd.endsAt, this.now() + (FAST ? ds * 1000 / 12 : ds * 1000));
    this.bump();
  }

  finalizeRound() {
    const rd = this.rd;
    rd.entries = {}; rd.items = {};
    rd.cats.forEach(cat => {
      const list = [];
      this.players.forEach((p, pid) => {
        const text = (rd.answers[pid] || {})[cat] || '';
        const r = dict.check(cat, text, rd.letter);
        const e = { pid, text: r.text, status: r.status, key: r.key || null, canon: r.canon || null, reason: r.reason || null, itemId: null, points: null, valid: false };
        if (r.status === 'disputed') {
          const id = cat + ':' + r.key;
          const item = rd.items[id] || (rd.items[id] = { id, cat, key: r.key, text: r.text, authors: [], votes: {}, verdict: null });
          item.authors.push(pid); e.itemId = id;
        }
        list.push(e);
      });
      rd.entries[cat] = list;
    });
    this.players.forEach((p, pid) => { rd.points[pid] = 0; });
    this.phase = 'reveal';
    rd.revealIdx = 0;
    this.startStep();
  }

  // ---------- gösterim adımları (kategori kategori) ----------
  catItems(idx) { const cat = this.rd.cats[idx]; return Object.values(this.rd.items).filter(i => i.cat === cat); }
  eligibleVoters(item) { return this.active().filter(p => p.online && !item.authors.includes(p.id)).map(p => p.id); }

  startStep() {
    const rd = this.rd, now = this.now();
    const items = this.catItems(rd.revealIdx);
    // oy verecek kimsesi olmayan cevaplar (herkes aynı şeyi yazdı / tek kişi var) kabul edilir
    items.forEach(it => { if (it.verdict === null && this.eligibleVoters(it).length === 0) it.verdict = true; });
    const pending = items.filter(it => it.verdict === null);
    rd.step = { state: pending.length ? 'voting' : 'shown', endsAt: null, fastAt: false };
    if (pending.length) rd.step.endsAt = now + T.stepDispute;
    else { this.scoreCat(rd.revealIdx); rd.step.endsAt = now + T.stepBase; }
    this.bump();
  }

  tickReveal(now) {
    const rd = this.rd, st = rd.step;
    if (!st) return;
    if (st.state === 'voting') {
      const pending = this.catItems(rd.revealIdx).filter(it => it.verdict === null);
      const allVoted = pending.every(it => this.eligibleVoters(it).every(v => it.votes[v] !== undefined));
      if (allVoted && !st.fastAt) { st.fastAt = true; st.endsAt = Math.min(st.endsAt, now + T.stepAfterVotes); this.bump(); }
      if (now >= st.endsAt) this.resolveStep();
    } else if (now >= st.endsAt) this.nextStep();
  }

  resolveStep() {
    const rd = this.rd;
    this.catItems(rd.revealIdx).forEach(it => { if (it.verdict === null) this.decide(it); });
    this.scoreCat(rd.revealIdx);
    rd.step = { state: 'shown', endsAt: this.now() + T.stepAfterVotes + 600, fastAt: true };
    this.bump();
  }

  decide(item) {
    const votes = Object.entries(item.votes).filter(([pid]) => this.players.has(pid));
    const yes = votes.filter(([, v]) => v).length, no = votes.length - yes;
    if (!votes.length) { item.verdict = true; return; }            // kimse oy vermedi: benefit of the doubt, sözlüğe eklenmez
    item.verdict = yes > no;
    if (item.verdict && yes >= 2) dict.suggest(item.cat, item.text, this.gid);   // sözlüğe doğrudan değil, farklı oyunlarda tekrar kabul edilirse
  }

  scoreCat(idx) {
    const rd = this.rd, cat = rd.cats[idx];
    const list = rd.entries[cat];
    const groups = new Map();
    list.forEach(e => {
      const ok = e.status === 'ok' || (e.status === 'disputed' && rd.items[e.itemId].verdict === true);
      e.valid = ok;
      if (ok) { if (!groups.has(e.key)) groups.set(e.key, []); groups.get(e.key).push(e); }
    });
    list.forEach(e => { e.points = 0; });
    groups.forEach(g => g.forEach(e => { e.points = g.length === 1 ? 10 : 5; }));
    list.forEach(e => {
      rd.points[e.pid] = (rd.points[e.pid] || 0) + e.points;
      const p = this.players.get(e.pid); if (p) p.score += e.points;
    });
  }

  nextStep() {
    const rd = this.rd;
    if (rd.revealIdx + 1 < rd.cats.length) { rd.revealIdx++; this.startStep(); } else this.endReveal();
  }

  endReveal() {
    const list = [...this.players.values()].sort((a, b) => b.score - a.score);
    const { endMode, target } = this.settings;
    let over = false;
    if (endMode === 'rounds') over = this.round >= target;
    else if (list.length && list[0].score >= target) over = list.length === 1 || list[0].score > list[1].score;
    if (over) this.finish(); else { this.phase = 'scores'; this.rd.scoresEnds = this.now() + T.scoresAuto; this.rd.step = null; }
    this.bump();
  }

  finish() {
    const list = [...this.players.values()];
    const best = Math.max(0, ...list.map(p => p.score));
    this.winners = list.filter(p => p.score === best).map(p => p.id);
    this.phase = 'over';
    this.bump();
  }

  vote(pid, itemId, yes) {
    this.needPlayer(pid);
    if (this.phase !== 'reveal' || !this.rd.step || this.rd.step.state !== 'voting') ge('Şu an oylama yok.');
    const item = this.rd.items[itemId];
    if (!item || item.cat !== this.rd.cats[this.rd.revealIdx] || item.verdict !== null) ge('Bu cevap oylanamaz.');
    if (item.authors.includes(pid)) ge('Kendi cevabına oy veremezsin.');
    item.votes[pid] = !!yes;
    this.bump();
  }

  skip(pid) {
    if (pid !== this.host) ge('Sadece oda kurucusu geçebilir.');
    if (this.phase !== 'reveal' || !this.rd.step) return;
    if (this.rd.step.state === 'voting') this.resolveStep(); else this.nextStep();
  }

  next(pid) {
    if (pid !== this.host) ge('Sadece oda kurucusu devam ettirebilir.');
    if (this.phase !== 'scores') ge('Şu an puan listesi açık değil.');
    this.startRound();
  }

  // ---------- istemciye giden görünüm ----------
  view(pid) {
    const rd = this.rd, now = this.now();
    const cats = rd.cats.map(id => ({ id, label: this.catLabel(id) }));
    const v = {
      phase: this.phase, round: this.round, letter: rd.letter, cats, settings: this.settings, host: this.host,
      serverNow: now, readyEnds: rd.readyEnds, endsAt: rd.endsAt,
      countdownEnd: rd.countdownEnd, doneBy: rd.doneBy,
      players: [...this.players.values()].map(p => ({ id: p.id, nick: p.nick, score: p.score, online: p.online, left: p.left, done: !!rd.done[p.id], roundPoints: rd.points[p.id] || 0 })),
      me: { id: pid, answers: rd.answers[pid] || {}, done: !!rd.done[pid] },
      winners: this.winners,
    };
    if (rd.entries && (this.phase === 'reveal' || this.phase === 'scores' || this.phase === 'over')) {
      const last = this.phase === 'reveal' ? rd.revealIdx : rd.cats.length - 1;
      v.reveal = {
        idx: rd.revealIdx, state: rd.step ? rd.step.state : 'shown', stepEnds: rd.step ? rd.step.endsAt : null, scoresEnds: rd.scoresEnds,
        cats: rd.cats.slice(0, last + 1).map((cat, i) => {
          const finished = i < rd.revealIdx || this.phase !== 'reveal' || (rd.step && rd.step.state === 'shown');
          const items = Object.values(rd.items).filter(it => it.cat === cat).map(it => {
            const el = this.eligibleVoters(it);
            const decided = it.verdict !== null;
            return {
              id: it.id, text: it.text, authors: it.authors, verdict: it.verdict,
              voted: Object.keys(it.votes).length, voters: el.length,
              yes: decided ? Object.values(it.votes).filter(Boolean).length : null,
              no: decided ? Object.values(it.votes).filter(x => !x).length : null,
              myVote: it.votes[pid] === undefined ? null : it.votes[pid],
              canVote: !decided && el.includes(pid),
            };
          });
          return {
            id: cat, label: this.catLabel(cat), finished,
            entries: rd.entries[cat].map(e => ({ pid: e.pid, text: e.text, status: e.status, reason: e.reason, canon: e.canon, itemId: e.itemId, points: finished ? e.points : null, valid: finished ? e.valid : null })),
            items,
          };
        }),
      };
    }
    return v;
  }
}

module.exports = { Game, GameError, sanitizeSettings, DEFAULTS, T };
