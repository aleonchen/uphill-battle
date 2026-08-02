// Uphill Battle 联机中继（Cloudflare Workers + Durable Objects 版）
// 与 ws-relay.js 同一协议（join/welcome/peer-join/peer-leave/broadcast/to），
// 每房间一个 Durable Object：wss://<host>/ws/<房间号>
export class RoomRelay {
  constructor(state) {
    this.state = state;
    // 休眠重建：从 attachment 恢复各连接元数据（DO hibernation 后内存清空）
    this.clients = new Map(); // ws → {id, name}
    this.hostId = 0;
    this.nextId = 1;
    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (meta) {
        this.clients.set(ws, meta);
        if (meta.host) this.hostId = meta.id;
        if (meta.id >= this.nextId) this.nextId = meta.id + 1;
      }
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Uphill Battle 房间中继：wss://<host>/ws/<房间号>', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.clients.set(server, { id: 0, name: '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* 已断开，close 事件会清理 */ }
  }

  broadcast(obj, exceptId = -1) {
    for (const [ws, c] of this.clients) {
      if (c.id !== exceptId && c.id > 0) this.send(ws, obj);
    }
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const me = this.clients.get(ws);
    if (!me) return;

    if (msg.t === 'join') {
      if (me.id) return; // 重复 join 忽略
      // 先算 host/peers 再发 id——fetch 时自己已在 clients 里，顺序反了会把自己算进 peers
      const othersJoined = [...this.clients.values()].some((c) => c.id > 0);
      const peers = [...this.clients.values()]
        .filter((c) => c.id > 0)
        .map((c) => ({ id: c.id, name: c.name }));
      me.id = this.nextId++;
      me.name = String(msg.name || `玩家${me.id}`).slice(0, 16);
      me.host = !othersJoined;
      if (me.host) this.hostId = me.id;
      this.clients.set(ws, me);
      ws.serializeAttachment(me);
      this.send(ws, { t: 'welcome', id: me.id, host: me.host, peers, room: msg.room || '' });
      this.broadcast({ t: 'peer-join', id: me.id, name: me.name }, me.id);
      return;
    }
    if (!me.id) return;
    msg.from = me.id;
    if (msg.to) { // 定向消息（房主 → 指定加入者）
      for (const [ws2, c] of this.clients) if (c.id === msg.to) this.send(ws2, msg);
      return;
    }
    this.broadcast(msg, me.id);
  }

  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const me = this.clients.get(ws);
    this.clients.delete(ws);
    try { ws.close(); } catch { /* 已断开 */ }
    if (!me || !me.id) return;
    this.broadcast({ t: 'peer-leave', id: me.id, wasHost: me.id === this.hostId });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{1,16})$/);
    if (!m) return new Response('用法：wss://<host>/ws/<房间号>', { status: 400 });
    const id = env.ROOM_DO.idFromName(m[1].toUpperCase());
    return env.ROOM_DO.get(id).fetch(request);
  },
};
