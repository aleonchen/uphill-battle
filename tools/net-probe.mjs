#!/usr/bin/env node
// tools/net-probe.mjs — 联机阶段 1 端到端验证：同机双标签互见移动/开枪/中弹
// 用法：tools/chrome-test.sh cdp tools/net-probe.mjs
// （chrome-test 起隔离 Chrome 并注入 UB_CDP_PORT；本脚本自起 ws-relay 子进程并清理）
// 注意：两个客户端必须是两个独立 WINDOW（Target.createTarget newWindow）——
// 同窗口双标签会让后台标签 rAF 停帧，房主模拟直接停摆（实测踩坑）。
import { spawn } from 'node:child_process';

const BASE = process.env.UB_BASE || 'http://localhost:8123';
const PORT = process.env.UB_CDP_PORT;
const RELAY_PORT = 19326; // 测试专用，避开开发中继 9325
const EXTERNAL_WS = process.env.UB_WS_RELAY || null; // 外部中继（如 miniflare），跳过自起
const ROOM = 'e2e';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 起测试中继（本脚本子进程，随退出清理；UB_WS_RELAY 直连外部时跳过） ----
let relay = null;
if (!EXTERNAL_WS) {
  relay = spawn('node', ['ws-relay.js', String(RELAY_PORT)], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    relay.stdout.on('data', (d) => { if (String(d).includes('就绪')) res(); });
    relay.on('exit', () => rej(new Error('relay 提前退出')));
    setTimeout(() => rej(new Error('relay 启动超时')), 5000);
  });
}
function cleanup(code) {
  if (relay) relay.kill();
  process.exit(code);
}

// ---- 浏览器级 CDP（flatten 会话：一条 ws 复用所有 target） ----
const version = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let _id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const sendRaw = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++_id;
  pending.set(i, res);
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
});

async function openPage(url) {
  const t = await sendRaw('Target.createTarget', { url: 'about:blank', newWindow: true });
  const targetId = t.result.targetId;
  const a = await sendRaw('Target.attachToTarget', { targetId, flatten: true });
  const sid = a.result.sessionId;
  const send = (method, params = {}) => sendRaw(method, params, sid);
  await send('Page.enable');
  await send('Page.navigate', { url });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('页面求值异常: ' + expr.slice(0, 90));
    return r.result?.result?.value;
  };
  const waitTrue = async (expr, ms = 15000, label = expr.slice(0, 60)) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(250);
    }
    throw new Error('等待超时: ' + label);
  };
  return { targetId, send, evalJs, waitTrue };
}

const results = {};
try {
  const wsParam = `ws=${EXTERNAL_WS || `ws://localhost:${RELAY_PORT}`}`;
  const A = await openPage(`${BASE}/?room=${ROOM}&${wsParam}&autostart&name=房主`);
  const B = await openPage(`${BASE}/?room=${ROOM}&${wsParam}&autostart&name=队友B`);

  // 双端就绪：A 成房主、B 成加入者并拿到坑位
  await A.waitTrue(`!!window.__netHost`, 15000, 'A 成为房主');
  await B.waitTrue(`!!window.__netView && window.__netView.myActorId >= 0`, 15000, 'B 拿到坑位');

  // 坑位与名字互认
  results.slotOnHost = await A.evalJs(`(() => {
    const a = window.__game.actors.find((x) => x.isRemote);
    return a ? a.name : null; })()`);
  results.selfOnJoiner = await B.evalJs(`window.__game.player.name`);
  results.hostNameOnJoiner = await B.evalJs(`window.__game.actors[0].name`);
  const myId = await B.evalJs(`window.__netView.myActorId`);
  results.slotMatch = await A.evalJs(`window.__game.actors[${myId}].isRemote === true`);

  // 等房主进入 combat（autostart: prep 3s）
  await A.waitTrue(`window.__game.matchState === 'combat'`, 10000, '房主进入 combat');
  await B.waitTrue(`window.__game.matchState === 'combat'`, 10000, 'B 同步到 combat');
  results.snapsFlowing = (await B.evalJs(`window.__netView.stats.snaps`)) > 5;

  // ---- 移动：B 按 W 前进 2.5s，双端位置都应显著移动 ----
  const bPos0 = await B.evalJs(`[window.__game.player.pos.x, window.__game.player.pos.z]`);
  const aPos0 = await A.evalJs(`[window.__game.actors[${myId}].pos.x, window.__game.actors[${myId}].pos.z]`);
  await B.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(2500);
  await B.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(400); // 等快照回流
  const bPos1 = await B.evalJs(`[window.__game.player.pos.x, window.__game.player.pos.z]`);
  const aPos1 = await A.evalJs(`[window.__game.actors[${myId}].pos.x, window.__game.actors[${myId}].pos.z]`);
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  results.moveJoiner = Math.round(dist(bPos0, bPos1) * 10) / 10;
  results.moveOnHost = Math.round(dist(aPos0, aPos1) * 10) / 10;

  // ---- 开枪：B 开火 1s，房主侧耗弹、B 端收到曳光事件 ----
  await B.evalJs(`window.__input.state.fire = true`);
  await sleep(1000);
  await B.evalJs(`window.__input.state.fire = false`);
  results.ammoUsedOnHost = await A.evalJs(`40 - window.__game.actors[${myId}].ammo[0].mag`);
  results.shotsSeenOnJoiner = await B.evalJs(`window.__netView.stats.shots`);

  // ---- 投掷物：B 丢雷+烟，房主爆炸/起烟事件应回流到 B ----
  await B.evalJs(`window.__netView.queueEvent('throw', 'frag')`);
  await B.evalJs(`window.__netView.queueEvent('throw', 'smoke')`);
  await sleep(3500); // 手雷引信 2.6s + 快照回程
  results.boomsOnJoiner = await B.evalJs(`window.__netView.stats.booms`);
  results.smokepopsOnJoiner = await B.evalJs(`window.__netView.stats.smokepops`);

  // ---- 远端载具：B 上车→开车→下车，全在房主侧验证 ----
  await A.evalJs(`(() => {
    const a = window.__game.actors[${myId}], v = window.__game.vehicles[0];
    a.pos.set(v.pos.x + 2, v.pos.y, v.pos.z); // 挪到车旁（4m 上车半径内）
  })()`);
  await B.evalJs(`window.__netView.queueEvent('interact')`);
  await sleep(400);
  results.remoteEntered = await A.evalJs(
    `window.__game.vehicles[0].driver && window.__game.vehicles[0].driver.id === ${myId}`);
  const vPos0 = await A.evalJs(`[window.__game.vehicles[0].pos.x, window.__game.vehicles[0].pos.z]`);
  await B.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(1500);
  await B.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await sleep(300);
  const vPos1 = await A.evalJs(`[window.__game.vehicles[0].pos.x, window.__game.vehicles[0].pos.z]`);
  results.remoteDrove = Math.round(Math.hypot(vPos0[0] - vPos1[0], vPos0[1] - vPos1[1]) * 10) / 10;
  await B.evalJs(`window.__netView.queueEvent('interact')`);
  await sleep(400);
  results.remoteExited = await A.evalJs(`window.__game.vehicles[0].driver === null`);

  // ---- 中弹：房主侧给 B 的角色扣 30 血，B 端 HP 应同步为 70 ----
  await A.evalJs(`window.__game.applyDamage(window.__game.actors[${myId}], 30, null, false)`);
  await sleep(400);
  results.hpSyncedOnJoiner = await B.evalJs(`Math.round(window.__game.player.hp)`);

  await sendRaw('Target.closeTarget', { targetId: A.targetId });
  await sendRaw('Target.closeTarget', { targetId: B.targetId });
} catch (e) {
  console.error('PROBE-ERROR ' + e.message);
  console.log('PROBE-PARTIAL ' + JSON.stringify(results));
  cleanup(1);
}

const verdict = {
  slotOk: results.slotOnHost === '队友B' && results.selfOnJoiner === '队友B'
    && results.hostNameOnJoiner === '房主' && results.slotMatch === true,
  snapsOk: results.snapsFlowing === true,
  moveOk: results.moveJoiner > 2 && results.moveOnHost > 2,
  fireOk: results.ammoUsedOnHost >= 3 && results.shotsSeenOnJoiner >= 1,
  hitSyncOk: results.hpSyncedOnJoiner === 70,
  grenadeOk: results.boomsOnJoiner >= 1 && results.smokepopsOnJoiner >= 1,
  vehicleOk: results.remoteEntered === true && results.remoteDrove > 2 && results.remoteExited === true,
};
console.log('TEST-NET ' + JSON.stringify({ ...results, verdict }));
cleanup(Object.values(verdict).every(Boolean) ? 0 : 1);
