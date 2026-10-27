// İsim Şehir istemcisi
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lower = s => String(s).toLocaleLowerCase('tr');
  const fold = s => lower(s).replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/[ıi̇]/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u').replace(/[^a-z0-9]/g, '');
  const firstLetter = s => { const m = lower(s).match(/\p{L}/u); return m ? m[0] : ''; };
  const rnd = () => { try { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); } catch { return Math.random().toString(16).slice(2) + Date.now().toString(16); } };

  // ---------- kimlik / durum ----------
  let token = LS.get('is_pid'); if (!token) { token = rnd(); LS.set('is_pid', token); }
  let nick = LS.get('is_nick') || '';
  let roomCode = LS.get('is_room') || null;
  let me = null, room = null, S = null, catalog = [];
  let ws = null, wsReady = false, rid = 0, lastMsg = Date.now(), reconnectTimer = null;
  const waiting = {};
  let offset = 0;                      // sunucu saati - yerel saat
  const now = () => Date.now() + offset;
  const invite = (new URLSearchParams(location.search).get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

  // ---------- ses ----------
  let actx = null, sound = LS.get('is_sound', '1') !== '0';
  function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (actx && actx.state === 'suspended') actx.resume(); return actx; }
  function beep(f, d = .12, type = 'triangle', vol = .06, delay = 0) {
    if (!sound) return; const a = audio(); if (!a) return;
    try { const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + d); o.connect(g).connect(a.destination); o.start(t); o.stop(t + d + .02); } catch {}
  }
  function noise(d = .08, vol = .04, freq = 3000, delay = 0) {
    if (!sound) return; const a = audio(); if (!a) return;
    try {
      const t = a.currentTime + delay, n = Math.floor(a.sampleRate * d), buf = a.createBuffer(1, n, a.sampleRate), ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      f.type = 'bandpass'; f.frequency.value = freq; g.gain.value = vol; src.buffer = buf; src.connect(f).connect(g).connect(a.destination); src.start(t);
    } catch {}
  }
  const SFX = {
    tick() { beep(880, .06, 'square', .03); },
    click() { beep(660, .04, 'triangle', .035); },
    key() { noise(.03, .02, 4200); },                                   // kalem sesi
    go() { [523, 659, 784, 1047].forEach((f, i) => beep(f, .16, 'triangle', .06, i * .08)); },
    letter() { noise(.12, .05, 2200); beep(330, .1, 'sine', .05, .05); beep(494, .16, 'sine', .05, .12); },
    bell() { beep(1046, .6, 'sine', .07); beep(1568, .5, 'sine', .04, .05); },
    pop() { beep(520, .08, 'sine', .06); },
    ding() { beep(784, .1, 'triangle', .05); beep(1175, .18, 'triangle', .05, .07); },
    double() { beep(1175, .1, 'triangle', .05); beep(1568, .1, 'triangle', .05, .08); beep(2093, .22, 'triangle', .05, .16); },
    stamp() { beep(110, .12, 'sine', .12); noise(.06, .06, 900); },
    nope() { beep(250, .12, 'sawtooth', .04); beep(190, .22, 'sawtooth', .04, .1); },
    vote() { beep(600, .06, 'sine', .05); beep(800, .08, 'sine', .05, .06); },
    score() { [392, 494, 587].forEach((f, i) => beep(f, .14, 'triangle', .05, i * .09)); },
    join() { beep(698, .08, 'sine', .04); beep(932, .12, 'sine', .04, .07); },
    win() { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => beep(f, .24, 'triangle', .07, i * .13)); },
  };
  let vib = LS.get('is_vib', '1') !== '0';
  const buzz = ms => { try { vib && navigator.vibrate && navigator.vibrate(ms); } catch {} };

  // ---------- ekran yönetimi ----------
  let cur = 'home';
  function show(id) {
    cur = id;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'scr-' + id));
    const g = ['ready', 'play', 'reveal', 'scores', 'over'].includes(id);
    wake(g);
  }
  function toast(msg, kind) {
    const el = document.createElement('div'); el.className = 'toast' + (kind === 'err' ? ' err' : ''); el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3200);
  }
  let wakeLock = null;
  async function wake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }
  // klavye açılınca görünür alana göre yüksekliği ayarla (Noblepoly'deki --vvh düzeltmesi)
  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--vvh', h + 'px');
    // telefonda klavye açıkken üst çubuğu küçült ki yazılan kutu ve BİTTİ butonu sığsın
    let kb = false; try { kb = matchMedia('(pointer: coarse)').matches && h < (window.screen.height || h) * 0.72 && innerHeight >= innerWidth * 0.9; } catch {}
    document.body.classList.toggle('kb', kb);
    $('#app').style.top = (vv ? vv.offsetTop : 0) + 'px';
    if (!vv || vv.offsetTop === 0) window.scrollTo(0, 0);
    const f = document.activeElement;
    if (f && f.tagName === 'INPUT' && f.type === 'text') setTimeout(() => { try { f.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {} }, 60);
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); }
  window.addEventListener('resize', fitViewport); window.addEventListener('orientationchange', () => setTimeout(fitViewport, 200));
  fitViewport();

  // ---------- bağlantı ----------
  function connect() {
    clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}`);
    ws = sock;
    sock.onopen = () => {
      wsReady = true; lastMsg = Date.now(); $('#conn').classList.add('hidden');
      if (roomCode && nick) {
        send({ t: 'join', pid: token, nick, code: roomCode }, true).then(() => { if (S && S.phase === 'play') sendAnswersNow(); }).catch(() => {
          LS.del('is_room'); roomCode = null; room = null; S = null; show('home');
        });
      }
    };
    sock.onmessage = e => { lastMsg = Date.now(); let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    sock.onclose = () => {
      if (ws !== sock) return;
      wsReady = false;
      Object.values(waiting).forEach(w => w.rej(new Error('koptu')));
      if (roomCode) $('#conn').classList.remove('hidden');
      reconnectTimer = setTimeout(connect, 1500);
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  }
  function send(msg, quiet) {
    return new Promise((res, rej) => {
      if (!wsReady) { if (!quiet) toast('Sunucuya bağlı değilsin.', 'err'); return rej(new Error('bağlı değil')); }
      msg.rid = ++rid;
      waiting[msg.rid] = { res, rej, quiet };
      ws.send(JSON.stringify(msg));
    });
  }
  const act = (type, extra = {}) => send({ t: 'act', type, ...extra }).catch(() => {});
  // Canlılık: 10 sn'de bir ping; 25 sn cevap yoksa bağlantı ölü sayılır ve yeniden kurulur
  setInterval(() => {
    if (!wsReady) return;
    try { ws.send('{"t":"ping"}'); } catch {}
    if (Date.now() - lastMsg > 25000) dropSocket();
  }, 10000);
  function dropSocket() {
    const old = ws; wsReady = false;
    if (roomCode) $('#conn').classList.remove('hidden');
    try { old.onclose = null; old.close(); } catch {}
    Object.values(waiting).forEach(w => w.rej(new Error('koptu')));
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 300);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!wsReady) connect(); else { try { ws.send('{"t":"ping"}'); } catch {} }
    if (cur !== 'home' && cur !== 'lobby') wake(true);
  });
  window.addEventListener('offline', () => { if (roomCode) $('#conn').classList.remove('hidden'); });
  window.addEventListener('online', () => { if (ws && wsReady) dropSocket(); else connect(); });

  function handle(m) {
    switch (m.t) {
      case 'ack': if (waiting[m.rid]) { waiting[m.rid].res(); delete waiting[m.rid]; } break;
      case 'err':
        if (waiting[m.rid]) { if (!waiting[m.rid].quiet) toast(m.msg, 'err'); waiting[m.rid].rej(new Error(m.msg)); delete waiting[m.rid]; } else toast(m.msg, 'err');
        break;
      case 'joined':
        me = m.you; roomCode = m.code; LS.set('is_room', m.code); catalog = m.catalog;
        if (invite) history.replaceState(null, '', '/');
        break;
      case 'room':
        if (room && m.room.code === room.code && m.room.members.length > room.members.length && !m.room.started) SFX.join();
        room = m.room;
        if (!room.started) { S = null; show('lobby'); renderLobby(); } else if (!S) renderLobby();
        break;
      case 'state': onState(m.state); break;
      case 'lobby': S = null; show('lobby'); if (room) renderLobby(); break;
      case 'kicked': toast(m.msg, 'err'); roomCode = null; room = null; S = null; LS.del('is_room'); show('home'); break;
      default: break;
    }
  }

  // ---------- GİRİŞ ----------
  const nickEl = $('#nick'), codeEl = $('#code');
  nickEl.value = nick; if (invite) codeEl.value = invite;
  function homeGo(create) {
    const n = nickEl.value.trim().replace(/\s+/g, ' ');
    if (!n) { toast('Önce bir takma ad yaz.', 'err'); nickEl.focus(); return; }
    const code = codeEl.value.trim().toUpperCase();
    if (!create && code.length < 5) { toast('Oda kodu 5 karakter.', 'err'); codeEl.focus(); return; }
    audio();
    nick = n; LS.set('is_nick', n);
    send(create ? { t: 'join', pid: token, nick, create: true } : { t: 'join', pid: token, nick, code }).catch(() => {});
  }
  $('#btn-create').onclick = () => homeGo(true);
  $('#home-form').onsubmit = e => { e.preventDefault(); if (codeEl.value.trim()) homeGo(false); else if (document.activeElement === nickEl) homeGo(true); else homeGo(false); };
  nickEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); codeEl.value.trim() ? homeGo(false) : homeGo(true); } });
  $('#btn-rules').onclick = () => $('#modal-rules').classList.remove('hidden');
  $('#btn-rules-close').onclick = () => $('#modal-rules').classList.add('hidden');
  $('#modal-rules').onclick = e => { if (e.target.id === 'modal-rules') $('#modal-rules').classList.add('hidden'); };

  function leaveRoom() {
    send({ t: 'leave' }, true).catch(() => {});
    roomCode = null; room = null; S = null; LS.del('is_room'); show('home');
  }
  $('#btn-lobby-leave').onclick = leaveRoom;
  // ---------- ayarlar menüsü ----------
  const menu = $('#modal-menu');
  function menuTexts() { $('#m-sound').textContent = sound ? '🔊 Ses: açık' : '🔇 Ses: kapalı'; $('#m-vib').textContent = vib ? '📳 Titreşim: açık' : '📴 Titreşim: kapalı'; }
  function openMenu() {
    menuTexts(); $('#m-confirm').classList.add('hidden'); $('#m-main').classList.remove('hidden');
    $('#m-leave').textContent = room ? 'Odadan çık' : 'Kapat';
    menu.classList.remove('hidden'); SFX.click();
  }
  const closeMenu = () => menu.classList.add('hidden');
  document.addEventListener('click', e => { if (e.target.closest('.gear')) openMenu(); });
  $('#m-close').onclick = closeMenu;
  menu.onclick = e => { if (e.target === menu) closeMenu(); };
  $('#m-sound').onclick = () => { sound = !sound; LS.set('is_sound', sound ? '1' : '0'); menuTexts(); SFX.pop(); };
  $('#m-vib').onclick = () => { vib = !vib; LS.set('is_vib', vib ? '1' : '0'); menuTexts(); buzz(30); };
  $('#m-rules').onclick = () => { closeMenu(); $('#modal-rules').classList.remove('hidden'); };
  $('#m-leave').onclick = () => {
    if (!room) return closeMenu();
    if (S && S.phase !== 'over') { $('#m-main').classList.add('hidden'); $('#m-confirm').classList.remove('hidden'); $('#m-confirm-text').textContent = 'Oyun sürüyor. Çıkarsan odadan ayrılırsın ve geri dönemezsin. Emin misin?'; }
    else { closeMenu(); leaveRoom(); }
  };
  $('#m-no').onclick = () => { $('#m-confirm').classList.add('hidden'); $('#m-main').classList.remove('hidden'); };
  $('#m-yes').onclick = () => { closeMenu(); leaveRoom(); };
  // genel buton sesi + kalem sesi
  document.addEventListener('click', e => { if (e.target.closest('.btn:not(:disabled), .chip, .step-btn, .seg button') && !e.target.closest('#m-sound')) SFX.click(); });
  let lastKey = 0;
  document.addEventListener('input', e => { if (e.target.matches && e.target.matches('.f-row input')) { const t = Date.now(); if (t - lastKey > 70) { lastKey = t; SFX.key(); } } });

  // ---------- açık odalar ----------
  async function loadRooms() {
    if (cur !== 'home' || roomCode || document.visibilityState !== 'visible') return;
    try {
      const r = await fetch('/rooms', { cache: 'no-store' }); const list = await r.json();
      $('#open-rooms').classList.toggle('hidden', !list.length);
      $('#open-list').innerHTML = list.map(x => `<li><div class="or-info"><b>${esc(x.host)}'in odası</b><span>${x.n}/${x.max} kişi · ${x.cats} kategori · ${Math.round(x.dur / 60 * 10) / 10} dk</span></div><button class="btn tiny" data-room="${esc(x.code)}" type="button">Katıl</button></li>`).join('');
    } catch {}
  }
  $('#open-list').addEventListener('click', e => { const b = e.target.closest('[data-room]'); if (b) { codeEl.value = b.dataset.room; homeGo(false); } });
  setInterval(loadRooms, 4000); setTimeout(loadRooms, 500);
  $('#btn-over-leave').onclick = leaveRoom;

  // ---------- LOBİ ----------
  const DURS = [[60, '1 dk'], [90, '1,5 dk'], [120, '2 dk'], [180, '3 dk'], [240, '4 dk'], [300, '5 dk'], [420, '7 dk'], [600, '10 dk']];
  const isHost = () => room && me && room.host === me;
  const setSettings = s => send({ t: 'settings', settings: s }).catch(() => {});

  function renderLobby() {
    if (!room) return;
    const host = isHost(), st = room.settings;
    $('#room-code').textContent = room.code;
    $('#player-count').textContent = `(${room.members.length}/${room.max})`;
    $('#player-list').innerHTML = room.members.map(m =>
      `<li class="${m.online ? '' : 'off'} ${m.id === me ? 'you' : ''}"><span class="dot"></span><span class="pn">${esc(m.nick)}</span>${m.id === room.host ? ' 👑' : ''}${host && m.id !== me ? `<button class="kick" data-kick="${esc(m.id)}" aria-label="Çıkar">✕</button>` : ''}</li>`).join('');
    const box = $('#scr-lobby .sheet');
    box.classList.toggle('locked', !host);
    $('#settings-note').textContent = host ? '' : '(sadece kurucu değiştirir)';
    $('#cat-chips').innerHTML = catalog.map(c => `<button type="button" class="chip ${st.cats.includes(c.id) ? 'on' : ''}" data-cat="${c.id}">${esc(c.label)}</button>`).join('');
    $('#dur-chips').innerHTML = DURS.map(([s, l]) => `<button type="button" class="chip ${st.duration === s ? 'on' : ''}" data-dur="${s}">${l}</button>`).join('');
    $$('#end-seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.endMode));
    $('#tgt-val').textContent = st.target;
    $('#tgt-unit').textContent = st.endMode === 'rounds' ? 'tur' : 'puan';
    $('#priv').checked = !!st.priv;
    const start = $('#btn-start');
    start.disabled = !host;
    start.textContent = host ? 'Oyunu başlat' : 'Kurucu başlatacak…';
  }
  $('#player-list').addEventListener('click', e => { const b = e.target.closest('[data-kick]'); if (b) send({ t: 'kick', id: b.dataset.kick }).catch(() => {}); });
  $('#cat-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b || !isHost()) return;
    const set = new Set(room.settings.cats); set.has(b.dataset.cat) ? set.delete(b.dataset.cat) : set.add(b.dataset.cat);
    if (!set.size) return toast('En az bir kategori seçili olmalı.', 'err');
    setSettings({ cats: [...set] });
  });
  $('#dur-chips').addEventListener('click', e => { const b = e.target.closest('[data-dur]'); if (b && isHost()) setSettings({ duration: Number(b.dataset.dur) }); });
  $('#end-seg').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b && isHost() && b.dataset.mode !== room.settings.endMode) setSettings({ endMode: b.dataset.mode }); });
  function stepTarget(dir) {
    if (!isHost()) return;
    const st = room.settings, step = st.endMode === 'rounds' ? 1 : 10, lo = st.endMode === 'rounds' ? 1 : 20, hi = st.endMode === 'rounds' ? 30 : 1000;
    setSettings({ target: Math.min(hi, Math.max(lo, st.target + dir * step)) });
  }
  $('#tgt-minus').onclick = () => stepTarget(-1); $('#tgt-plus').onclick = () => stepTarget(1);
  $('#priv').onchange = e => { if (isHost()) setSettings({ priv: e.target.checked }); else e.target.checked = !!room.settings.priv; };
  const inviteLink = () => `${location.origin}/?r=${room.code}`;
  $('#btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Davet linki kopyalandı.'); }
    catch { const t = document.createElement('input'); t.value = inviteLink(); document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast('Davet linki kopyalandı.'); } catch { toast(inviteLink()); } t.remove(); }
  };
  $('#btn-share').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'İsim Şehir', text: `İsim Şehir oynayalım! Oda kodu: ${room.code}`, url: inviteLink() }); } catch {} } else $('#btn-copy').click();
  };
  $('#btn-start').onclick = () => { audio(); send({ t: 'start' }).catch(() => {}); };

  // ---------- OYUN: durum ----------
  let prevPhase = null, prevRound = 0;
  function onState(st) {
    const first = !S;
    S = st; offset = st.serverNow - Date.now();
    const changed = prevPhase !== st.phase || prevRound !== st.round;
    if (changed) { sfxFor(st); prevPhase = st.phase; prevRound = st.round; }
    switch (st.phase) {
      case 'ready': show('ready'); renderReady(); break;
      case 'play': case 'grace': if (cur !== 'play') show('play'); renderPlay(); break;
      case 'reveal': if (cur !== 'reveal') show('reveal'); renderReveal(); break;
      case 'scores': if (cur !== 'scores') show('scores'); renderScores(); break;
      case 'over': if (cur !== 'over') show('over'); renderOver(); break;
      default: break;
    }
    if (first) tickUI();
  }
  function sfxFor(st) {
    if (st.phase === 'ready') SFX.letter(); else if (st.phase === 'play') SFX.go(); else if (st.phase === 'scores') SFX.score(); else if (st.phase === 'grace') SFX.bell(); else if (st.phase === 'over') SFX.win();
  }
  const nameOf = id => { const p = S && S.players.find(x => x.id === id); return p ? p.nick : '?'; };
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // ---------- HARF GELİYOR ----------
  function renderReady() {
    $('#ready-round').textContent = `Tur ${S.round} / ${S.settings.endMode === 'rounds' ? S.settings.target : '∞'}`;
    const l = $('#ready-letter');
    if (l.dataset.k !== S.round + S.letter) { l.dataset.k = S.round + S.letter; l.textContent = S.letter; l.style.animation = 'none'; void l.offsetWidth; l.style.animation = ''; const sc = $('.scribble'); sc.style.animation = 'none'; void sc.offsetWidth; sc.style.animation = ''; }
  }

  // ---------- TUR ----------
  let answers = {}, playKey = '', sendT = null, lastSent = '', flushed = false;
  function renderPlay() {
    const key = S.round + ':' + S.letter;
    if (playKey !== key) {
      playKey = key; flushed = false; lastSent = '';
      answers = {}; S.cats.forEach(c => { answers[c.id] = (S.me.answers && S.me.answers[c.id]) || ''; });
      $('#fields').innerHTML = S.cats.map(c => `
        <div class="f-row" data-cat="${c.id}"><label for="in-${c.id}">${esc(c.label)}</label>
        <input id="in-${c.id}" class="line-input" type="text" maxlength="40" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="next" value="${esc(answers[c.id])}">
        <div class="hint"></div></div>`).join('');
      $$('#fields input').forEach((inp, i, all) => {
        const row = inp.closest('.f-row'), cat = row.dataset.cat;
        const validate = () => {
          const v = inp.value.trim(), fl = firstLetter(v);
          const bad = v && fl && fold(fl) !== fold(S.letter);
          row.classList.toggle('bad', !!bad);
          row.querySelector('.hint').textContent = bad ? `“${S.letter}” ile başlamalı` : '';
        };
        inp.addEventListener('input', () => { answers[cat] = inp.value; validate(); scheduleSend(); updateDoneBtn(); });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const nx = all[i + 1]; if (nx) nx.focus(); else { inp.blur(); } } });
        inp.addEventListener('focus', () => setTimeout(() => { try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {} }, 250));
        validate();
      });
      $('#play-page').scrollTop = 0;
    }
    $('#play-round').textContent = `Tur ${S.round} / ${S.settings.endMode === 'rounds' ? S.settings.target : '∞'}`;
    $('#play-letter').textContent = S.letter;
    $('#play-players').innerHTML = S.players.filter(p => !p.left).map(p => `<span class="pchip ${p.done ? 'done' : ''} ${p.online ? '' : 'off'}">${esc(p.nick)}</span>`).join('');
    const locked = S.phase === 'grace';
    $('#scr-play').classList.toggle('locked-in', locked);
    $$('#fields input').forEach(i => { i.readOnly = locked; if (locked) i.blur(); });
    if (locked && !flushed) { flushed = true; sendAnswersNow(); }
    updateDoneBtn();
    updateDoneBanner();
  }
  function scheduleSend() { clearTimeout(sendT); sendT = setTimeout(sendAnswersNow, 120); }
  function sendAnswersNow() {
    clearTimeout(sendT);
    if (!wsReady) return;
    const j = JSON.stringify(answers);
    if (j === lastSent && S && S.phase === 'play') return;
    lastSent = j;
    try { ws.send(JSON.stringify({ t: 'act', type: 'upd', answers })); } catch {}
  }
  function allFilled() { return S && S.cats.every(c => (answers[c.id] || '').trim().length > 0); }
  function updateDoneBtn() {
    const b = $('#btn-done');
    if (!S || !(S.phase === 'play' || S.phase === 'grace')) return;
    const filled = allFilled();
    if (S.phase === 'grace') { b.disabled = true; b.textContent = 'Süre doldu!'; return; }
    if (S.me.done && filled) { b.disabled = true; b.textContent = 'Bitirdin ✓ bekleniyor'; return; }
    b.disabled = !filled;
    b.textContent = filled ? 'BİTTİ!' : 'Tüm kutuları doldur';
  }
  $('#btn-done').onclick = () => {
    if (!allFilled()) return;
    sendAnswersNow(); SFX.pop(); buzz(25);
    act('done').then(() => { S.me.done = true; updateDoneBtn(); });
    document.activeElement && document.activeElement.blur();
  };
  function updateDoneBanner() {
    const b = $('#done-banner');
    if (S.phase === 'grace') { b.textContent = '⏰ Süre bitti! Cevaplar toplanıyor…'; b.classList.remove('hidden'); return; }
    if (S.phase === 'play' && S.countdownEnd && S.doneBy) {
      const left = Math.max(0, Math.ceil((Math.min(S.endsAt, S.countdownEnd) - now()) / 1000));
      b.textContent = S.doneBy === me ? `Bitirdin! Diğerlerine ${left} sn kaldı` : `✋ ${nameOf(S.doneBy)} bitirdi! ${left} sn kaldı`;
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
  }

  // ---------- CEVAPLAR ----------
  let rvKey = '', rvIdx = -1, rvTotal = 1, rvStepKey = '';
  const rowEls = new Map();
  function renderReveal() {
    const R = S.reveal;
    const key = S.round + ':' + S.letter;
    if (rvKey !== key) { rvKey = key; rvIdx = -1; $('#rv-current').innerHTML = ''; $('#rv-past').innerHTML = ''; rowEls.clear(); }
    $('#rv-round').textContent = `Tur ${S.round}`;
    $('#rv-letter').textContent = S.letter;
    $('#rv-prog').innerHTML = S.cats.map((c, i) => `<i class="rv-dot ${i < R.idx ? 'done' : i === R.idx ? 'cur' : ''}"></i>`).join('');
    $('#btn-skip').classList.toggle('hidden', !(S.host === me));
    const cat = R.cats[R.idx];
    const holder = $('#rv-current');
    if (rvIdx !== R.idx) {
      rvIdx = R.idx; rowEls.clear();
      holder.innerHTML = `<div class="sheet cat-sheet"><div class="cat-title"><span class="hl">${esc(cat.label)}</span></div><div class="answers"></div><div class="votes"></div></div>`;
      $('#rv-page').scrollTop = 0;
      rvStepKey = ''; SFX.pop();
    }
    const ansBox = holder.querySelector('.answers');
    // oyuncuları puan sırasına göre değil, oyun sırasına göre göster
    S.players.forEach((p, i) => {
      const e = cat.entries.find(x => x.pid === p.id);
      if (!e) return;
      let row = rowEls.get(p.id);
      if (!row) {
        row = document.createElement('div'); row.className = 'ans'; row.style.animationDelay = (i * 0.28) + 's';
        row.innerHTML = '<div class="who"></div><div class="txt"></div><div class="mark"></div><div class="pts hidden"></div>';
        ansBox.appendChild(row); rowEls.set(p.id, row);
        if (e.text) setTimeout(SFX.pop, i * 280);
      }
      patchRow(row, p, e, cat);
    });
    // oylama kartları
    const vbox = holder.querySelector('.votes');
    vbox.innerHTML = cat.items.map(it => voteCard(it)).join('');
    // geçmiş kategoriler
    $('#rv-past').innerHTML = R.cats.slice(0, R.idx).reverse().map(c => {
      return `<div class="past-row"><b>${esc(c.label)}</b>${c.entries.map(e => `<span>${esc(nameOf(e.pid))} <em>${e.points == null ? '' : '+' + e.points}</em></span>`).join('')}</div>`;
    }).join('');
    // süre çubuğu için toplam
    const sk = R.idx + ':' + R.state;
    if (rvStepKey !== sk) { rvStepKey = sk; rvTotal = Math.max(1000, (R.stepEnds || now()) - now()); }
  }
  function patchRow(row, p, e, cat) {
    const it = e.itemId ? cat.items.find(x => x.id === e.itemId) : null;
    row.querySelector('.who').textContent = p.nick;
    row.querySelector('.who').classList.toggle('me', p.id === me);
    const txt = row.querySelector('.txt');
    let sub = '';
    if (e.status === 'bad') sub = e.reason === 'harf' ? 'yanlış harf' : e.reason === 'uygunsuz' ? 'uygunsuz' : '';
    else if (e.status === 'ok' && e.canon && fold(e.canon) !== fold(e.text)) sub = '→ ' + e.canon;
    if (!e.text) { txt.className = 'txt empty'; txt.textContent = 'boş bıraktı'; } else { txt.className = 'txt'; txt.innerHTML = esc(e.text) + (sub ? `<small>${esc(sub)}</small>` : ''); }
    const mk = row.querySelector('.mark');
    let kind = 'no', ch = '✗';
    if (e.status === 'ok') { kind = 'ok'; ch = '✓'; }
    else if (e.status === 'disputed') { if (it && it.verdict === true) { kind = 'ok'; ch = '✓'; } else if (it && it.verdict === false) { kind = 'no'; ch = '✗'; } else { kind = 'q'; ch = '?'; } }
    if (!e.text) ch = '';
    mk.className = 'mark ' + kind; mk.textContent = ch;
    const pt = row.querySelector('.pts');
    if (e.points != null) {
      if (pt.classList.contains('hidden')) {
        pt.classList.remove('hidden'); (e.points >= 10 ? () => { SFX.stamp(); SFX.double(); } : e.points ? () => { SFX.stamp(); SFX.ding(); } : SFX.nope)();
      }
      pt.textContent = e.points ? '+' + e.points : '0';
      pt.className = 'pts' + (e.points === 10 ? ' ten' : e.points === 0 ? ' zero' : '');
    }
  }
  function voteCard(it) {
    const author = nameOf(it.authors[0]) + (it.authors.length > 1 ? ` +${it.authors.length - 1}` : '');
    if (it.verdict === null) {
      if (it.canVote) {
        return `<div class="vote-card"><div class="q"><b>${esc(author)}</b> “${esc(it.text)}” yazdı. Geçerli mi?</div>
          <div class="vote-btns"><button class="btn yes ${it.myVote === true ? 'picked' : ''}" data-vote="1" data-item="${esc(it.id)}">Geçerli ✓</button><button class="btn no ${it.myVote === false ? 'picked' : ''}" data-vote="0" data-item="${esc(it.id)}">Geçersiz ✗</button></div>
          <div class="vote-note">${it.voted}/${it.voters} oy verildi${it.myVote === null ? '' : ' · oyunu değiştirebilirsin'}</div></div>`;
      }
      return `<div class="vote-card"><div class="q">“${esc(it.text)}” oylanıyor…</div><div class="vote-note">${it.voted}/${it.voters} oy verildi</div></div>`;
    }
    if (it.voters === 0 && it.voted === 0) return `<div class="verdict y">“${esc(it.text)}” oy veren olmadığı için kabul edildi.</div>`;
    return it.verdict
      ? `<div class="verdict y">“${esc(it.text)}” kabul edildi (${it.yes} evet, ${it.no} hayır)</div>`
      : `<div class="verdict n">“${esc(it.text)}” reddedildi (${it.yes} evet, ${it.no} hayır)</div>`;
  }
  $('#rv-current').addEventListener('click', e => {
    const b = e.target.closest('[data-vote]'); if (!b) return;
    SFX.vote(); buzz(15);
    act('vote', { item: b.dataset.item, yes: b.dataset.vote === '1' });
  });
  $('#btn-skip').onclick = () => act('skip');

  // ---------- PUAN LİSTESİ ----------
  function playerRows(sorted, max, showGain) {
    return sorted.map((p, i) => `<li style="animation-delay:${i * 0.08}s"><span class="rank">${i + 1}</span><span class="nm">${i === 0 && p.score > 0 ? '<span class="crown">👑</span>' : ''}${esc(p.nick)}${p.left ? ' <span class="left-tag">(ayrıldı)</span>' : ''}</span>${showGain ? `<span class="gain ${p.roundPoints ? '' : 'zero'}">+${p.roundPoints}</span>` : ''}<span class="tot">${p.score}</span><i class="bar" style="width:${max ? Math.round(p.score / max * 100) : 0}%"></i></li>`).join('');
  }
  function renderScores() {
    const sorted = S.players.slice().sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick, 'tr'));
    const max = Math.max(1, sorted[0].score);
    $('#sc-title').textContent = `Tur ${S.round} puanları`;
    $('#score-list').innerHTML = playerRows(sorted, max, true);
    $('#sc-grid').innerHTML = S.reveal.cats.map(c => `<div class="grid-cat">${esc(c.label)}</div>` + c.entries.map(e =>
      `<div class="grid-line"><span class="g-who">${esc(nameOf(e.pid))}</span><span class="g-txt">${e.text ? esc(e.text) : '<i>boş</i>'}</span><span class="g-pt ${e.points ? '' : 'z'}">${e.points ? '+' + e.points : '0'}</span></div>`).join('')).join('');
    const host = S.host === me;
    $('#btn-next').classList.toggle('hidden', !host);
    $('#sc-wait').classList.toggle('hidden', host && false);
    updateScoresWait();
  }
  function updateScoresWait() {
    if (!S || S.phase !== 'scores') return;
    const left = Math.max(0, Math.ceil((S.reveal.scoresEnds - now()) / 1000));
    const host = S.host === me;
    $('#sc-wait').textContent = host ? `Otomatik devam: ${left} sn` : `Kurucu devam edecek · ${left} sn`;
  }
  $('#btn-next').onclick = () => { SFX.pop(); act('next'); };

  // ---------- OYUN BİTTİ ----------
  function renderOver() {
    const sorted = S.players.slice().sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick, 'tr'));
    const w = S.winners.map(nameOf);
    $('#over-title').textContent = w.length > 1 ? 'Kazananlar (berabere)' : 'Kazanan';
    $('#over-winner').textContent = w.join(' & ');
    $('#final-list').innerHTML = playerRows(sorted, Math.max(1, sorted[0].score), false);
    const host = S.host === me;
    $('#btn-lobby').disabled = !host;
    $('#btn-lobby').textContent = host ? 'Yeni oyun' : 'Kurucu yeni oyun açacak';
  }
  $('#btn-lobby').onclick = () => act('toLobby');

  // ---------- zamanlayıcı döngüsü ----------
  let lastSec = null;
  function tickUI() {
    if (!S) return;
    const t = now();
    if (S.phase === 'ready') {
      const left = Math.ceil((S.readyEnds - t) / 1000);
      $('#ready-count').textContent = left <= 3 && left > 0 ? left : '';
      if (left !== lastSec && left <= 3 && left > 0) SFX.tick();
      lastSec = left;
    } else if (S.phase === 'play' || S.phase === 'grace') {
      const end = S.countdownEnd ? Math.min(S.endsAt, S.countdownEnd) : S.endsAt;
      const rem = S.phase === 'grace' ? 0 : end - t;
      const tm = $('#play-time');
      tm.textContent = mmss(rem);
      const low = rem <= 10000;
      tm.classList.toggle('low', low && rem > 0);
      $('.timebar').classList.toggle('low', low);
      $('#timebar-fill').style.transform = `scaleX(${Math.max(0, Math.min(1, rem / (S.settings.duration * 1000)))})`;
      const sec = Math.ceil(rem / 1000);
      if (sec !== lastSec && sec <= 5 && sec > 0 && S.phase === 'play') SFX.tick();
      lastSec = sec;
      updateDoneBanner();
    } else if (S.phase === 'reveal' && S.reveal) {
      const rem = (S.reveal.stepEnds || t) - t;
      $('#rv-timebar').style.transform = `scaleX(${Math.max(0, Math.min(1, rem / rvTotal))})`;
    } else if (S.phase === 'scores') updateScoresWait();
  }
  setInterval(tickUI, 200);

  // ---------- başlangıç ----------
  $('#scr-home').classList.add('active');
  if (!nick) setTimeout(() => nickEl.focus(), 300);
  document.addEventListener('pointerdown', () => audio(), { once: true });
  connect();
})();
