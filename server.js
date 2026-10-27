// İsim Şehir sunucusu: statik dosyalar + WebSocket (bağımlılıksız) ile odalar ve oyun.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wsLite = require('./ws-lite');
const dict = require('./game/dict');
const { Game, GameError, sanitizeSettings, DEFAULTS } = require('./game/game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

// ---------- HTTP ----------
// Her açılışta dosya adlarına sürüm eklenir; tarayıcılar eski dosyayı önbellekten açmaz.
const VERSION = Date.now().toString(36);
const INDEX_HTML = () => fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace(/(href|src)="\/([\w.-]+\.(?:css|js))"/g, `$1="/$2?v=${VERSION}"`);
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch { url = '/'; }
  if (url === '/rooms') {
    const list = [];
    rooms.forEach(r => {
      if (r.game || r.settings.priv) return;
      const host = r.members.find(m => m.id === r.host);
      if (!host || !r.members.some(m => m.online)) return;
      list.push({ code: r.code, host: host.nick, n: r.members.length, max: MAX_PLAYERS, cats: r.settings.cats.length, dur: r.settings.duration });
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list.slice(0, 20)));
  }
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end(INDEX_HTML());
  }
  const file = path.join(PUBLIC, path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------- Odalar ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  let c;
  do { c = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(c));
  return c;
};
const newId = () => crypto.randomBytes(5).toString('hex');

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (room, msg) => room.members.forEach(m => send(m.ws, msg));

// Oyuncuların gizli oturum kodu (token) hiçbir zaman başkasına gönderilmez; herkese açık kimlik ayrı (id).
function roomView(room) {
  return {
    code: room.code, host: room.host, started: !!room.game, max: MAX_PLAYERS, settings: room.settings,
    members: room.members.map(m => ({ id: m.id, nick: m.nick, online: m.online })),
  };
}
const pushRoom = room => broadcast(room, { t: 'room', room: roomView(room) });
function pushState(room) {
  if (!room.game) return;
  room.members.forEach(m => {
    if (m.ws) send(m.ws, { t: 'state', state: { ...room.game.view(m.id), code: room.code } });
  });
}

function fixHost(room) {
  const g = room.game;
  const ok = m => m.online && !(g && g.players.get(m.id) && g.players.get(m.id).left);
  const cur = room.members.find(m => m.id === room.host);
  if (cur && ok(cur)) return;
  const next = room.members.find(ok) || room.members.find(m => !(g && g.players.get(m.id) && g.players.get(m.id).left));
  if (next) { room.host = next.id; if (g) g.setHost(next.id); }
}

function removeMember(room, id) {
  room.members = room.members.filter(x => x.id !== id);
  if (!room.members.length) { closeRoom(room); return; }
  fixHost(room);
  pushRoom(room);
}
function closeRoom(room) {
  if (room.timer) clearInterval(room.timer);
  rooms.delete(room.code);
}

// ---------- Takma ad filtresi ----------
function badNick(nick) { return dict.isBad(nick); }

class UserError extends Error {}
const uerr = m => { throw new UserError(m); };

// ---------- Mesajlar ----------
const handlers = {
  join(ws, d) {
    const token = String(d.pid || '').slice(0, 64);
    const nick = String(d.nick || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!token) uerr('Geçersiz oturum.');
    if (!nick) uerr('Takma ad boş olamaz.');
    if (badNick(nick)) uerr('Bu isim uygun değil, başka bir isim seç. 🙂');
    let room;
    if (d.create) {
      room = { code: newCode(), host: null, members: [], settings: { ...DEFAULTS, cats: DEFAULTS.cats.slice() }, game: null, timer: null, emptySince: null };
      rooms.set(room.code, room);
    } else {
      room = rooms.get(String(d.code || '').trim().toUpperCase());
      if (!room) uerr('Oda bulunamadı. Kodu kontrol et.');
    }
    if (ws.meta && (ws.meta.code !== room.code || ws.meta.token !== token)) handlers.leave(ws);

    let m = room.members.find(x => x.token === token);
    if (m) {
      if (m.ws && m.ws !== ws) { m.ws.meta = null; send(m.ws, { t: 'kicked', msg: 'Bu oyuncuya başka bir sekmeden bağlanıldı.' }); }
      m.ws = ws; m.online = true;
      clearTimeout(m.dropTimer);
      if (!room.game) m.nick = nick;
      else { room.game.rejoin(m.id); }
    } else {
      if (room.game) uerr('Bu odada oyun başladı, yeni oyuncu katılamaz.');
      if (room.members.length >= MAX_PLAYERS) uerr(`Oda dolu (en fazla ${MAX_PLAYERS} kişi).`);
      if (room.members.some(x => x.nick.toLocaleLowerCase('tr') === nick.toLocaleLowerCase('tr'))) uerr('Bu takma ad odada zaten var.');
      m = { id: newId(), token, nick, online: true, ws };
      room.members.push(m);
    }
    if (!room.host) room.host = m.id;
    room.emptySince = null;
    ws.meta = { code: room.code, token };
    send(ws, { t: 'joined', code: room.code, you: m.id, catalog: dict.CATEGORIES.map(c => ({ id: c.id, label: c.label, on: c.on })), defaults: DEFAULTS });
    fixHost(room);
    pushRoom(room);
    if (room.game) { room.game.setOnline(m.id, true); pushState(room); }
  },

  leave(ws) {
    if (!ws.meta) return;
    const { code, token } = ws.meta;
    ws.meta = null;
    const room = rooms.get(code);
    if (!room) return;
    const m = room.members.find(x => x.token === token);
    if (!m) return;
    m.online = false; m.ws = null;
    if (room.game) { room.game.leave(m.id); fixHost(room); pushRoom(room); pushState(room); } else removeMember(room, m.id);
  },

  settings(ws, d, room, me) {
    if (room.host !== me.id) uerr('Ayarları sadece oda kurucusu değiştirebilir.');
    if (room.game) uerr('Oyun başladı.');
    try { room.settings = sanitizeSettings(d.settings, room.settings); } catch (e) { if (e instanceof GameError) uerr(e.message); throw e; }
    pushRoom(room);
  },

  kick(ws, d, room, me) {
    if (room.host !== me.id) uerr('Sadece oda kurucusu oyuncu çıkarabilir.');
    if (room.game) uerr('Oyun başladı.');
    const t = room.members.find(x => x.id === String(d.id));
    if (!t || t.id === me.id) uerr('Oyuncu bulunamadı.');
    send(t.ws, { t: 'kicked', msg: 'Oda kurucusu seni odadan çıkardı.' });
    if (t.ws) t.ws.meta = null;
    removeMember(room, t.id);
  },

  start(ws, d, room, me) {
    if (room.host !== me.id) uerr('Oyunu sadece oda kurucusu başlatabilir.');
    if (room.game) uerr('Oyun zaten başladı.');
    const players = room.members.filter(x => x.online);
    if (!players.length) uerr('Oyuncu yok.');
    room.game = new Game(players.map(x => ({ id: x.id, nick: x.nick })), room.settings, {});
    room.game.setHost(room.host);
    room.members = players;                        // lobide düşmüş oyuncular çıkarılır
    room.timer = setInterval(() => { if (room.game && room.game.tick()) pushState(room); }, 200);
    if (room.timer.unref) room.timer.unref();
    pushRoom(room);
    pushState(room);
  },

  act(ws, d, room, me) {
    const g = room.game;
    if (!g) uerr('Oyun başlamadı.');
    const run = {
      upd: () => g.setAnswers(me.id, d.answers),
      done: () => g.done(me.id),
      vote: () => g.vote(me.id, String(d.item), !!d.yes),
      skip: () => g.skip(me.id),
      next: () => g.next(me.id),
      toLobby: () => {
        if (g.phase !== 'over') uerr('Oyun bitmeden lobiye dönülemez.');
        if (room.host !== me.id) uerr('Sadece oda kurucusu yeni oyun açabilir.');
        clearInterval(room.timer); room.timer = null; room.game = null;
        room.members = room.members.filter(x => x.online);
        fixHost(room);
        pushRoom(room);
        broadcast(room, { t: 'lobby' });
      },
    }[d.type];
    if (!run) uerr('Bilinmeyen işlem.');
    try { run(); } catch (e) { if (e instanceof GameError) uerr(e.message); throw e; }
    if (room.game && d.type !== 'upd') { room.game.tick(); pushState(room); }
  },
};

// ---------- WebSocket ----------
const wss = wsLite.attach(server, ws => {
  ws.isAlive = true;
  ws.meta = null;
  ws.msgCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    if (++ws.msgCount > 80) return;                // saniyede en fazla 80 mesaj
    let d;
    try { d = JSON.parse(raw); } catch { return; }
    if (!d || typeof d.t !== 'string') return;
    if (d.t === 'ping') return send(ws, { t: 'pong' });
    const h = handlers[d.t];
    if (!h) return;
    try {
      if (d.t === 'join' || d.t === 'leave') h(ws, d);
      else {
        if (!ws.meta) uerr('Bir odada değilsin.');
        const room = rooms.get(ws.meta.code);
        if (!room) uerr('Oda kapanmış.');
        const me = room.members.find(x => x.token === ws.meta.token);
        if (!me) uerr('Odada değilsin.');
        if (d.t === 'act') h(ws, d, room, me); else h(ws, d, room, me);
      }
      if (d.rid) send(ws, { t: 'ack', rid: d.rid });
    } catch (e) {
      if (!(e instanceof UserError)) console.error('Hata:', e);
      send(ws, { t: 'err', rid: d.rid, msg: e instanceof UserError ? e.message : 'Beklenmeyen bir hata oldu.' });
    }
  });

  ws.on('close', () => {
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.code);
    if (!room) return;
    const m = room.members.find(x => x.token === ws.meta.token);
    if (!m || m.ws !== ws) return;
    m.online = false; m.ws = null;
    if (room.game) {
      room.game.setOnline(m.id, false);
      fixHost(room);
    } else {
      // Lobide 45 sn içinde geri gelmezse odadan çıkar
      m.dropTimer = setTimeout(() => { if (!m.online && !room.game) removeMember(room, m.id); }, 45000);
    }
    if (room.members.every(x => !x.online)) room.emptySince = Date.now();
    pushRoom(room); pushState(room);
  });
});

// Bağlantı canlılık kontrolü, mesaj sayacı sıfırlama ve boş oda temizliği
setInterval(() => {
  wss.clients.forEach(ws => {
    ws.msgCount = 0;
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
  const now = Date.now();
  rooms.forEach(room => {
    if (room.members.some(m => m.online)) { room.emptySince = null; return; }
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > 3 * 60 * 1000) closeRoom(room);
  });
}, 15000).unref();
setInterval(() => wss.clients.forEach(ws => { ws.msgCount = 0; }), 1000).unref();

if (require.main === module) {
  dict.initRemote().finally(() => server.listen(PORT, () => console.log(`İsim Şehir çalışıyor → http://localhost:${PORT}`)));
}
module.exports = server;
