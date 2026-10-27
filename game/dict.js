// Sözlükler, kategori listesi ve cevap kontrolü (otomatik katman).
// check() cevabı üç gruba ayırır: ok (sözlükte var) / disputed (sözlükte yok, oylanır) / bad (geçersiz).
const fs = require('fs');
const path = require('path');

const DICT_DIR = path.join(__dirname, '..', 'data', 'dict');
const CAND_FILE = process.env.ISIM_CAND_FILE || path.join(__dirname, '..', 'data', 'candidates.json');
const NEED_GAMES = 3;   // bir cevap sözlüğe girmek için bu kadar FARKLI oyunda oyuncularca kabul edilmeli
const LEARNED_FILE = process.env.ISIM_LEARNED_FILE || path.join(__dirname, '..', 'data', 'learned.json');

// Kategori listesi: ilk beşi varsayılan açık
const CATEGORIES = [
  { id: 'isim', label: 'İsim', file: 'isim.txt', on: true },
  { id: 'sehir', label: 'Şehir', file: 'sehir.txt', on: true },
  { id: 'hayvan', label: 'Hayvan', file: 'hayvan.txt', on: true },
  { id: 'bitki', label: 'Bitki', file: 'bitki.txt', on: true },
  { id: 'esya', label: 'Eşya', file: 'esya.txt', on: true },
  { id: 'ulke', label: 'Ülke', file: 'ulke.txt', on: false },
  { id: 'meslek', label: 'Meslek', file: 'meslek.txt', on: false },
  { id: 'yiyecek', label: 'Yiyecek', file: 'yiyecek.txt', on: false },
  { id: 'icecek', label: 'İçecek', section: 'icecek', on: false },
  { id: 'marka', label: 'Marka', section: 'marka', on: false },
  { id: 'spor', label: 'Spor', section: 'spor', on: false },
  { id: 'organ', label: 'Vücut', section: 'organ', on: false },
];
const CAT_IDS = CATEGORIES.map(c => c.id);

// Harf havuzu: Ğ hiç yok; J, Ö, Ü, I "zor harf" olarak ayrı
const LETTERS = ['A', 'B', 'C', 'Ç', 'D', 'E', 'F', 'G', 'H', 'İ', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'Ş', 'T', 'U', 'V', 'Y', 'Z'];
const HARD_LETTERS = ['J', 'Ö', 'Ü', 'I'];

const lower = s => String(s).toLocaleLowerCase('tr');
// Türkçe karakterleri sadeleştir, sadece a-z0-9 bırak (boşluk, tire, nokta yok sayılır)
function fold(s) {
  return lower(s)
    .replace(/[âäàá]/g, 'a').replace(/[êëèé]/g, 'e').replace(/[îïìí]/g, 'i').replace(/[ôòó]/g, 'o').replace(/[ûùú]/g, 'u')
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/[ıi̇]/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]/g, '');
}
const firstLetter = s => { const m = lower(s).match(/\p{L}/u); return m ? m[0] : ''; };
const cleanText = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 40);

// ---- küfür/uygunsuz kelime filtresi (cevaplarda 0 puan) ----
const normBad = t => lower(t).replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');
const BAD_ANY = ['orospu', 'orosbu', 'yarrak', 'yarak', 'amcik', 'amina', 'aminak', 'anani', 'ananin', 'siktir', 'sikik', 'sikis', 'sikerim', 'sikici', 'sokuk',
  'pezevenk', 'kahpe', 'yavsak', 'gavat', 'surtuk', 'kaltak', 'dalyarak', 'tassak', 'tasak', 'fuck', 'shit', 'bitch', 'puttana', 'serefsiz'];
const BAD_START = ['sik', 'ibne', 'amk', 'orsp'];
const BAD_WORD = ['aq', 'amk', 'mk', 'oc', 'got', 'pic', 'pust', 'sg', 'siq'];
function isBad(text) {
  const n = normBad(text), squash = n.replace(/[^a-z]/g, '');
  if (BAD_ANY.some(w => squash.includes(w))) return true;
  const words = n.split(/[^a-z]+/).filter(Boolean);
  return words.some(w => BAD_WORD.includes(w) || BAD_START.some(b => w.startsWith(b)));
}

// ---- sözlükleri yükle ----
const splitList = t => t.split(/[,\n]/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
const dicts = {};            // catId -> Map(foldKey -> canonical)
const byLen = {};            // catId -> Map(length -> [foldKey])  (bulanık eşleşme için)
function addWord(cat, word) {
  const k = fold(word);
  if (k.length < 2) return false;
  const d = dicts[cat];
  if (d.has(k)) return false;
  d.set(k, cleanText(word));
  const l = byLen[cat];
  if (!l.has(k.length)) l.set(k.length, []);
  l.get(k.length).push(k);
  return true;
}
function load() {
  const sections = {};
  const multi = fs.readFileSync(path.join(DICT_DIR, 'diger.txt'), 'utf8');
  let cur = null;
  multi.split('\n').forEach(line => {
    if (line.startsWith('#')) { cur = line.slice(1).trim(); sections[cur] = ''; } else if (cur) sections[cur] += line + ',';
  });
  CATEGORIES.forEach(c => {
    dicts[c.id] = new Map(); byLen[c.id] = new Map();
    const text = c.file ? fs.readFileSync(path.join(DICT_DIR, c.file), 'utf8') : (sections[c.section] || '');
    splitList(text.replace(/\n/g, ',')).forEach(w => addWord(c.id, w));
  });
  try {
    const learned = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    Object.keys(learned).forEach(c => { if (dicts[c] && Array.isArray(learned[c])) learned[c].forEach(w => addWord(c, w)); });
  } catch { /* ilk çalıştırmada dosya yok */ }
}
load();

// ---- oyunda öğrenilen cevaplar (oylamayla kabul edilenler) ----
// Kalıcılık: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN varsa Upstash Redis (Render'da disk silinir),
// yoksa data/*.json dosyaları. Bağımlılık yok, sadece fetch.
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), R_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const remote = !!(R_URL && R_TOKEN);
async function rcmd(cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
let learnedAll = {};
try { learnedAll = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); } catch {}
let cands = {};
try { cands = JSON.parse(fs.readFileSync(CAND_FILE, 'utf8')); } catch {}
async function initRemote() {           // sunucu açılırken bir kez: Redis'teki kayıtları yükle
  if (!remote) return false;
  try {
    const [l, c] = await Promise.all([rcmd(['GET', 'isim:learned']), rcmd(['GET', 'isim:cands'])]);
    const L = l ? JSON.parse(l) : {};
    Object.keys(L).forEach(cat => { if (dicts[cat] && Array.isArray(L[cat])) { L[cat].forEach(w => addWord(cat, w)); learnedAll[cat] = Array.from(new Set([...(learnedAll[cat] || []), ...L[cat]])); } });
    if (c) Object.assign(cands, JSON.parse(c));
    return true;
  } catch (e) { console.log('Redis okunamadı:', e.message); return false; }
}
function persist(kind) {
  const file = kind === 'learned' ? LEARNED_FILE : CAND_FILE, data = JSON.stringify(kind === 'learned' ? learnedAll : cands);
  try { fs.writeFileSync(file, data); } catch { /* disk yazılamazsa sorun değil */ }
  if (remote) rcmd(['SET', 'isim:' + kind, data]).catch(e => console.log('Redis yazılamadı:', e.message));
}
const timers = {};
function later(kind) { clearTimeout(timers[kind]); timers[kind] = setTimeout(() => persist(kind), 2000); if (timers[kind].unref) timers[kind].unref(); }
function learn(cat, text) {
  if (!dicts[cat]) return;
  const t = cleanText(text);
  if (t.length < 2 || isBad(t) || !addWord(cat, t)) return;
  (learnedAll[cat] = learnedAll[cat] || []).push(t);
  later('learned');
}

// Oyuncuların çoğunluğunca kabul edilen sözlük dışı cevap: aday olarak sayılır,
// NEED_GAMES farklı oyunda kabul edilirse sözlüğe girer.
function suggest(cat, text, gameId) {
  if (!dicts[cat]) return false;
  const t = cleanText(text);
  if (t.length < 2 || isBad(t)) return false;
  const key = cat + '|' + fold(t);
  const c = cands[key] = cands[key] || { text: t, games: [] };
  if (!c.games.includes(gameId)) c.games.push(gameId);
  let promoted = false;
  if (c.games.length >= NEED_GAMES) { learn(cat, c.text); delete cands[key]; promoted = true; }
  later('cands');
  return promoted;
}

function lev1(a, b) { // iki kelime arasında en çok 1 düzenleme var mı?
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la === lb) { // yer değiştirme (ab ↔ ba) ya da tek harf farkı
      if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
    } else if (la > lb) i++; else j++;
  }
  return diff + (la - i) + (lb - j) <= 1;
}

// Cevabın harfle başlayıp başlamadığı (Türkçe i/ı, ç/c ayrımı yapılır)
const startsWithLetter = (text, letter) => firstLetter(text) === lower(letter);

/**
 * Cevabı kontrol et.
 * Dönüş: { status: 'ok'|'disputed'|'bad', key, text, canon?, reason? }
 *  - key: aynı cevapları gruplamak için (Ankra ≈ Ankara aynı anahtarı alır)
 */
function check(cat, rawText, letter) {
  const text = cleanText(rawText);
  if (!text) return { status: 'bad', reason: 'boş', text: '' };
  if (!dicts[cat]) return { status: 'bad', reason: 'kategori yok', text };
  const f = fold(text);
  if (f.length < 2 || !/\p{L}/u.test(text)) return { status: 'bad', reason: 'çok kısa', text };
  if (isBad(text)) return { status: 'bad', reason: 'uygunsuz', text };

  const d = dicts[cat];
  const hit = k => {
    const canon = d.get(k);
    if (!canon) return null;
    return startsWithLetter(canon, letter) ? { status: 'ok', key: 'd:' + k, text, canon } : { status: 'bad', reason: 'harf', text };
  };
  // 1) birebir
  let r = hit(f);
  if (r) return r;
  // 2) çoğul eki (kediler → kedi)
  const m = f.match(/^(.{3,}?)(lar|ler)$/);
  if (m && (r = hit(m[1]))) return r;
  // 3) yazım hatası: temkinli. En az 6 harf, ilk VE son harf aynı, tek bir düzenleme ve sözlükte TEK aday olmalı.
  //    Birden fazla benzer kelime varsa yuvarlamaz, oylamaya gider.
  if (f.length >= 6) {
    const pool = [].concat(byLen[cat].get(f.length - 1) || [], byLen[cat].get(f.length) || [], byLen[cat].get(f.length + 1) || []);
    const near = pool.filter(k => k[0] === f[0] && k[k.length - 1] === f[f.length - 1] && lev1(f, k));
    if (near.length === 1) {
      const canon = d.get(near[0]);
      if (startsWithLetter(canon, letter)) return { status: 'ok', key: 'd:' + near[0], text, canon, fuzzy: true };
    }
  }
  // 4) sözlükte yok → harf doğruysa oylanır
  if (!startsWithLetter(text, letter)) return { status: 'bad', reason: 'harf', text };
  return { status: 'disputed', key: 'u:' + f, text };
}

module.exports = { CATEGORIES, CAT_IDS, LETTERS, HARD_LETTERS, fold, check, learn, suggest, initRemote, cleanText, isBad, firstLetter, lower, size: cat => (dicts[cat] ? dicts[cat].size : 0) };
