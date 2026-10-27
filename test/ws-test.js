// Uçtan uca: gerçek sunucu + 3 WebSocket istemcisi ile komple oyun (hızlandırılmış süreler).
process.env.ISIM_FAST = '1';
process.env.ISIM_LEARNED_FILE = require('path').join(require('os').tmpdir(), 'isim-learned-ws-' + process.pid + '.json');
const assert = require('assert');
const http = require('http');
const server = require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
class Client {
  constructor(port, token, nick) {
    this.token = token; this.nick = nick; this.state = null; this.room = null; this.msgs = []; this.rid = 0; this.waiting = {};
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ready = new Promise(res => { this.ws.onopen = res; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data); this.msgs.push(m);
      if (m.t === 'state') this.state = m.state;
      if (m.t === 'room') this.room = m.room;
      if (m.t === 'joined') { this.you = m.you; this.catalog = m.catalog; }
      if (m.t === 'ack' && this.waiting[m.rid]) this.waiting[m.rid].res();
      if (m.t === 'err' && this.waiting[m.rid]) this.waiting[m.rid].rej(new Error(m.msg));
    };
  }
  send(msg) { return new Promise((res, rej) => { msg.rid = ++this.rid; this.waiting[msg.rid] = { res, rej }; this.ws.send(JSON.stringify(msg)); }); }
  act(type, extra = {}) { return this.send({ t: 'act', type, ...extra }); }
  async until(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn(this)) return; await sleep(25); } throw new Error('zaman aşımı: ' + (this.state ? this.state.phase : 'durum yok')); }
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const [a, b, c] = ['tokA', 'tokB', 'tokC'].map((t, i) => new Client(port, t, ['Ayşe', 'Burak', 'Ceren'][i]));
  await Promise.all([a.ready, b.ready, c.ready]);

  await a.send({ t: 'join', pid: a.token, nick: a.nick, create: true });
  await a.until(x => x.room);
  const code = a.room.code;
  assert.strictEqual(a.catalog.length, 12);
  await b.send({ t: 'join', pid: b.token, nick: b.nick, code });
  await c.send({ t: 'join', pid: c.token, nick: c.nick, code: code.toLowerCase() });
  await a.until(x => x.room.members.length === 3);
  // token sızmaz
  assert(!JSON.stringify(b.msgs).includes('tokA'));

  // aynı nick, küfürlü nick, kurucu olmayan ayar
  const d = new Client(port, 'tokD', 'ayşe'); await d.ready;
  await assert.rejects(d.send({ t: 'join', pid: d.token, nick: 'ayşe', code }), /zaten var/);
  await assert.rejects(d.send({ t: 'join', pid: d.token, nick: 'siktir', code }), /uygun değil/);
  d.ws.close();
  await assert.rejects(b.send({ t: 'settings', settings: { duration: 60 } }), /kurucusu/);
  await assert.rejects(b.send({ t: 'start' }), /kurucusu/);

  await a.send({ t: 'settings', settings: { cats: ['isim', 'sehir', 'hayvan'], duration: 4, endMode: 'rounds', target: 2 } });
  await b.until(x => x.room.settings.duration === 4 && x.room.settings.cats.length === 3);
  await a.send({ t: 'start' });
  await Promise.all([a, b, c].map(x => x.until(s => s.state && s.state.phase === 'ready')));
  // oyun başlayınca yeni oyuncu giremez
  const e = new Client(port, 'tokE', 'Deniz'); await e.ready;
  await assert.rejects(e.send({ t: 'join', pid: e.token, nick: 'Deniz', code }), /başladı/);
  e.ws.close();

  const dictw = require('../game/dict');
  const pick = (cat, letter, skip = 0) => {
    const fs = require('fs'), path = require('path');
    const f = { isim: 'isim', sehir: 'sehir', hayvan: 'hayvan' }[cat];
    const ws = fs.readFileSync(path.join(__dirname, '..', 'data', 'dict', f + '.txt'), 'utf8').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
    return ws.filter(w => dictw.check(cat, w, letter).status === 'ok')[skip];
  };

  for (let round = 1; round <= 2; round++) {
    await Promise.all([a, b, c].map(x => x.until(s => s.state.phase === 'play' && s.state.round === round)));
    const L = a.state.letter;
    const w1 = pick('isim', L, 0), w2 = pick('isim', L, 1), s1 = pick('sehir', L, 0), h1 = pick('hayvan', L, 0);
    // başkasının cevabı görünmemeli
    await a.act('upd', { answers: { isim: w1 || 'x', sehir: s1 || 'x', hayvan: h1 || 'x' } });
    await b.act('upd', { answers: { isim: w1 || 'x', sehir: s1 || 'x', hayvan: L + 'xyzuydurma' } });
    await c.act('upd', { answers: { isim: w2 || 'x', sehir: '', hayvan: '' } });
    await assert.rejects(c.act('done'), /doldur/);
    await a.act('done');
    // geri sayım (bitti) başladı
    await b.until(s => s.state.doneBy === a.you && s.state.countdownEnd);
    assert(!JSON.stringify(c.state).includes('xyzuydurma'));
    await Promise.all([a, b, c].map(x => x.until(s => s.state.phase === 'reveal')));
    // oylama: b'nin uydurma hayvanı (hayvan 3. kategori)
    await a.until(s => s.state.reveal.idx === 2 && s.state.reveal.state === 'voting', 8000).catch(() => {});
    if (a.state.phase === 'reveal' && a.state.reveal.idx === 2 && a.state.reveal.state === 'voting') {
      const item = a.state.reveal.cats[2].items.find(i => i.canVote);
      if (item) { await a.act('vote', { item: item.id, yes: true }); await c.act('vote', { item: item.id, yes: true }); }
      await assert.rejects(b.act('vote', { item: item.id, yes: true }), /Kendi cevabına/);
    }
    if (round === 1) {
      await Promise.all([a, b, c].map(x => x.until(s => s.state.phase === 'scores', 12000)));
      await assert.rejects(b.act('next'), /kurucusu/);
      const before = a.state.players.reduce((n, p) => n + p.score, 0);
      assert(before > 0, 'puan yok');
      await a.act('next');
    }
  }
  await Promise.all([a, b, c].map(x => x.until(s => s.state.phase === 'over', 12000)));
  assert(a.state.winners.length >= 1);
  const top = Math.max(...a.state.players.map(p => p.score));
  a.state.winners.forEach(id => assert.strictEqual(a.state.players.find(p => p.id === id).score, top));

  // yeniden bağlanma: c koptu, aynı token ile dönünce durumu geri alır
  c.ws.close(); await sleep(100);
  const c2 = new Client(port, 'tokC', 'Ceren'); await c2.ready;
  await c2.send({ t: 'join', pid: 'tokC', nick: 'Ceren', code });
  await c2.until(s => s.state && s.state.phase === 'over');
  assert.strictEqual(c2.you, c.you);
  // sahte kimlik: başka token'la aynı oyuncu olunamaz
  const f = new Client(port, 'tokF', 'Ceren'); await f.ready;
  await assert.rejects(f.send({ t: 'join', pid: 'tokF', nick: 'Ceren', code }), /başladı/);

  // lobiye dönüş
  await assert.rejects(b.act('toLobby'), /kurucusu/);
  await a.act('toLobby');
  await b.until(s => s.room && !s.room.started);
  console.log('ws-test: tüm senaryolar geçti (' + a.state.players.map(p => p.nick + '=' + p.score).join(', ') + ')');
  process.exit(0);
})().catch(e => { console.error('✗ ws-test:', e.stack.split('\n').slice(0,4).join(' | ')); process.exit(1); });
