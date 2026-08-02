#!/usr/bin/env node
// tools/test-relay.mjs — 房间中继协议测试：join/welcome/广播/定向/断线/wasHost
// 用法：node tools/test-relay.mjs          自起 ws-relay.js 子进程测本地中继
//       TEST_WS_URL=ws://host/ws/room node tools/test-relay.mjs   直连外部中继（如 CF miniflare）
import { spawn } from 'node:child_process';

const EXTERNAL = process.env.TEST_WS_URL || null;
const PORT = 19325; // 测试专用高端口，避开开发中继 9325
const URL = EXTERNAL || `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let relay = null;
if (!EXTERNAL) {
  relay = spawn('node', ['ws-relay.js', String(PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    relay.stdout.on('data', (d) => { if (String(d).includes('就绪')) res(); });
    relay.on('exit', () => rej(new Error('relay 提前退出')));
    setTimeout(() => rej(new Error('relay 启动超时')), 5000);
  });
}

const results = {};
const open = (name) => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters[i].res(m); waiters.splice(i, 1); }
    }
  };
  ws.onerror = rej;
  ws.onopen = () => res({
    ws, inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (pred, ms = 2000) => new Promise((r2, j2) => {
      const hit = inbox.find(pred);
      if (hit) return r2(hit);
      waiters.push({ pred, res: r2 });
      setTimeout(() => j2(new Error('等待消息超时')), ms);
    }),
  });
});

try {
  const a = await open('甲');
  a.send({ t: 'join', room: 'test', name: '甲' });
  const wa = await a.wait((m) => m.t === 'welcome');
  results.aHost = wa.host === true && wa.id > 0 && wa.peers.length === 0;

  const b = await open('乙');
  b.send({ t: 'join', room: 'test', name: '乙' });
  const wb = await b.wait((m) => m.t === 'welcome');
  results.bNotHost = wb.host === false && wb.peers.length === 1 && wb.peers[0].name === '甲';
  results.aGotPeerJoin = (await a.wait((m) => m.t === 'peer-join')).name === '乙';

  // 广播：乙发 → 甲收（注入 from），乙自己不收
  b.send({ t: 'input', mv: [0, 1] });
  const fwd = await a.wait((m) => m.t === 'input');
  results.broadcast = fwd.from === wb.id && fwd.mv[1] === 1 && !b.inbox.some((m) => m.t === 'input');

  // 定向：甲发 to=乙 → 只有乙收
  a.send({ t: 'you', to: wb.id, actor: 1 });
  const you = await b.wait((m) => m.t === 'you');
  results.targeted = you.actor === 1 && you.from === wa.id;

  // 断线：乙断开 → 甲收 peer-leave（wasHost=false）
  b.ws.close();
  const leave = await a.wait((m) => m.t === 'peer-leave');
  results.leave = leave.id === wb.id && leave.wasHost === false;

  // 房主断开：丙在房内，甲（房主）断开 → 丙收 wasHost=true
  const c = await open('丙');
  c.send({ t: 'join', room: 'test', name: '丙' });
  await c.wait((m) => m.t === 'welcome');
  a.ws.close();
  const leaveHost = await c.wait((m) => m.t === 'peer-leave');
  results.leaveWasHost = leaveHost.wasHost === true;
  c.ws.close();
} finally {
  if (relay) relay.kill();
}

const pass = Object.values(results).every(Boolean);
console.log('TEST-RELAY ' + JSON.stringify(results));
process.exit(pass ? 0 : 1);
