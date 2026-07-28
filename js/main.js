// 入口：渲染器/场景/光照/天空/雪花、主循环、输入层、Pointer Lock 与开始/重开流程
import * as THREE from 'three';
import { Game } from './game.js';
import { HUD } from './hud.js';
import { PlayerController } from './player.js';
import { Audio } from './audio.js';
import { Input, KeyboardMouseSource, TouchSource } from './input.js';
import { activeColliders, heightAt, ROUTES, DEFENSE_POINTS } from './terrain.js';
import { castRay } from './weapons.js';
import { AIController, losClear } from './ai.js';
import { clamp } from './utils.js';

const __params = new URLSearchParams(location.search);
// 渲染器
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const HORIZON = new THREE.Color(0xd6e9f5); // 地平线色（雾色与之衔接）
scene.background = HORIZON;
scene.fog = new THREE.Fog(HORIZON, 200, 750);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 30, 220);

// 天空穹顶：顶点色渐变（天顶饱和蓝 → 地平线近白浅蓝）
{
  const geo = new THREE.SphereGeometry(900, 24, 12);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0x2f6fc2);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getY(i) / 900, 0, 1);
    c.copy(HORIZON).lerp(zenith, Math.pow(t, 0.55));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  sky.renderOrder = -1;
  scene.add(sky);
}

// 光照：半球环境光 + 带阴影的平行光（阴影相机每帧跟随玩家）
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x5a6a4a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60;
sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;
sun.shadow.camera.bottom = -60;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.5;
const SUN_OFFSET = new THREE.Vector3(80, 140, 40);
scene.add(sun, sun.target);

// 雪花粒子：相机周围 30m 盒内循环飘落
const SNOW_N = 600, SNOW_HALF = 15;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW_N * 3);
const snowVel = new Float32Array(SNOW_N * 2); // 下落速度 + 漂移相位
for (let i = 0; i < SNOW_N; i++) {
  snowPos[i * 3] = (Math.random() * 2 - 1) * SNOW_HALF;
  snowPos[i * 3 + 1] = (Math.random() * 2 - 1) * SNOW_HALF;
  snowPos[i * 3 + 2] = (Math.random() * 2 - 1) * SNOW_HALF;
  snowVel[i * 2] = 1.5 + Math.random() * 1.5;
  snowVel[i * 2 + 1] = Math.random() * Math.PI * 2;
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.14, transparent: true, opacity: 0.75,
  depthWrite: false, sizeAttenuation: true,
}));
snow.frustumCulled = false;
scene.add(snow);

let snowTime = 0;
function updateSnow(dt, cam) {
  snowTime += dt;
  for (let i = 0; i < SNOW_N; i++) {
    const ix = i * 3;
    // 下落 + 轻微横向飘移
    snowPos[ix + 1] -= snowVel[i * 2] * dt;
    snowPos[ix] += Math.sin(snowTime * 0.7 + snowVel[i * 2 + 1]) * 0.35 * dt;
    // 围绕相机做盒式回绕
    for (let a = 0; a < 3; a++) {
      const c = a === 1 ? cam.y : a === 0 ? cam.x : cam.z;
      let rel = snowPos[ix + a] - c;
      if (rel > SNOW_HALF) snowPos[ix + a] -= SNOW_HALF * 2;
      else if (rel < -SNOW_HALF) snowPos[ix + a] += SNOW_HALF * 2;
    }
    // 落地回顶部
    if (snowPos[ix + 1] < heightAt(snowPos[ix], snowPos[ix + 2])) {
      snowPos[ix + 1] = cam.y + SNOW_HALF - Math.random() * 3;
    }
  }
  snowGeo.attributes.position.needsUpdate = true;
}

// 游戏对象
const hud = new HUD();
const game = new Game(scene, hud);
// 通用输入层：键盘源常驻；触控源随模式切换懒创建（?touch 或 last-input-wins 触发）
const input = new Input(__params);
const kbSource = new KeyboardMouseSource(input, renderer.domElement);
let touchSource = null;
const playerCtl = new PlayerController(game, camera, input, [kbSource], renderer.domElement);
game.onTerrainModeChanged = () => playerCtl.resetCamera(); // 画风切换时相机复位
// 调试钩子：CDP/控制台探测游戏与输入状态（触屏自动化测试用，勿删）
window.__game = game; window.__input = input;
// 阻止 iOS Safari 双指捏合页面缩放：摇杆+按钮双指同屏会被当成 pinch（user-scalable=no
// 在 iOS 上防不住捏合，必须拦截 Safari 私有的 gesture 事件）
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(t, (e) => e.preventDefault());
}

const touchUI = document.getElementById('touch-ui');
const muteEl = document.getElementById('mute-icon');
input.onModeChanged = (m) => {
  touchUI.classList.toggle('hidden', m !== 'touch');
  // 触屏布局：静音键挪到左侧，避免和开火键重叠
  muteEl.style.right = m === 'touch' ? 'auto' : '24px';
  muteEl.style.left = m === 'touch' ? '24px' : 'auto';
  if (m === 'touch' && !touchSource) {
    touchSource = new TouchSource(input, touchUI);
    playerCtl.sources.push(touchSource);
  }
  // 触屏设备保帧率：pixelRatio 降档
  renderer.setPixelRatio(m === 'touch' ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2));
};
input.onModeChanged(input.mode()); // 初始化显隐

// 开始界面操作模式选择（自动/触屏/键鼠，记忆在 localStorage）
for (const b of document.querySelectorAll('#mode-sel button')) {
  if (b.dataset.m === input.pref) b.classList.add('on');
  b.addEventListener('click', () => {
    input.setPref(b.dataset.m);
    for (const x of document.querySelectorAll('#mode-sel button')) x.classList.toggle('on', x === b);
  });
}
// 快捷栏可点（触屏吃药/丢雷；键鼠解锁时也能点）
for (const s of document.querySelectorAll('#quickbar .slot')) {
  s.style.pointerEvents = 'auto';
  s.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    const k = s.dataset.k;
    if (k === 'aid' || k === 'med') game.useMed(game.player, k);
    else playerCtl.throwNade(k);
  });
}
// 武器名可点：切换武器（触屏无 1/2 键）
const wname = document.getElementById('weapon-name');
wname.style.pointerEvents = 'auto';
wname.addEventListener('pointerup', (e) => {
  e.stopPropagation();
  game.switchWeapon(game.player, game.player.weaponIndex === 0 ? 1 : 0);
});
// 背包面板点击用药：成功则关面板并恢复指针锁定
hud._onUseMed = (t) => {
  if (game.useMed(game.player, t)) {
    hud.toggleBackpack(game, false);
    if (!input.isTouch()) renderer.domElement.requestPointerLock();
  }
};

// 开始 / 重开（Pointer Lock 仅键鼠模式请求）
document.getElementById('start-btn').addEventListener('click', () => {
  Audio.init(); // 用户手势内创建 AudioContext
  game.startMatch();
  if (!input.isTouch()) renderer.domElement.requestPointerLock();
});
document.getElementById('restart-btn').addEventListener('click', () => {
  location.reload();
});

// 调试：?autostart 直接开赛（无指针锁定，供无头截图/自动化测试）
if (__params.has('autostart')) {
  game.startMatch();
}
// 调试：?fire 开赛后自动开火（验证持枪/开火姿态）
if (__params.has('fire')) {
  setInterval(() => { input.state.fire = game.matchState === 'combat'; }, 500);
}
// 调试：?attack 强制玩家第 1 回合进攻（验证进攻出生点/载具）
if (__params.has('attack')) {
  game.attackSide = 'red';
  game.setupRound();
}
// 调试：?incar 把玩家放进第 1 辆载具（验证驾驶视角/跟车相机）
if (__params.has('incar')) {
  const v = game.vehicles[0];
  v.driver = game.player;
  game.player.inVehicle = v;
  game.player.char.group.visible = false;
}
// 调试：?drive 驾驶时模拟按住 W 并轻微转向（配合 ff 快进验证行驶）
if (__params.has('drive')) playerCtl.debugDrive = true;
// 调试：?ff=N 固定步长快进 N 秒（无头环境虚拟时间下时钟不走，手动推进）
if (__params.has('ff')) {
  game.matchState = 'combat';
  game.combatUntil = game.now + 270;
  hud.onCombatStart();
  if (__params.has('fire')) input.state.fire = true;
  const secs = parseFloat(__params.get('ff')) || 5;
  for (let t = 0; t < secs; t += 1 / 60) { game.update(1 / 60); playerCtl.update(1 / 60); }
  input.state.fire = false;
}
// 调试：?report 在 ff 之后导出全员状态（位置/血量/状态），供无头分析交战节奏
if (__params.has('report')) {
  const r = game.actors.map((a) => ({
    team: a.team, name: a.name, player: !!a.isPlayer, hp: Math.round(a.hp),
    state: a.state, pos: a.pos.toArray().map((v) => Math.round(v)),
  }));
  console.log('REPORT ' + JSON.stringify({
    state: game.matchState, round: game.round, attackSide: game.attackSide, now: Math.round(game.now), actors: r,
    vehicles: game.vehicles.map((v) => ({
      pos: v.pos.toArray().map((x) => Math.round(x)), speed: Math.round(v.speed * 10) / 10,
    })),
  }));
}
// 调试：?test=hud 触发事件横幅 + 周期性枪声标记（右前方），供截图验证
if (__params.get('test') === 'hud') {
  const p = game.player;
  game.hud.eventBanner('你 击倒了 敌人·甲');
  setInterval(() => {
    const rx = -Math.cos(p.yaw), rz = Math.sin(p.yaw); // 玩家右方向
    game.hud.soundMark({ x: p.pos.x + rx * 40 + Math.sin(p.yaw) * 25,
                         z: p.pos.z + rz * 40 + Math.cos(p.yaw) * 25 }, 'blue');
    game.hud.soundMark({ x: p.pos.x - rx * 60, z: p.pos.z - rz * 60 }, 'red');
  }, 400);
}
// 调试：?test=cover 断言掩体挡子弹/挡视线（无头抓 console 验证）
if (__params.get('test') === 'cover') {
  let res = null;
  for (const rock of activeColliders()) {
    if (rock.r < 2) continue;
    const d = 3; // 射线起点距石面 3m
    const ox = rock.x - rock.r - d, oz = rock.z;
    const oy = Math.max(heightAt(ox, oz), rock.y0) + 0.5;
    if (oy > rock.y1 - 0.2) continue;                          // 起点比石顶还高，换一块
    if (heightAt((ox + rock.x) / 2, oz) > oy - 0.2) continue;  // 中途地形挡路，换一块
    const o = new THREE.Vector3(ox, oy, oz);
    const dir = new THREE.Vector3(1, 0, 0);
    const hit = castRay(game, o, dir, {});
    const los = losClear(o, new THREE.Vector3(rock.x + rock.r + 3, oy, oz));
    res = {
      bulletBlocked: !!hit && hit.onCover && Math.abs(hit.dist - d) < 0.6,
      losBlocked: !los,
      colliders: activeColliders().length,
    };
    break;
  }
  console.log('TEST-COVER ' + JSON.stringify(res || { skipped: true }));
}
// 调试：?test=vehicle 断言上下车状态切换 + 上车视角吸附车头（需配合 ff 使比赛进入 combat）
if (__params.get('test') === 'vehicle') {
  const p = game.player, v = game.vehicles[0];
  p.pos.set(v.pos.x + 2, v.pos.y, v.pos.z);
  p.yaw = v.yaw + 1.2; // 先面向别的方向，验证上车会被掰回车头
  playerCtl.toggleVehicle();
  const entered = p.inVehicle === v && v.driver === p && !p.char.group.visible;
  const facedForward = Math.abs(p.yaw - v.yaw) < 1e-6 && p.pitch === 0;
  playerCtl.toggleVehicle();
  const exited = !p.inVehicle && !v.driver && p.char.group.visible;
  console.log('TEST-VEHICLE ' + JSON.stringify({ entered, facedForward, exited }));
}
// 调试：?test=grenade 断言烟雾挡视线/开阔地杀伤/岩石后免疫，并留一团烟供截图
if (__params.get('test') === 'grenade') {
  const p = game.player;
  const enemy = game.actors.find((a) => a.team === 'blue');
  // 1) 烟雾：穿过烟团的视线被挡，烟外不受影响
  const sp = new THREE.Vector3(p.pos.x + Math.sin(p.yaw) * 12, p.pos.y + 1.6, p.pos.z + Math.cos(p.yaw) * 12);
  game.grenades.popSmoke(sp);
  const through = losClear(new THREE.Vector3(sp.x - 10, sp.y, sp.z), new THREE.Vector3(sp.x + 10, sp.y, sp.z), game.now);
  const beside = losClear(new THREE.Vector3(sp.x - 10, sp.y, sp.z + 9), new THREE.Vector3(sp.x + 10, sp.y, sp.z + 9), game.now);
  // 2) 开阔地：近距爆炸掉血
  enemy.pos.set(p.pos.x + 6, 0, p.pos.z + 6);
  enemy.pos.y = heightAt(enemy.pos.x, enemy.pos.z);
  game.grenades.explodeAt(new THREE.Vector3(enemy.pos.x, enemy.pos.y + 0.5, enemy.pos.z), p);
  const hurtOpen = enemy.hp < 100;
  // 3) 岩石后：爆炸被掩体挡住不掉血
  const rock = activeColliders().filter((c) => c.r >= 2 && c.r <= 2.6)[0];
  enemy.hp = 100; enemy.state = 'alive';
  enemy.pos.set(rock.x + rock.r + 0.5, 0, rock.z);
  enemy.pos.y = heightAt(enemy.pos.x, enemy.pos.z);
  game.grenades.explodeAt(new THREE.Vector3(rock.x - rock.r - 0.5, rock.y0 + 0.5, rock.z), p);
  const rockSaved = enemy.hp === 100;
  console.log('TEST-GRENADE ' + JSON.stringify({
    smokeBlocks: !through, smokeClearBeside: beside, hurtOpen, rockSaved,
  }));
}
// 调试：?healdemo 演示一次急救箱引导中（供截图）；?bagdemo 打开背包面板（供截图）
// ?reloaddemo 演示换弹中（供截图）
if (__params.has('healdemo')) { game.player.hp = 40; game.useMed(game.player, 'aid'); }
if (__params.has('bagdemo')) hud.toggleBackpack(game, true);
if (__params.has('reloaddemo')) { game.player.ammo[0].mag = 10; game.startReload(game.player); }
// 调试：?test=ram 断言载具三件套：子弹命中载具/打爆+爆炸波及/撞人碾压（需配合 ff）
if (__params.get('test') === 'ram') {
  const p = game.player, v = game.vehicles[0];
  const en = game.actors.find((a) => a.team === 'blue');
  // 1) 子弹命中载具（从侧面水平射车身）
  const o = new THREE.Vector3(v.pos.x - 8, v.pos.y + 0.8, v.pos.z);
  const hit = castRay(game, o, new THREE.Vector3(1, 0, 0), {});
  const bulletHitsVehicle = !!hit && hit.vehicle === v;
  // 2) 打爆：血量下降 → 归零损毁，且爆炸波及旁边敌人
  en.pos.set(v.pos.x + 3, 0, v.pos.z);
  en.pos.y = heightAt(en.pos.x, en.pos.z);
  en.hp = 100; en.state = 'alive';
  const hp0 = v.hp;
  game.damageVehicle(v, 50, p);
  const damaged = v.hp < hp0;
  game.damageVehicle(v, 9999, p);
  const wrecked = v.wrecked;
  const blastHurt = en.hp < 100;
  // 3) 撞人：另一辆车高速撞上前方敌人
  const v2 = game.vehicles[1];
  en.hp = 100; en.state = 'alive';
  en.pos.set(v2.pos.x + Math.sin(v2.yaw) * 4, 0, v2.pos.z + Math.cos(v2.yaw) * 4);
  en.pos.y = heightAt(en.pos.x, en.pos.z);
  v2.speed = 15;
  game.update(1 / 20); // 车前行一步，应撞上
  const ramHurt = en.hp < 100;
  console.log('TEST-RAM ' + JSON.stringify({ bulletHitsVehicle, damaged, wrecked, blastHurt, ramHurt }));
}
// 调试：?test=heal 断言治疗引导/打断/上限/回满
if (__params.get('test') === 'heal') {
  const p = game.player;
  p.hp = 40;
  const started = game.useMed(p, 'aid') && !!p.heal;
  game.cancelHeal(p); // 打断：不消耗不回血
  const cancelKeeps = p.bag.aid === 2 && p.hp === 40 && !p.heal;
  game.useMed(p, 'aid');
  p.heal.until = game.now; // 直接到期
  game._updateHeal(p);
  const aidWorks = p.hp === 75 && p.bag.aid === 1;
  const denied = !game.useMed(p, 'aid'); // ≥75 不可用急救箱
  game.useMed(p, 'med');
  p.heal.until = game.now;
  game._updateHeal(p);
  const medWorks = p.hp === 100 && p.bag.med === 0;
  console.log('TEST-HEAL ' + JSON.stringify({ started, cancelKeeps, aidWorks, denied, medWorks }));
}
// 调试：?test=aiheal 断言 AI 脱战残血会自己打药（配合 ff 进入 combat）
if (__params.get('test') === 'aiheal') {
  const bot = game.actors.find((a) => a.team === 'blue' && a.ai);
  bot.pos.set(-150, 0, -150); // 挪到无人区：无视线目标
  bot.pos.y = heightAt(bot.pos.x, bot.pos.z);
  bot.hp = 30;
  bot.lastHurtAt = game.now - 10;
  const med0 = bot.bag.med, aid0 = bot.bag.aid;
  let healedAt = null;
  for (let t = 0; t < 10 && healedAt === null; t += 1 / 20) {
    game.update(1 / 20);
    if (bot.hp > 30) healedAt = t;
  }
  console.log('TEST-AIHEAL ' + JSON.stringify({
    healed: bot.hp > 30, hp: Math.round(bot.hp),
    consumed: (bot.bag.med < med0) || (bot.bag.aid < aid0),
    within10s: healedAt !== null,
  }));
}
// 调试：?test=input 断言输入层双源（键盘移动/事件队列/触控摇杆/滑屏视角）
if (__params.get('test') === 'input') {
  // 键盘源：W 前进 + R 事件
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  kbSource.poll();
  const kbdMove = input.moveZ === 1;
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  kbSource.poll();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
  const evOk = input.events.some((e) => e.type === 'reload');
  input.drain();
  // 切触屏：懒创建触控源
  input.setPref('touch');
  const touchUIEl = document.getElementById('touch-ui');
  const joy = document.getElementById('joystick');
  const jr = joy.getBoundingClientRect();
  const jx = jr.left + jr.width / 2, jy = jr.top + jr.height / 2;
  const mkJoy = (type, y) => joy.dispatchEvent(new PointerEvent(type, {
    pointerId: 99, clientX: jx, clientY: y, bubbles: true, pointerType: 'touch',
  }));
  mkJoy('pointerdown', jy);
  mkJoy('pointermove', jy - 50); // 上推满
  const touchMove = input.moveZ > 0.85 && input.sprint;
  mkJoy('pointerup', jy - 50);
  const joyRelease = input.moveZ === 0;
  // 滑屏视角：右半屏拖动
  const rx = window.innerWidth * 0.7, ry = 300;
  const mkLook = (type, x) => touchUIEl.dispatchEvent(new PointerEvent(type, {
    pointerId: 98, clientX: x, clientY: ry, bubbles: true, pointerType: 'touch',
  }));
  mkLook('pointerdown', rx);
  mkLook('pointermove', rx + 60);
  const lookOk = input.lookDX > 0;
  input.setPref('auto');
  // 自动检测：auto 档下 window 收到 touch pointerdown → 应切到触屏
  window.dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 97, pointerType: 'touch', bubbles: true, clientX: 500, clientY: 300,
  }));
  const autoDetect = input.mode() === 'touch';
  // iOS 捏合缩放拦截已挂上（gesturestart 应被 preventDefault）
  const ge = new Event('gesturestart', { cancelable: true });
  document.dispatchEvent(ge);
  const pinchBlocked = ge.defaultPrevented;
  input.setPref('auto');
  input.lastUsed = 'kbd';
  console.log('TEST-INPUT ' + JSON.stringify({ kbdMove, evOk, touchMove, joyRelease, lookOk, autoDetect, pinchBlocked }));
}
// 调试：?test=balance&rounds=N 玩家也挂 AI（公平 4v4），20Hz 离屏快模 N 回合
// （跨多场连续模拟，比赛结束自动重开），输出进攻方胜率（样本 ≥40 回合才有统计意义）
if (__params.get('test') === 'balance') {
  const DEF_IDX = [0, 2, 4, 6];
  const origSetup = game.setupRound.bind(game);
  game.setupRound = () => {
    origSetup();
    // 给玩家补挂 AI（与 setupRound 里 bot 的逻辑同构）
    const p = game.player;
    if (p.team === game.attackSide) {
      p.ai = new AIController(game, p, { role: 'attack', route: ROUTES.back });
    } else {
      const defenseSide = game.attackSide === 'red' ? 'blue' : 'red';
      const di = game.actors.filter((a) => a.team === defenseSide).indexOf(p);
      p.ai = new AIController(game, p, { role: 'defense', post: DEFENSE_POINTS[DEF_IDX[di]] });
    }
  };
  game.setupRound();
  game.matchState = 'combat';
  game.combatUntil = game.now + 270;
  let atkWins = 0, atkRounds = 0;
  const origEnd = game.endRound.bind(game);
  game.endRound = (w) => {
    atkRounds++;
    if (w === game.attackSide) atkWins++;
    if (__params.has('verbose')) {
      console.log('ROUNDEND ' + JSON.stringify({ atk: game.attackSide, winner: w, t: Math.round(game.now) }));
    }
    origEnd(w);
  };
  const target = parseInt(__params.get('rounds')) || 40;
  const step = 1 / 20;
  const t0 = performance.now();
  let guard = target * 6000;
  while (atkRounds < target && guard-- > 0) {
    if (game.matchState === 'matchEnd') game.startMatch(); // 自动打下一场
    game.update(step);
  }
  console.log('BALANCE ' + JSON.stringify({
    atkWins, atkRounds, rate: Math.round((atkWins / atkRounds) * 100) / 100,
    simMs: Math.round(performance.now() - t0),
  }));
}

// Pointer Lock 丢失 → 暂停并提示
const pauseTip = document.getElementById('pause-tip');
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) Audio.resume(); // 重新获取锁定时恢复音频
  const running = ['prep', 'combat', 'roundEnd'].includes(game.matchState);
  game.paused = running && !locked;
  // 背包打开时也失去指针锁定，但显示背包而非暂停提示
  pauseTip.classList.toggle('hidden', !game.paused || hud.backpackOpen);
});
pauseTip.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 主循环
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!game.paused) {
    game.update(dt);
    playerCtl.update(dt);
    updateSnow(dt, camera.position);
    // 阴影相机跟随玩家
    const f = game.player ? game.player.pos : camera.position;
    sun.position.set(f.x + SUN_OFFSET.x, f.y + SUN_OFFSET.y, f.z + SUN_OFFSET.z);
    sun.target.position.set(f.x, f.y, f.z);
    sun.target.updateMatrixWorld();
    hud.updateOverheads(game, camera);
  }
  renderer.render(scene, camera);
}
loop();
