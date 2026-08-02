// 联网（里程碑 A 阶段 1，host-relay）：房主浏览器跑完整 Game 模拟（AI/弹道/回合），
// 加入者发输入、收快照、只渲染。中继见 ws-relay.js（哑转发）。
// 三个角色：
//   NetClient         —— WebSocket 薄封装（协议分发）
//   NetHost           —— 房主侧：坑位分配 + RemoteController 驱动远端 actor + 20Hz 快照
//   NetView           —— 加入者侧：应用快照（插值）+ 上报输入（20Hz）+ HUD 状态机映射
// 阶段 1 边界（后续阶段补）：远端不开载具、投掷物仅爆炸同步（无飞行体/烟团视觉）、
// 房主离开不迁移、100ms 插值缓冲简化为指数平滑。
import * as THREE from 'three';
import { WEAPONS, castRay } from './weapons.js';
import { AIController } from './ai.js';
import { ROUTES, DEFENSE_POINTS, SNOW_LINE } from './terrain.js';
import { setDownedPose, setDeadPose, resetPose, updateCharacterAnim } from './characters.js';
import { Audio } from './audio.js';

const STATE_CODE = { menu: 0, prep: 1, combat: 2, roundEnd: 3, matchEnd: 4 };
const STATE_NAME = ['menu', 'prep', 'combat', 'roundEnd', 'matchEnd'];
const r2 = (v) => Math.round(v * 100) / 100;
const SNAP_HZ = 0.05; // 快照/输入 20Hz
const INTERP_DELAY = 0.1; // 远端实体渲染延迟 100ms（快照插值缓冲，和平精英同款）

// 样本缓冲插值：找渲染时刻 rt 两侧样本线性内插（yaw 走短弧）；出界钳到端点
function interpSamples(sp, rt) {
  if (rt <= sp[0].t) return sp[0];
  const last = sp[sp.length - 1];
  if (rt >= last.t) return last;
  for (let i = sp.length - 1; i > 0; i--) {
    if (sp[i - 1].t <= rt) {
      const a = sp[i - 1], b = sp[i];
      const f = (rt - a.t) / (b.t - a.t || 1);
      let dy = b.yaw - a.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, yaw: a.yaw + dy * f };
    }
  }
  return last;
}

// ---------------- WebSocket 薄封装 ----------------
export class NetClient {
  constructor(url, room, name) {
    this.id = 0;
    this.room = room;   // 邀请链接用
    this.isHost = false;
    this.onReady = null;   // (isHost, peers)
    this.onSnap = null;    // 加入者：收快照
    this.onYou = null;     // 加入者：收坑位分配
    this.onInput = null;   // 房主：收远端输入
    this.onPeerJoin = null; this.onPeerLeave = null;
    this.onError = null;
    this.onClose = null;   // 已入房后连接断开（房主/网络挂了）
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'join', room, name });
    ws.onerror = () => { if (this.onError) this.onError(); };
    ws.onclose = () => {
      if (!this.id) { if (this.onError) this.onError(); }
      else if (this.onClose) this.onClose();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      switch (m.t) {
        case 'welcome': this.id = m.id; this.isHost = m.host; this.onReady?.(m.host, m.peers); break;
        case 'peer-join': this.onPeerJoin?.(m.id, m.name); break;
        case 'peer-leave': this.onPeerLeave?.(m.id, m.wasHost); break;
        case 'snap': this.onSnap?.(m); break;
        case 'you': this.onYou?.(m); break;
        case 'input': this.onInput?.(m.from, m); break;
      }
    };
  }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
}

// ---------------- 房主侧：远端玩家的控制器（与 AIController 同构，吃网络输入） ----------------
export class RemoteController {
  constructor(game, actor, clientId) {
    this.game = game;
    this.actor = actor;
    this.clientId = clientId;
    this.role = 'remote';   // game.js 警觉系统对非 defense 恒响应
    this.state = 'idle';    // game.updateRevives 读 ai.state === 'revive'
    this.target = null;     // alertEnemies 读 ai.target（null = 未交战）
    this.input = null;      // 最新输入包（连续状态每帧生效，事件消费一次）
    this.driveInput = { fwd: 0, steer: 0 }; // 驾驶中写入，game._driveInputOf 取
    this._eye = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  // 与 player.js 同参数的移动/开火语义（走 5.2 / 疾跑 8.0 / ADS 3.0）
  update(dt) {
    const g = this.game, a = this.actor, i = this.input;
    if (g.matchState !== 'combat') return;
    if (a.state !== 'alive') { a.moving = false; a.sprinting = false; return; }
    if (a.reloadUntil > 0 && g.now >= a.reloadUntil) g.finishReload(a); // 与 ai.js 同款收尾
    if (!i) return;
    a.yaw = i.yaw;
    a.pitch = i.pitch;

    // 驾驶中：移动向量转油门/转向，禁步行/开火/跳跃（与本地 updateDriving 一致）
    if (a.inVehicle) {
      this.driveInput.fwd = i.mv[1];
      this.driveInput.steer = i.mv[0];
      a.moving = false;
      a.sprinting = false;
      this.state = 'idle';
      this._consumeEvents(i, true); // 仅下车（interact）生效，其余丢弃
      return;
    }
    this.driveInput.fwd = 0;
    this.driveInput.steer = 0;

    const mx = i.mv[0], mz = i.mv[1];
    const mag = Math.min(1, Math.hypot(mx, mz));
    const moving = mag > 0.01;
    const sprint = !!i.sp && mz > 0;
    if (moving) {
      if (a.heal) g.cancelHeal(a);
      const sin = Math.sin(i.yaw), cos = Math.cos(i.yaw);
      const dx = sin * mz - cos * mx, dz = cos * mz + sin * mx; // 相机系→世界系（同 player.js）
      const len = Math.hypot(dx, dz) || 1;
      const speed = (i.ads ? 3.0 : sprint ? 8.0 : 5.2) * mag;
      g.applyMovement(a, (dx / len) * speed, (dz / len) * speed, dt);
      a.moving = true;
      a.sprinting = sprint;
    } else {
      a.moving = false;
      a.sprinting = false;
    }
    if (i.jump) { if (a.heal) g.cancelHeal(a); g.tryJump(a); }
    this.state = i.revive ? 'revive' : 'idle';

    if (i.fire) {
      if (a.heal) g.cancelHeal(a);
      const w = WEAPONS[a.weaponIndex];
      let spread = i.ads ? w.adsSpread : w.spread;
      if (moving) spread *= sprint ? 2.2 : 1.5;
      const cp = Math.cos(i.pitch);
      const eye = this._eye.set(a.pos.x, a.pos.y + 1.7, a.pos.z);
      const dir = this._dir.set(Math.sin(i.yaw) * cp, Math.sin(i.pitch), Math.cos(i.yaw) * cp);
      g.tryFire(a, eye, dir, spread);
    }

    this._consumeEvents(i, false);
  }

  // 事件只消费一次（输入包每帧重放连续状态）；drivingOnly=true 时仅处理下车交互
  _consumeEvents(i, drivingOnly) {
    if (!i.ev) return;
    const g = this.game, a = this.actor;
    for (const [type, data] of i.ev) {
      if (type === 'interact') { g.toggleVehicleFor(a); continue; }
      if (drivingOnly) continue;
      switch (type) {
        case 'reload': g.startReload(a); break;
        case 'weapon': g.switchWeapon(a, data == null ? (a.weaponIndex === 0 ? 1 : 0) : data); break;
        case 'med': g.useMed(a, data); break;
        case 'throw': {
          const cp = Math.cos(a.pitch);
          g.throwGrenade(a, data,
            new THREE.Vector3(Math.sin(a.yaw) * cp, Math.sin(a.pitch), Math.cos(a.yaw) * cp));
          break;
        }
      }
    }
    i.ev = null;
  }
}

// ---------------- 房主侧：坑位 + 快照广播 ----------------
export class NetHost {
  constructor(game, net) {
    this.game = game;
    this.net = net;
    this.slots = new Map();  // clientId → actor
    this.events = [];        // 本帧游戏事件（快照时打包发出）
    this.sendTimer = 0;
    game.netHook = (ev) => this.events.push(ev);
    net.onPeerJoin = (id, name) => this.addPeer(id, name);
    net.onPeerLeave = (id) => this.removePeer(id);
    net.onInput = (id, msg) => {
      const actor = this.slots.get(id);
      if (actor && actor.ai instanceof RemoteController) actor.ai.input = msg;
    };
  }

  // 人类替换 bot 坑位：红队 bot 优先（与房主同队，合作打 AI），再蓝队
  addPeer(id, name) {
    const free = this.game.actors.filter((a) => !a.isPlayer && !a.isRemote);
    const actor = free.find((a) => a.team === 'red') || free[0];
    if (!actor) return; // 满员（7 远端）：阶段 1 忽略
    actor.isRemote = true;
    actor.name = name;
    actor.ai = new RemoteController(this.game, actor, id);
    this.slots.set(id, actor);
    this.net.send({ t: 'you', to: id, actor: actor.id, team: actor.team, name });
  }

  // 断线：坑位还原为 bot（按当前攻守补 AI）
  removePeer(id) {
    const actor = this.slots.get(id);
    if (!actor) return;
    this.slots.delete(id);
    actor.isRemote = false;
    this.game.hud.toast(`${actor.name} 离开了房间`);
    const g = this.game;
    if (actor.team === g.attackSide) {
      actor.ai = new AIController(g, actor, { role: 'attack', route: ROUTES.front });
    } else {
      let post = DEFENSE_POINTS[0], bd = Infinity;
      for (const p of DEFENSE_POINTS) {
        const d = p.pos.distanceToSquared(actor.pos);
        if (d < bd) { bd = d; post = p; }
      }
      actor.ai = new AIController(g, actor, { role: 'defense', post });
    }
  }

  update(dt) {
    this.sendTimer += dt;
    if (this.sendTimer < SNAP_HZ) return;
    this.sendTimer %= SNAP_HZ;
    if (this.slots.size === 0) { this.events.length = 0; return; }
    this.net.send(this.buildSnap());
    this.events.length = 0;
  }

  buildSnap() {
    const g = this.game;
    return {
      t: 'snap',
      match: [
        STATE_CODE[g.matchState], g.round, g.wins.red, g.wins.blue,
        g.attackSide === 'red' ? 0 : 1,
        r2(Math.max(0, g.stateUntil - g.now)),
        r2(Math.max(0, g.combatUntil - g.now)),
      ],
      actors: g.actors.map((a) => [
        a.id, r2(a.pos.x), r2(a.pos.y), r2(a.pos.z), r2(a.yaw), r2(a.pitch),
        Math.round(a.hp), a.state === 'alive' ? 0 : a.state === 'downed' ? 1 : 2, a.weaponIndex,
        (a.moving ? 1 : 0) | (a.sprinting ? 2 : 0) | (g.now < a.aimUntil ? 4 : 0),
        a.inVehicle ? g.vehicles.indexOf(a.inVehicle) : -1,
        a.ammo[0].mag, a.ammo[0].reserve, a.ammo[1].mag, a.ammo[1].reserve,
        a.bag.aid, a.bag.med, a.bag.frag, a.bag.smoke,
        a.heal ? (a.heal.type === 'aid' ? 0 : 1) : -1,
        a.heal ? r2(a.heal.until - g.now) : 0,
        a.reloadUntil > 0 ? r2(a.reloadUntil - g.now) : 0,
        a.state === 'downed' ? r2(Math.max(0, a.bleedUntil - g.now)) : 0,
        a.state === 'downed' ? r2(a.reviveProgress) : 0,
      ]),
      vehicles: g.vehicles.map((v) => [
        r2(v.pos.x), r2(v.pos.y), r2(v.pos.z), r2(v.yaw), r2(v.speed),
        Math.round(v.hp), v.wrecked ? 1 : 0, v.driver ? v.driver.id : -1,
      ]),
      ev: this.events,
    };
  }
}

// ---------------- 加入者侧：快照应用 + 输入上报 ----------------
export class NetView {
  constructor(game, net, hud, playerCtl, hostName) {
    this.game = game;
    this.net = net;
    this.hud = hud;
    this.ctl = playerCtl;
    this.myActorId = -1;
    this.started = false;      // 收到首个快照
    this.lastState = 0;        // 上次的 matchState 码
    this.wins = [0, 0];
    this.sendTimer = 0;
    this.combatRemain = 0;
    this.stateRemain = 0;
    this._pendingEv = [];
    this._lastVignette = 0;
    this._driving = false;     // 自己是否驾车（引擎声启停跟踪）
    this._nextPredShot = 0;    // 预测曳光：按 rpm  pacing（与房主 tryFire 同节拍）
    this._camDir = new THREE.Vector3();
    this._mz = new THREE.Vector3();
    this.stats = { snaps: 0, shots: 0, booms: 0, smokepops: 0 }; // 自动化探针用
    this._e = new THREE.Vector3();
    // 房主固定是 red[0]（'你' 坑位），换成房主名字
    if (hostName) game.actors[0].name = hostName;
    net.onSnap = (s) => this.applySnap(s);
    net.onYou = (m) => this.setSelf(m);
    // 房主离开（relay 标记 wasHost）：比赛实质结束，提示后等用户自己刷新
    net.onPeerLeave = (id, wasHost) => {
      if (!wasHost) return;
      hud.eventBanner('房主已离开，比赛结束', '#ff5b4d');
      hud.toast('房主已离开，刷新页面可重新加入');
    };
    net.onClose = () => hud.toast('与房主断开连接');
  }

  setSelf(m) {
    const g = this.game;
    this.myActorId = m.actor;
    const me = g.actors[m.actor];
    g.player.isPlayer = false; // 本地默认玩家（red[0]）是房主化身
    g.player = me;
    me.isPlayer = true;
    me.name = m.name;
    this.ctl.resetCamera();
  }

  queueEvent(type, data) { this._pendingEv.push([type, data ?? null]); }

  sendInput() {
    const inp = this.ctl.input, p = this.game.player;
    const ev = this._pendingEv;
    this._pendingEv = [];
    this.net.send({
      t: 'input',
      mv: [r2(inp.moveX), r2(inp.moveZ)],
      sp: inp.sprint ? 1 : 0,
      yaw: r2(p.yaw), pitch: r2(p.pitch),
      fire: inp.state.fire ? 1 : 0,
      jump: inp.state.jump ? 1 : 0,
      revive: inp.state.revive ? 1 : 0,
      ads: this.ctl.ads ? 1 : 0,
      ev,
    });
  }

  // ---- 快照应用 ----
  applySnap(s) {
    const g = this.game, hud = this.hud;
    this.stats.snaps++;
    if (!this.started) {
      this.started = true;
      for (const a of g.actors) a.char.group.visible = true;
    }

    // ---- 比赛状态机映射（全部用剩余时间，免时钟同步） ----
    const [st, round, wr, wb, atk, stateRem, combatRem] = s.match;
    this.stateRemain = stateRem;
    this.combatRemain = combatRem;
    if (st !== this.lastState) {
      const wins = { red: wr, blue: wb };
      if (st >= 1 && this.lastState === 0) hud.onMatchStart();
      if (st === 1) hud.onRoundStart(round, wins, atk === 0);
      else if (st === 2) {
        if (this.lastState === 0) hud.onRoundStart(round, wins, atk === 0);
        hud.onCombatStart();
      } else if (st === 3) {
        const weWon = wr > this.wins[0];
        hud.onRoundEnd(weWon, wins);
        Audio.play(weWon ? 'round_win' : 'round_lose');
      } else if (st === 4) {
        const weWon = wr >= 3;
        hud.onMatchEnd(weWon, wins, g.player);
        Audio.play(weWon ? 'match_win' : 'match_lose');
      }
      this.lastState = st;
    }
    this.wins = [wr, wb];
    g.matchState = STATE_NAME[st];
    g.round = round;
    g.wins = { red: wr, blue: wb };
    g.attackSide = atk === 0 ? 'red' : 'blue';

    // ---- 角色 ----
    for (const d of s.actors) {
      const a = g.actors[d[0]];
      if (!a) continue;
      const isSelf = d[0] === this.myActorId;
      a._netX = d[1]; a._netY = d[2]; a._netZ = d[3]; // 自己：指数平滑目标（手感优先）
      (a._samples ||= []).push({ t: performance.now() / 1000, x: d[1], y: d[2], z: d[3], yaw: d[4] });
      if (a._samples.length > 10) a._samples.shift();
      // 远距离（重生/换边）直接吸附，清空插值缓冲
      const ddx = a.pos.x - d[1], ddz = a.pos.z - d[3];
      if (ddx * ddx + ddz * ddz > 64) { a.pos.set(d[1], d[2], d[3]); a._samples.length = 0; }
      if (!isSelf) a.pitch = d[5]; // 他人 yaw 由插值器每帧写入

      const prevState = a.state;
      const ns = d[7] === 0 ? 'alive' : d[7] === 1 ? 'downed' : 'dead';
      if (ns !== prevState) this.setActorState(a, ns, isSelf);

      const prevHp = a.hp;
      a.hp = d[6];
      if (isSelf && a.hp < prevHp && prevState === 'alive' && g.now - this._lastVignette > 0.3) {
        this._lastVignette = g.now;
        hud.vignette();
        Audio.play('hurt');
      }

      if (isSelf && d[8] !== a.weaponIndex) hud.setWeapon(WEAPONS[d[8]].name);
      a.weaponIndex = d[8];
      a.moving = !!(d[9] & 1);
      a.sprinting = !!(d[9] & 2);
      a.aimUntil = (d[9] & 4) ? g.now + 0.2 : 0;

      const veh = d[10] >= 0 ? g.vehicles[d[10]] : null;
      if (a.inVehicle !== veh) {
        a.inVehicle = veh;
        a.char.group.visible = !veh;
      }

      a.ammo[0].mag = d[11]; a.ammo[0].reserve = d[12];
      a.ammo[1].mag = d[13]; a.ammo[1].reserve = d[14];
      a.bag.aid = d[15]; a.bag.med = d[16]; a.bag.frag = d[17]; a.bag.smoke = d[18];
      a.heal = d[19] >= 0
        ? { type: d[19] === 0 ? 'aid' : 'med', until: g.now + d[20], total: d[19] === 0 ? 5 : 7 }
        : null;
      a.reloadUntil = d[21] > 0 ? g.now + d[21] : 0;
      a.bleedUntil = d[7] === 1 ? g.now + d[22] : 0;
      a.reviveProgress = d[23];
      a.hurtAgo = 999; // 头顶血槽闪红靠 lastHurtAt，联网端从简不闪
    }

    // ---- 载具 ----
    for (let i = 0; i < s.vehicles.length; i++) {
      const d = s.vehicles[i], v = g.vehicles[i];
      if (!v) continue;
      (v._samples ||= []).push({ t: performance.now() / 1000, x: d[0], y: d[1], z: d[2], yaw: d[3] });
      if (v._samples.length > 10) v._samples.shift();
      v.speed = d[4];
      v.hp = d[5];
      const wrecked = !!d[6];
      if (wrecked !== v.wrecked) {
        v.wrecked = wrecked;
        v._samples.length = 0; // 状态切换（含回合重置回出生点）：清缓冲直接归位
        if (wrecked) { v.setWrecked(); v.pos.set(d[0], d[1], d[2]); v.yaw = d[3]; }
        else { // 回合重置修复：恢复配色
          v.mats.body.color.setHex(0xb8433a);
          v.mats.dark.color.setHex(0x2b2b2f);
          v.mats.frame.color.setHex(0x555b63);
          v.pos.set(d[0], d[1], d[2]);
          v.yaw = d[3];
        }
      }
      v.driver = d[7] >= 0 ? g.actors[d[7]] : null;
    }

    // ---- 事件（曳光/播报/爆炸） ----
    for (const ev of s.ev || []) this.renderEvent(ev);
  }

  setActorState(a, ns, isSelf) {
    const hud = this.hud;
    a.state = ns;
    if (ns === 'alive') { resetPose(a.char); if (isSelf) hud.onPlayerRevived(); }
    else if (ns === 'downed') { setDownedPose(a.char); if (isSelf) hud.onPlayerDowned(); }
    else { setDeadPose(a.char); if (isSelf) hud.onPlayerDead(); }
  }

  // 开火瞬间本地预测曳光（和平精英式零延迟反馈）；房主确认帧只补命中特效（去重见 renderEvent）
  predictTracer() {
    const g = this.game, p = g.player;
    const cam = this.ctl.camera;
    const camDir = cam.getWorldDirection(this._camDir);
    const probe = castRay(g, cam.position, camDir, { excludeTeam: p.team });
    const aim = probe ? probe.point : this._e.copy(camDir).multiplyScalar(200).add(cam.position);
    const eye = this._mz.set(p.pos.x, p.pos.y + 1.7, p.pos.z);
    const end = aim.clone().sub(eye).normalize()
      .multiplyScalar(probe ? probe.dist : 200).add(eye);
    p.char.muzzle.getWorldPosition(this._mz);
    g.effects.tracer(this._mz, end); // 曳光从枪口出发（与 host 同一视觉约定）
    Audio.play('shot', { dist: 0, weapon: p.weaponIndex });
  }

  renderEvent(ev) {
    const g = this.game, hud = this.hud;
    if (ev.k === 'shot') {
      this.stats.shots++;
      const e = this._e.set(ev.e[0], ev.e[1], ev.e[2]);
      const shooter = g.actors[ev.id];
      const isSelfShot = ev.id === this.myActorId;
      // 自己的开火：曳光/枪声/枪口焰已在 predictTracer 本地即时画过，这里只补命中特效
      if (!isSelfShot) {
        g.effects.tracer(new THREE.Vector3(ev.o[0], ev.o[1], ev.o[2]), e);
        if (shooter) {
          shooter.char.flash.visible = true;
          shooter._flashOff = g.now + 0.05;
          Audio.play('shot', { dist: shooter.isPlayer ? 0 : shooter.pos.distanceTo(g.player.pos), weapon: ev.w });
          if (!shooter.isPlayer) hud.soundMark(shooter.pos, shooter.team);
        }
      }
      if (ev.h === 1) g.effects.smoke(e, 0x35d04a);
      else if (ev.h === 2) g.effects.spark(e, 0xffcf7a);
      else if (ev.h === 3) g.effects.spark(e, 0x7d786f);
      else g.effects.spark(e, e.y > SNOW_LINE ? 0xf0f4fa : 0x8a857e);
      // 自己命中反馈（与 game.tryFire 玩家分支同语义）
      if (isSelfShot && ev.v >= 0) {
        const victim = g.actors[ev.v];
        const killed = victim && victim.state !== 'alive';
        hud.hitmarker(killed || !!ev.hd);
        Audio.play(killed || ev.hd ? 'ding' : 'hit');
      }
    } else if (ev.k === 'feed') {
      const atk = ev.a >= 0 ? g.actors[ev.a] : null;
      const tgt = g.actors[ev.t];
      if (!tgt) return;
      const kind = ev.m === 'down' ? '击倒' : ev.m === 'kill' ? '淘汰' : '被救起';
      hud.killfeed(atk, tgt, kind);
      if (atk && atk.isPlayer && ev.m === 'down') hud.eventBanner(`你 击倒了 ${tgt.name}`);
      else if (atk && atk.isPlayer && ev.m === 'kill') hud.eventBanner(`你 淘汰了 ${tgt.name}`);
      else if (tgt.isPlayer && ev.m !== 'revive') {
        hud.eventBanner(atk ? `你被 ${atk.name} ${kind}` : (ev.m === 'down' ? '你倒下了' : '你被淘汰了'), '#ff5b4d');
      }
      if (ev.m === 'down' && tgt.team === 'red') Audio.play('down');
      if (ev.m === 'revive' && tgt.team === 'red') Audio.play('revive');
    } else if (ev.k === 'boom') {
      this.stats.booms++;
      const p = this._e.set(ev.p[0], ev.p[1], ev.p[2]);
      g.effects.boom(p);
      Audio.play('boom', { dist: p.distanceTo(g.player.pos) });
    } else if (ev.k === 'nade') {
      // 远端投掷物：本地复现飞行视觉（确定性物理），爆炸/起烟等房主事件
      g.grenades.throwRemote(ev.ty,
        new THREE.Vector3(ev.o[0], ev.o[1], ev.o[2]),
        new THREE.Vector3(ev.v[0], ev.v[1], ev.v[2]));
    } else if (ev.k === 'smokepop') {
      this.stats.smokepops++;
      g.grenades.popSmoke(this._e.set(ev.p[0], ev.p[1], ev.p[2]));
    }
  }

  // ---- 每帧：插值 + 特效 + HUD（不跑任何游戏逻辑） ----
  update(dt) {
    const g = this.game;
    g.now += dt;

    this.sendTimer += dt;
    if (this.sendTimer >= SNAP_HZ) {
      this.sendTimer %= SNAP_HZ;
      this.sendInput();
    }

    // 开火预测曳光（本地即时，房主确认只补命中特效）
    const me0 = g.player;
    if (g.matchState === 'combat' && me0 && me0.state === 'alive' && !me0.inVehicle
      && this.ctl.input.state.fire && me0.reloadUntil <= 0
      && me0.ammo[me0.weaponIndex].mag > 0 && g.now >= this._nextPredShot) {
      this._nextPredShot = g.now + 60 / WEAPONS[me0.weaponIndex].rpm;
      this.predictTracer();
    }

    const rt = performance.now() / 1000 - INTERP_DELAY;
    for (const a of g.actors) {
      if (a.id === this.myActorId) {
        // 自己：指数平滑追最新快照（手感优先，零缓冲延迟）
        if (a._netX !== undefined) {
          const k = 1 - Math.exp(-20 * dt);
          a.pos.x += (a._netX - a.pos.x) * k;
          a.pos.y += (a._netY - a.pos.y) * k;
          a.pos.z += (a._netZ - a.pos.z) * k;
        }
      } else if (a._samples && a._samples.length) {
        // 他人：100ms 延迟快照插值（抗网络抖动）
        const sp = interpSamples(a._samples, rt);
        a.pos.set(sp.x, sp.y, sp.z);
        a.yaw = sp.yaw;
        a.mesh.rotation.y = sp.yaw;
      }
      updateCharacterAnim(a, dt, g.now);
      if (a._flashOff && g.now > a._flashOff) { a.char.flash.visible = false; a._flashOff = 0; }
      a.bleedRemain = a.state === 'downed' ? Math.max(0, a.bleedUntil - g.now) : 0;
    }

    for (const v of g.vehicles) {
      if (!v._samples || !v._samples.length) continue;
      const sp = interpSamples(v._samples, rt);
      v.pos.set(sp.x, sp.y, sp.z);
      v.yaw = sp.yaw;
      v.syncMesh(dt);
    }

    g.effects.update(dt);
    g.grenades.update(dt); // 远端投掷物飞行/烟团视觉（remote 弹不触发伤害，见 grenades.js）

    // 自己驾驶的引擎声（载具与车速来自快照）
    const me = g.player;
    const driving = !!(me && me.inVehicle);
    if (driving !== this._driving) {
      this._driving = driving;
      if (driving) Audio.engineStart(); else Audio.engineStop();
    }
    if (driving) Audio.engineUpdate(Math.abs(me.inVehicle.speed) / 17);

    if (g.matchState === 'combat') {
      this.combatRemain = Math.max(0, this.combatRemain - dt);
      this.hud.setTimer(this.combatRemain);
    } else if (g.matchState === 'prep') {
      this.stateRemain = Math.max(0, this.stateRemain - dt);
      this.hud.setPrepCount(Math.ceil(this.stateRemain));
    }
    this.hud.updateAlive(g.actors);
    this.hud.updatePlayer(g.player, g);
  }
}
