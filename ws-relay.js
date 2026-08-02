#!/usr/bin/env node
// ws-relay.js — Uphill Battle 零依赖 WebSocket 房间中继（局域网/开发用）
// 职责只有房间管理 + 消息转发，无任何游戏逻辑；线上阶段此逻辑原样搬进 CF Durable Object。
//
// 协议（JSON 文本帧）：
//   C→R {t:'join', room, name}   → R→C {t:'welcome', id, host, peers:[{id,name}]}
//   他人收到 {t:'peer-join', id, name}；断线广播 {t:'peer-leave', id}
//   其余消息：注入 from 后转发——默认广播房间内其他人；带 to 字段则只发该 id。
//   房主离开不迁移（阶段 1 从简）。
//
// 用法：node ws-relay.js [端口=9325]
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.argv[2] || process.env.PORT || '9325', 10);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20; // 1MB 帧上限，防内存攻击

const rooms = new Map(); // room → { clients: Map<id, client>, hostId }
let nextId = 1;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 服务端→客户端帧：不掩码
function sendFrame(sock, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(0x80 | opcode), len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  sock.write(Buffer.concat([header, payload]));
}
const send = (sock, obj) => sendFrame(sock, 1, Buffer.from(JSON.stringify(obj)));

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('WebSocket only：node ws-relay.js 是攻山的房间中继，浏览器用 ws:// 连接\n');
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);

  const client = { sock, id: 0, room: null, name: '', _closed: false };
  let buf = Buffer.alloc(0);

  sock.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_FRAME) { close(client); return; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 8) { close(client); return; }          // close
      else if (opcode === 9) sendFrame(sock, 0xA, payload); // ping → pong
      else if (opcode === 1) onText(client, payload.toString('utf8'));
      // 2=binary / 10=pong：忽略
    }
  });
  sock.on('error', () => close(client));
  sock.on('close', () => close(client));
});

function onText(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.t === 'join') { join(client, msg); return; }
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (!room) return;
  msg.from = client.id;
  if (msg.to) { // 定向消息（房主 → 指定加入者，如 {t:'you'} 坑位分配）
    const target = room.clients.get(msg.to);
    if (target) send(target.sock, msg);
    return;
  }
  for (const [id, c] of room.clients) if (id !== client.id) send(c.sock, msg);
}

function join(client, msg) {
  if (client.room) return; // 重复 join 忽略
  const roomName = String(msg.room || 'default').slice(0, 32);
  if (!rooms.has(roomName)) rooms.set(roomName, { clients: new Map(), hostId: 0 });
  const room = rooms.get(roomName);
  client.id = nextId++;
  client.room = roomName;
  client.name = String(msg.name || `玩家${client.id}`).slice(0, 16);
  const host = room.clients.size === 0;
  if (host) room.hostId = client.id;
  const peers = [...room.clients.values()].map((c) => ({ id: c.id, name: c.name }));
  room.clients.set(client.id, client);
  send(client.sock, { t: 'welcome', id: client.id, host, peers, room: roomName });
  for (const [id, c] of room.clients) if (id !== client.id) {
    send(c.sock, { t: 'peer-join', id: client.id, name: client.name });
  }
  log(`${client.name}#${client.id} 加入 ${roomName}（${room.clients.size} 人${host ? '，房主' : ''}）`);
}

function close(client) {
  if (client._closed) return;
  client._closed = true;
  try { client.sock.destroy(); } catch { /* 已断开 */ }
  if (!client.room) return;
  const room = rooms.get(client.room);
  client.room = null;
  if (!room) return;
  room.clients.delete(client.id);
  const wasHost = client.id === room.hostId; // 房主离开：加入者提示"比赛结束"（不迁移）
  for (const c of room.clients.values()) send(c.sock, { t: 'peer-leave', id: client.id, wasHost });
  log(`${client.name}#${client.id} 离开（剩 ${room.clients.size} 人${wasHost ? '，房主' : ''}）`);
  if (room.clients.size === 0) rooms.delete(client.room);
}

server.listen(PORT, () => log(`攻山房间中继就绪 ws://0.0.0.0:${PORT}（Ctrl-C 停止）`));
