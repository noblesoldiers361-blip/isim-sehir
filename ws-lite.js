// Bağımlılıksız minimal WebSocket sunucusu (RFC 6455): metin mesajı, ping/pong, close, parçalı mesaj.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 1;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragBytes = 0;
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => { try { socket.destroy(); } catch {} });
    socket.on('end', () => { try { socket.end(); } catch {} });
  }

  onClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    try { while (this.parse()) { /* çerçeveleri tüket */ } } catch { this.closeWith(1002); }
  }

  parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return false;
      const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
      if (hi !== 0) { this.closeWith(1009); return false; }
      len = lo; off = 10;
    }
    if (!masked) { this.closeWith(1002); return false; }          // istemci çerçeveleri maskeli olmak zorunda
    if (len > this.maxPayload) { this.closeWith(1009); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);

    if (op === 0x8) { this.closeWith(1000); return false; }
    if (op === 0x9) { this.sendFrame(0xA, payload); return true; }
    if (op === 0xA) { this.emit('pong'); return true; }
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      if (op !== 0x0) { this.frags = []; this.fragBytes = 0; this.fragOp = op; }
      this.frags.push(payload); this.fragBytes += payload.length;
      if (this.fragBytes > this.maxPayload) { this.closeWith(1009); return false; }
      if (fin) {
        const msg = Buffer.concat(this.frags);
        this.frags = []; this.fragBytes = 0;
        if (this.fragOp === 0x1) this.emit('message', msg.toString('utf8'));
      }
      return true;
    }
    this.closeWith(1002);
    return false;
  }

  sendFrame(op, payload) {
    if (this.readyState !== 1 && op !== 0x8) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch {}
  }

  send(text) { this.sendFrame(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this.sendFrame(0x9, Buffer.alloc(0)); }

  closeWith(code) {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.sendFrame(0x8, p);
    try { this.socket.end(); } catch {}
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 500).unref();
  }
  terminate() { this.readyState = 3; try { this.socket.destroy(); } catch {} this.emit('close'); }
}

// http.Server'a bağlanır: Upgrade isteklerini kabul eder
function attach(server, onConnection, { maxPayload = 32 * 1024 } = {}) {
  const clients = new Set();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const conn = new Conn(socket, maxPayload);
    clients.add(conn);
    conn.on('close', () => clients.delete(conn));
    onConnection(conn, req);
  });
  return { clients };
}

module.exports = { attach };
