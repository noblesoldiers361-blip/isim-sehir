// Sözlük kontrolü + oyun motoru birim testleri (sahte saat ile).
process.env.ISIM_LEARNED_FILE = require('path').join(require('os').tmpdir(), 'isim-learned-test-' + process.pid + '.json');
const assert = require('assert');
const dict = require('../game/dict');
const { Game, GameError, sanitizeSettings, T } = require('../game/game');

let n = 0;
let uniq = 0; const nonsense = () => 'Azx' + (++uniq) + 'qvw'.replace(/\d/g,'') + String.fromCharCode(97 + uniq % 26) + String.fromCharCode(98 + (uniq * 7) % 24) + 'plo';
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error('✗', name, '\n', e.message); process.exitCode = 1; } };

// ---------- sözlük ----------
ok('birebir eşleşme', () => assert.strictEqual(dict.check('sehir', 'Ankara', 'A').status, 'ok'));
ok('küçük harf / boşluk', () => assert.strictEqual(dict.check('sehir', '  ankara ', 'A').status, 'ok'));
ok('Türkçe karakter yazılmadan (sisli → Şişli)', () => assert.strictEqual(dict.check('sehir', 'sisli', 'Ş').status, 'ok'));
ok('yanlış harf = bad', () => assert.deepStrictEqual([dict.check('sehir', 'Ankara', 'B').status, dict.check('sehir', 'Ankara', 'B').reason], ['bad', 'harf']));
ok('I / İ ayrımı', () => { assert.strictEqual(dict.check('sehir', 'İzmir', 'İ').status, 'ok'); assert.strictEqual(dict.check('sehir', 'İzmir', 'I').status, 'bad'); });
ok('çoğul eki', () => { const r = dict.check('hayvan', 'kediler', 'K'); assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.key, dict.check('hayvan', 'Kedi', 'K').key); });
ok('yazım hatası aynı anahtarı alır', () => assert.strictEqual(dict.check('sehir', 'ankra', 'A').key, dict.check('sehir', 'Ankara', 'A').key));
ok('kısa kelimede bulanık eşleşme yok', () => assert.notStrictEqual(dict.check('hayvan', 'kedo', 'K').status, 'ok'));
ok('sözlükte yok = disputed', () => assert.strictEqual(dict.check('isim', 'Asdfgh', 'A').status, 'disputed'));
ok('boş = bad', () => assert.strictEqual(dict.check('isim', '   ', 'A').status, 'bad'));
ok('tek harf = bad', () => assert.strictEqual(dict.check('isim', 'A', 'A').status, 'bad'));
ok('küfür = bad', () => assert.strictEqual(dict.check('isim', 'siktir', 'S').reason, 'uygunsuz'));
ok('çok kategori yüklü', () => dict.CAT_IDS.forEach(c => assert(dict.size(c) > 40, c)));

// ---------- ayarlar ----------
ok('ayar doğrulama', () => {
  assert.throws(() => sanitizeSettings({ cats: [] }), GameError);
  assert.throws(() => sanitizeSettings({ duration: 5000 }), GameError);
  assert.throws(() => sanitizeSettings({ endMode: 'x' }), GameError);
  const s = sanitizeSettings({ cats: ['esya', 'isim', 'ulke'], endMode: 'points' });
  assert.deepStrictEqual(s.cats, ['isim', 'esya', 'ulke']);        // katalog sırası
  assert.strictEqual(s.target, 150);
});

// ---------- oyun akışı ----------
function mk(settings, pcount = 3) {
  let t = 1000;
  const clock = { now: () => t, add: ms => { t += ms; } };
  const players = Array.from({ length: pcount }, (_, i) => ({ id: 'p' + (i + 1), nick: 'Oyuncu' + (i + 1) }));
  const g = new Game(players, { cats: ['isim', 'sehir'], duration: 60, ...settings }, {}, { now: clock.now });
  const adv = ms => { clock.add(ms); g.tick(); };
  return { g, adv, clock };
}
function toPlay(m) { m.adv(T.ready + 10); assert.strictEqual(m.g.phase, 'play'); }
function toReveal(m) { m.adv(m.g.settings.duration * 1000 + 10); assert.strictEqual(m.g.phase, 'grace'); m.adv(T.grace + 10); assert.strictEqual(m.g.phase, 'reveal'); }

// harfe uygun cevapları elle seçmek için sözlükten ilk eşleşen kelime
function word(cat, letter, skip = 0) {
  const fs = require('fs'), path = require('path');
  const file = { isim: 'isim', sehir: 'sehir' }[cat];
  const words = fs.readFileSync(path.join(__dirname, '..', 'data', 'dict', file + '.txt'), 'utf8').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  const list = words.filter(w => dict.check(cat, w, letter).status === 'ok');
  return list[skip];
}

ok('puanlama: aynı 5, farklı 10, boş 0', () => {
  const m = mk(); const g = m.g;
  g.rd.letter = 'A';
  toPlay(m);
  const a1 = word('isim', 'A', 0), a2 = word('isim', 'A', 1), c1 = word('sehir', 'A', 0);
  g.setAnswers('p1', { isim: a1, sehir: c1 });
  g.setAnswers('p2', { isim: a1, sehir: c1 });
  g.setAnswers('p3', { isim: a2, sehir: '' });
  toReveal(m);
  // oylama yok, kategori 1 doğrudan "shown"
  assert.strictEqual(g.rd.step.state, 'shown');
  m.adv(T.stepBase + 10);                      // 2. kategoriye geç
  assert.strictEqual(g.rd.revealIdx, 1);
  m.adv(T.stepBase + 10);                      // bitiş
  assert.strictEqual(g.phase, 'scores');
  const sc = Object.fromEntries([...g.players.values()].map(p => [p.id, p.score]));
  assert.deepStrictEqual(sc, { p1: 5 + 5, p2: 5 + 5, p3: 10 + 0 });
});

ok('BİTTİ: tüm kutular dolu olmalı, geri sayım başlar', () => {
  const m = mk(); const g = m.g; toPlay(m);
  assert.throws(() => g.done('p1'), GameError);
  g.setAnswers('p1', { isim: 'Ali', sehir: 'Adana' });
  g.done('p1');
  assert(g.rd.countdownEnd && g.rd.countdownEnd - m.clock.now() <= 20000);
  assert.strictEqual(g.rd.doneBy, 'p1');
  m.adv(20000 + 10);
  assert.strictEqual(g.phase, 'grace');
});

ok('herkes bitirince tur erken biter', () => {
  const m = mk(); const g = m.g; toPlay(m);
  ['p1', 'p2', 'p3'].forEach(p => { g.setAnswers(p, { isim: 'Ali', sehir: 'Adana' }); g.done(p); });
  m.adv(10);
  assert.strictEqual(g.phase, 'grace');
});

ok('bitti dedikten sonra kutu boşaltılırsa bitti iptal', () => {
  const m = mk(); const g = m.g; toPlay(m);
  g.setAnswers('p1', { isim: 'Ali', sehir: 'Adana' }); g.done('p1');
  g.setAnswers('p1', { isim: '' });
  assert.strictEqual(g.rd.done.p1, undefined);
});

ok('süre bitince son cevaplar grace içinde kabul edilir', () => {
  const m = mk(); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  m.adv(g.settings.duration * 1000 + 10);
  assert.strictEqual(g.phase, 'grace');
  g.setAnswers('p1', { isim: word('isim', 'A', 0) });
  m.adv(T.grace + 10);
  assert.strictEqual(g.rd.entries.isim.find(e => e.pid === 'p1').status, 'ok');
});

ok('oylama: sözlükte olmayan cevap çoğunlukla kabul, 5/10 puan, kendi oyu yok', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  g.setAnswers('p1', { isim: nonsense() });          // sözlükte yok
  g.setAnswers('p2', { isim: word('isim', 'A', 0) });
  g.setAnswers('p3', { isim: '' });
  toReveal(m);
  assert.strictEqual(g.rd.step.state, 'voting');
  const item = Object.values(g.rd.items)[0];
  assert.throws(() => g.vote('p1', item.id, true), GameError);        // kendi cevabı
  g.vote('p2', item.id, true); g.vote('p3', item.id, true);
  m.adv(10);                                                           // herkes oy verdi → kısa süre sonra karar
  m.adv(T.stepAfterVotes + 50);
  assert.strictEqual(item.verdict, true);
  assert.strictEqual(g.players.get('p1').score, 10);
  assert.strictEqual(g.players.get('p2').score, 10);
  assert.strictEqual(g.players.get('p3').score, 0);
});

ok('oylama: çoğunluk ret → 0 puan', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  g.setAnswers('p1', { isim: nonsense() }); g.setAnswers('p2', { isim: nonsense() }); g.setAnswers('p3', { isim: '' });
  toReveal(m);
  const items = Object.values(g.rd.items);
  items.forEach(it => { g.vote('p3', it.id, false); });
  g.vote('p2', items.find(i => i.authors[0] === 'p1').id, false);
  g.vote('p1', items.find(i => i.authors[0] === 'p2').id, true);
  m.adv(T.stepDispute + 10);
  assert.strictEqual(items.find(i => i.authors[0] === 'p1').verdict, false);
  assert.strictEqual(items.find(i => i.authors[0] === 'p2').verdict, false);   // 1 evet 1 hayır = eşit → ret
  assert([...g.players.values()].every(p => p.score === 0));
});

ok('oy verecek kimse yoksa (tek oyuncu) cevap kabul edilir', () => {
  const m = mk({ cats: ['isim'] }, 1); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  g.setAnswers('p1', { isim: nonsense() });
  toReveal(m);
  assert.strictEqual(g.rd.step.state, 'shown');
  assert.strictEqual(g.players.get('p1').score, 10);
});

ok('çevrimdışı oyuncu oylamayı bekletmez', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  g.setAnswers('p1', { isim: nonsense() }); g.setAnswers('p2', { isim: word('isim', 'A', 0) });
  g.setOnline('p3', false);
  toReveal(m);
  const item = Object.values(g.rd.items)[0];
  g.vote('p2', item.id, true);
  m.adv(10); m.adv(T.stepAfterVotes + 50);
  assert.strictEqual(item.verdict, true);
});

ok('tur sayısı bitince oyun biter, kazanan en yüksek puan', () => {
  const m = mk({ endMode: 'rounds', target: 2, cats: ['isim'] }); const g = m.g;
  for (let r = 1; r <= 2; r++) {
    g.rd.letter = 'A'; toPlay(m);
    g.setAnswers('p1', { isim: word('isim', 'A', 0) });
    toReveal(m);
    m.adv(T.stepBase + 10);
    if (r === 1) { assert.strictEqual(g.phase, 'scores'); g.next('p1'); }
  }
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.winners, ['p1']);
});

ok('hedef puan: berabere ise devam eder', () => {
  const m = mk({ endMode: 'points', target: 20, cats: ['isim'] }, 2); const g = m.g;
  g.players.get('p1').score = 20; g.players.get('p2').score = 20;
  g.rd.letter = 'A'; toPlay(m); toReveal(m); m.adv(T.stepBase + 10);
  assert.strictEqual(g.phase, 'scores');
  g.next('p1');
  g.players.get('p1').score = 30; g.players.get('p2').score = 20;
  g.rd.letter = 'A'; toPlay(m); toReveal(m); m.adv(T.stepBase + 10);
  assert.strictEqual(g.phase, 'over');
  assert.deepStrictEqual(g.winners, ['p1']);
});

ok('sadece kurucu devam ettirir', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; toPlay(m); toReveal(m); m.adv(T.stepBase + 10);
  assert.strictEqual(g.phase, 'scores');
  assert.throws(() => g.next('p2'), GameError);
  g.next('p1'); assert.strictEqual(g.phase, 'ready'); assert.strictEqual(g.round, 2);
});

ok('puan listesinde kurucu devam etmezse otomatik yeni tur', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; toPlay(m); toReveal(m); m.adv(T.stepBase + 10);
  m.adv(T.scoresAuto + 10);
  assert.strictEqual(g.phase, 'ready');
});

ok('harfler tekrar etmez', () => {
  const m = mk(); const seen = new Set();
  for (let i = 0; i < 20; i++) { seen.add(m.g.rd.letter); m.g.startRound(); }
  assert(seen.size >= 15);
});

ok('görünüm: tur sırasında başkasının cevabı sızmaz', () => {
  const m = mk(); const g = m.g; toPlay(m);
  g.setAnswers('p1', { isim: 'GizliCevap', sehir: 'Adana' });
  assert(!JSON.stringify(g.view('p2')).includes('GizliCevap'));
  assert(JSON.stringify(g.view('p1')).includes('GizliCevap'));
});

ok('görünüm: oylamada başkasının oyu gizli, karardan sonra sayılar görünür', () => {
  const m = mk({ cats: ['isim'] }); const g = m.g; g.rd.letter = 'A'; toPlay(m);
  g.setAnswers('p1', { isim: nonsense() }); g.setAnswers('p2', { isim: word('isim', 'A', 0) });
  toReveal(m);
  const it = Object.values(g.rd.items)[0];
  g.vote('p2', it.id, true);
  const v3 = g.view('p3').reveal.cats[0].items[0];
  assert.strictEqual(v3.myVote, null); assert.strictEqual(v3.yes, null); assert.strictEqual(v3.voted, 1);
  assert.strictEqual(g.view('p2').reveal.cats[0].items[0].myVote, true);
});

console.log(n + ' test geçti' + (process.exitCode ? ', BAZILARI KALDI' : ''));
