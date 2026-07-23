// 游戏核心：集中管理 GameState（实体、回合状态机、比分、倒地/救援、共享物理）
import * as THREE from 'three';
import {
  heightAt, buildTerrain, BLOCK, getTerrainMode, setTerrainMode,
  ATTACK_SPAWNS, ROUTES, DEFENSE_POINTS,
} from './terrain.js';
import { createCharacter, setDownedPose, setDeadPose, resetPose, updateCharacterAnim } from './characters.js';
import { WEAPONS, Effects, fire } from './weapons.js';
import { AIController } from './ai.js';
import { Audio } from './audio.js';
import { Vehicle } from './vehicle.js';
import { Grenades } from './grenades.js';
import { clamp, rand } from './utils.js';

const GRAVITY = 22;
const JUMP_VEL = 8.5;          // 跳跃高度 ~1.64m（能上 1 格 1.5m 台阶 + 余量）
const STEP_RATE = 12;          // MC 模式上下台阶的垂直过渡速率
const MAX_SLOPE = 1.5;         // 经典模式坡度限制（约56°，山顶环形区可走）
const ROUND_TIME = 270;        // 4分30秒
const PREP_TIME = 3;
const BANNER_TIME = 3;
const BLEED_TIME = 25;         // 倒地流血时间
const REVIVE_TIME = 4;         // 救援耗时
const REVIVE_RANGE = 3;
const REVIVE_HP = 30;
const WIN_ROUNDS = 3;          // 五局三胜

const RED_NAMES = ['你', '队友·甲', '队友·乙', '队友·丙'];
const BLUE_NAMES = ['敌人·甲', '敌人·乙', '敌人·丙', '敌人·丁'];

export class Game {
  constructor(scene, hud) {
    this.scene = scene;
    this.hud = hud;
    this.now = 0;
    this.matchState = 'menu';   // menu|prep|combat|roundEnd|matchEnd
    this.round = 1;
    this.wins = { red: 0, blue: 0 };
    this.attackSide = 'red';    // 第1回合我方进攻（之后每回合攻守互换）
    this.stateUntil = 0;
    this.combatUntil = 0;
    this.actors = [];
    this.player = null;
    this.input = { reviveHeld: false };
    this.paused = false;
    this._lastCount = 0; // 倒计时蜂鸣记录

    buildTerrain(scene);
    this.effects = new Effects(scene);
    this.createActors();
    // 载具：两个进攻出生点各一辆沙滩车（谁进攻谁用，解决绕后路线的接敌节奏）
    this.vehicles = [
      new Vehicle(scene, ATTACK_SPAWNS.back.x + 8, ATTACK_SPAWNS.back.z - 6),
      new Vehicle(scene, ATTACK_SPAWNS.front.x + 8, ATTACK_SPAWNS.front.z - 6),
    ];
    this.vehicleInput = { fwd: 0, steer: 0 }; // 玩家驾驶输入（player.js 每帧写入）
    this.grenades = new Grenades(scene, this);
  }

  createActors() {
    let id = 0;
    for (const team of ['red', 'blue']) {
      const names = team === 'red' ? RED_NAMES : BLUE_NAMES;
      for (let i = 0; i < 4; i++) {
        const isPlayer = team === 'red' && i === 0;
        const char = createCharacter(team);
        this.scene.add(char.group);
        const actor = {
          id: id++, team, name: names[i], isPlayer,
          char, mesh: char.group,
          pos: char.group.position,
          vel: new THREE.Vector3(),
          yaw: 0, pitch: 0, grounded: true, moving: false, sprinting: false,
          hp: 100, state: 'alive',
          weaponIndex: 0,
          ammo: WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve })),
          nextShot: 0, reloadUntil: 0,
          bleedUntil: 0, reviveProgress: 0,
          lastHurtAt: -1e9, hurtAgo: Infinity, bleedRemain: 0, // 头顶血槽用
          flashOffAt: 0, bobPhase: 0, aimUntil: 0, downedAt: 0, deadAt: 0,
          kills: 0, ai: null,
          // 背包：急救箱/全能医疗箱/手雷/烟雾弹，每回合补给
          bag: { aid: 2, med: 1, frag: 2, smoke: 2 },
          heal: null, // 治疗引导：{ type: 'aid'|'med', until, total }
        };
        char.group.visible = false; // 开局前隐藏
        this.actors.push(actor);
        if (isPlayer) this.player = actor;
      }
    }
  }

  // ---------------- 比赛流程 ----------------
  startMatch() {
    this.wins = { red: 0, blue: 0 };
    this.round = 1;
    this.attackSide = 'red';   // 第1回合我方进攻
    this.player.kills = 0;
    this.setupRound();
  }

  setupRound() {
    const defenseSide = this.attackSide === 'red' ? 'blue' : 'red';
    const defIdx = [0, 2, 4, 6]; // 8 个防守点位取间隔 4 个

    for (const actor of this.actors) {
      // 重置状态
      actor.hp = 100; actor.state = 'alive';
      actor.vel.set(0, 0, 0);
      actor.weaponIndex = 0;
      actor.ammo = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserve }));
      actor.nextShot = 0; actor.reloadUntil = 0;
      actor.bleedUntil = 0; actor.reviveProgress = 0;
      actor.lastHurtAt = -1e9; actor.hurtAgo = Infinity;
      actor.flashOffAt = 0; actor.char.flash.visible = false;
      actor.aimUntil = 0; actor.downedAt = 0; actor.deadAt = 0;
      actor.moving = false; actor.sprinting = false;
      actor.inVehicle = null; // 回合重开强制下车（载具在下方统一回位）
      actor.bag.aid = 2; actor.bag.med = 1; actor.bag.frag = 2; actor.bag.smoke = 2;
      actor.heal = null;
      resetPose(actor.char);
      actor.char.group.visible = true;

      if (actor.team === this.attackSide) {
        // 进攻方：玩家固定走后山点；bot 60% 走正面（175m 更短，与开车到达时间更接近），40% 后山包抄
        const routeKey = actor.isPlayer ? 'back'
          : Math.random() < 0.4 ? 'back' : 'front';
        const spawn = ATTACK_SPAWNS[routeKey];
        actor.pos.set(spawn.x + rand(-4, 4), 0, spawn.z + rand(-4, 4));
        actor.pos.y = heightAt(actor.pos.x, actor.pos.z);
        actor.yaw = Math.atan2(-actor.pos.x, -actor.pos.z); // 面朝山
        actor.pitch = 0;
        actor.ai = actor.isPlayer ? null : new AIController(this, actor, {
          role: 'attack', route: ROUTES[routeKey],
        });
      } else {
        // 防守方：分配到山顶环形点位（玩家不挂 AI，与进攻分支一致）
        const di = this.actors.filter((a) => a.team === defenseSide).indexOf(actor);
        const post = DEFENSE_POINTS[defIdx[di]];
        actor.pos.copy(post.pos);
        actor.yaw = post.yaw;
        actor.pitch = 0;
        actor.ai = actor.isPlayer ? null : new AIController(this, actor, { role: 'defense', post });
      }
    }

    this.matchState = 'prep';
    this.stateUntil = this.now + PREP_TIME;
    this.combatUntil = 0;
    // 载具回出生点、输入清零、引擎静音
    for (const v of this.vehicles) v.reset();
    this.vehicleInput.fwd = 0; this.vehicleInput.steer = 0;
    Audio.engineStop();
    this.hud.setWeapon(WEAPONS[0].name);
    const attacking = this.attackSide === 'red';
    this.hud.onRoundStart(this.round, this.wins, attacking);
  }

  endRound(winnerSide) {
    this.wins[winnerSide]++;
    // 败方倒地者直接淘汰
    for (const a of this.actors) {
      if (a.team !== winnerSide && a.state === 'downed') this.kill(a, null);
    }
    const weWon = winnerSide === 'red';
    this.hud.onRoundEnd(weWon, this.wins);
    Audio.play(weWon ? 'round_win' : 'round_lose');
    if (this.wins[winnerSide] >= WIN_ROUNDS) {
      this.matchState = 'roundEnd';
      this.stateUntil = this.now + BANNER_TIME;
      this.pendingMatchEnd = true;
    } else {
      this.matchState = 'roundEnd';
      this.stateUntil = this.now + BANNER_TIME;
      this.pendingMatchEnd = false;
    }
  }

  endMatch() {
    this.matchState = 'matchEnd';
    const weWon = this.wins.red >= WIN_ROUNDS;
    this.hud.onMatchEnd(weWon, this.wins, this.player);
    Audio.play(weWon ? 'match_win' : 'match_lose');
  }

  // ---------------- 主循环 ----------------
  update(dt) {
    this.now += dt;
    this.effects.update(dt);
    // 载具：有驾驶员时用其输入，否则惯性滑行；驾驶员吸附到座位
    for (const v of this.vehicles) {
      v.update(dt, v.driver ? this.vehicleInput : null);
      if (v.driver) v.seatPos(v.driver.pos);
    }
    this.grenades.update(dt);
    this._updateRamming();
    // 载具残血冒烟（<40%）
    for (const v of this.vehicles) {
      if (!v.wrecked && v.hp < v.hpMax * 0.4 && Math.random() < dt * 3) {
        this.effects.smoke(new THREE.Vector3(v.pos.x, v.pos.y + 1.2, v.pos.z), 0x8a8f94);
      }
    }

    // 每帧杂项：行走动画、枪口闪光熄灭、头顶血槽字段
    for (const a of this.actors) {
      updateCharacterAnim(a, dt, this.now);
      if (a.flashOffAt && this.now > a.flashOffAt) {
        a.char.flash.visible = false;
        a.flashOffAt = 0;
      }
      a.hurtAgo = this.now - a.lastHurtAt;
      a.bleedRemain = a.state === 'downed' ? Math.max(0, a.bleedUntil - this.now) : 0;
    }

    switch (this.matchState) {
      case 'prep': {
        const n = Math.ceil(this.stateUntil - this.now);
        this.hud.setPrepCount(n);
        if (n !== this._lastCount) {  // 3-2-1 蜂鸣
          this._lastCount = n;
          if (n > 0 && n <= 3) Audio.play('count');
        }
        if (this.now >= this.stateUntil) {
          this.matchState = 'combat';
          this.combatUntil = this.now + ROUND_TIME;
          this.hud.onCombatStart();
        }
        break;
      }

      case 'combat': {
        const p = this.player;
        if (p.reloadUntil > 0 && this.now >= p.reloadUntil) this.finishReload(p);
        this._updateHeal(p);
        for (const a of this.actors) if (a.ai) a.ai.update(dt);
        this.updateRevives(dt);
        this.updateBleedouts();
        this.hud.setTimer(Math.max(0, this.combatUntil - this.now));

        const redAlive = this.countAlive('red');
        const blueAlive = this.countAlive('blue');
        if (redAlive === 0 || blueAlive === 0) {
          this.endRound(redAlive > 0 ? 'red' : 'blue');
        } else if (this.now >= this.combatUntil) {
          this.endRound(this.attackSide === 'red' ? 'blue' : 'red'); // 超时防守方胜
        }
        break;
      }

      case 'roundEnd':
        if (this.now >= this.stateUntil) {
          if (this.pendingMatchEnd) {
            this.endMatch();
          } else {
            this.round++;
            this.attackSide = this.attackSide === 'red' ? 'blue' : 'red'; // 攻守互换
            this.setupRound();
          }
        }
        break;
    }

    this.hud.updateAlive(this.actors);
    this.hud.updatePlayer(this.player, this);
  }

  countAlive(team) {
    return this.actors.filter((a) => a.team === team && a.state === 'alive').length;
  }

  getSpectateTarget() {
    return this.actors.find((a) => a.team === 'red' && !a.isPlayer && a.state === 'alive') || null;
  }

  // ---------------- 共享物理 ----------------
  // dirVx/dirVz：水平速度（已乘速率）。按画风模式分派：MC=auto-step，经典=坡度限制
  // _hf 仅测试用：注入合成高度函数
  applyMovement(actor, vx, vz, dt, _hf = heightAt) {
    if (getTerrainMode() === 'mc') this._applyMovementMC(actor, vx, vz, dt, _hf);
    else this._applyMovementClassic(actor, vx, vz, dt, _hf);
    actor.mesh.rotation.y = actor.yaw;
  }

  // MC 模式：台阶 ≤1 格直接走（y 以 12m/s 平滑过渡），>1 格悬崖分轴滑动/挡住
  _applyMovementMC(actor, vx, vz, dt, _hf) {
    const step = Math.hypot(vx, vz) * dt;
    if (step > 1e-6) {
      let nx = clamp(actor.pos.x + vx * dt, -196, 196);
      let nz = clamp(actor.pos.z + vz * dt, -196, 196);
      const rise = _hf(nx, nz) - actor.pos.y;
      if (rise > BLOCK + 0.01) {
        const nxOnly = clamp(actor.pos.x + vx * dt, -196, 196);
        const nzOnly = clamp(actor.pos.z + vz * dt, -196, 196);
        if (_hf(nxOnly, actor.pos.z) - actor.pos.y <= BLOCK + 0.01) {
          nx = nxOnly; nz = actor.pos.z;
        } else if (_hf(actor.pos.x, nzOnly) - actor.pos.y <= BLOCK + 0.01) {
          nx = actor.pos.x; nz = nzOnly;
        } else {
          nx = actor.pos.x; nz = actor.pos.z; // 完全挡住
        }
      }
      actor.pos.x = nx; actor.pos.z = nz;
    }
    const ground = _hf(actor.pos.x, actor.pos.z);
    if (actor.grounded) {
      // 贴地模式：上下台阶都以 STEP_RATE 平滑过渡（不瞬移、下行不悬空飘）
      const dy = ground - actor.pos.y;
      if (Math.abs(dy) > 1e-3) {
        const dir = Math.sign(dy);
        actor.pos.y += dir * STEP_RATE * dt;
        if ((dir > 0 && actor.pos.y > ground) || (dir < 0 && actor.pos.y < ground)) {
          actor.pos.y = ground;
        }
      }
      actor.vel.y = 0;
    } else {
      // 空中：重力；仅在下落时着陆（避免上升途中被台阶顶吸上去）
      actor.vel.y -= GRAVITY * dt;
      actor.pos.y += actor.vel.y * dt;
      if (actor.vel.y <= 0 && actor.pos.y <= ground) {
        actor.pos.y = ground;
        actor.vel.y = 0;
        actor.grounded = true;
      }
    }
  }

  // 经典模式：平滑地形 + 坡度限制（陡坡爬不上，分轴滑动）
  _applyMovementClassic(actor, vx, vz, dt, _hf) {
    const step = Math.hypot(vx, vz) * dt;
    if (step > 1e-6) {
      let nx = clamp(actor.pos.x + vx * dt, -196, 196);
      let nz = clamp(actor.pos.z + vz * dt, -196, 196);
      const rise = _hf(nx, nz) - actor.pos.y;
      if (rise > MAX_SLOPE * step) {
        const nxOnly = clamp(actor.pos.x + vx * dt, -196, 196);
        const nzOnly = clamp(actor.pos.z + vz * dt, -196, 196);
        if (_hf(nxOnly, actor.pos.z) - actor.pos.y <= MAX_SLOPE * step) {
          nx = nxOnly; nz = actor.pos.z;
        } else if (_hf(actor.pos.x, nzOnly) - actor.pos.y <= MAX_SLOPE * step) {
          nx = actor.pos.x; nz = nzOnly;
        } else {
          nx = actor.pos.x; nz = actor.pos.z; // 完全挡住
        }
      }
      actor.pos.x = nx; actor.pos.z = nz;
    }
    // 重力 + 落地
    actor.vel.y -= GRAVITY * dt;
    actor.pos.y += actor.vel.y * dt;
    const ground = _hf(actor.pos.x, actor.pos.z);
    if (actor.pos.y <= ground) {
      actor.pos.y = ground;
      actor.vel.y = 0;
      actor.grounded = true;
    } else {
      actor.grounded = false;
    }
  }

  // V 键切换画风：所有 actor 重贴地，HUD 提示，相机经回调复位
  toggleTerrainMode() {
    const next = getTerrainMode() === 'mc' ? 'classic' : 'mc';
    setTerrainMode(next);
    for (const a of this.actors) {
      a.pos.y = heightAt(a.pos.x, a.pos.z);
      a.vel.y = 0;
      a.grounded = true;
    }
    this.hud.toast(next === 'mc' ? '画风：方块' : '画风：经典');
    if (this.onTerrainModeChanged) this.onTerrainModeChanged(); // main.js 注册：相机复位
  }

  tryJump(actor) {
    if (actor.grounded && actor.state === 'alive') {
      actor.vel.y = JUMP_VEL;
      actor.grounded = false;
    }
  }

  // ---------------- 武器 ----------------
  tryFire(actor, origin, dir, spread) {
    if (this.matchState !== 'combat' || actor.state !== 'alive') return false;
    if (actor.reloadUntil > 0 || this.now < actor.nextShot) return false;
    const mag = actor.ammo[actor.weaponIndex];
    if (mag.mag <= 0) { this.startReload(actor); return false; }
    const w = WEAPONS[actor.weaponIndex];
    actor.nextShot = this.now + 60 / w.rpm;
    mag.mag--;
    const hit = fire(this, actor, origin, dir, spread);
    // 枪口闪光（池化面片，短暂可见）+ 持枪前举姿态
    actor.char.flash.visible = true;
    actor.char.flash.rotation.z = Math.random() * Math.PI;
    actor.flashOffAt = this.now + 0.05;
    actor.aimUntil = this.now + 1.5;
    // 枪声：自己的枪全音量，AI 按与玩家距离衰减
    const dist = actor.isPlayer ? 0 : actor.pos.distanceTo(this.player.pos);
    Audio.play('shot', { dist, weapon: actor.weaponIndex });
    // 他人的枪声上 HUD 方位标记（和平精英式枪声雷达）
    if (!actor.isPlayer) this.hud.soundMark(actor.pos, actor.team);
    if (hit.target) {
      if (actor.isPlayer) {
        const killed = hit.target.state !== 'alive';
        this.hud.hitmarker(killed || hit.isHead);
        Audio.play(killed || hit.isHead ? 'ding' : 'hit');
      }
    }
    // 枪声警觉：通知一定范围内无视线敌人
    this.alertEnemies(actor, 55);
    return true;
  }

  // 玩家投掷手雷/烟雾弹（方向由 player.js 取相机朝向传入）
  throwGrenade(actor, type, dir) {
    if (this.matchState !== 'combat' || actor.state !== 'alive') return false;
    if (actor.bag[type] <= 0) return false;
    actor.bag[type]--;
    const origin = new THREE.Vector3(actor.pos.x, actor.pos.y + 1.6, actor.pos.z);
    this.grenades.throwAt(type, origin, dir, actor);
    actor.aimUntil = this.now + 0.8;
    return true;
  }

  // ---------------- 治疗 ----------------
  // 急救箱 5s → 回至 75；全能医疗箱 7s → 回满。完成才扣物品；移动/开火/受击打断
  useMed(actor, type) {
    if (this.matchState !== 'combat' || actor.state !== 'alive') return false;
    if (actor.heal || actor.inVehicle || actor.bag[type] <= 0) return false;
    if (type === 'aid' && actor.hp >= 75) { this.hud.toast('血量 ≥75，急救箱用不上'); return false; }
    if (type === 'med' && actor.hp >= 100) { this.hud.toast('血量已满'); return false; }
    const total = type === 'aid' ? 5 : 7;
    actor.heal = { type, until: this.now + total, total };
    Audio.play('heal_start');
    return true;
  }

  cancelHeal(actor) {
    if (!actor.heal) return;
    actor.heal = null; // 打断不消耗
    if (actor.isPlayer) this.hud.toast('治疗被打断');
  }

  _updateHeal(actor) {
    const h = actor.heal;
    if (!h || this.now < h.until) return;
    actor.heal = null;
    actor.bag[h.type]--;
    actor.hp = h.type === 'aid' ? Math.max(actor.hp, 75) : 100;
    if (actor.isPlayer) { this.hud.toast(h.type === 'aid' ? '恢复至 75' : '完全恢复'); Audio.play('heal_done'); }
  }

  switchWeapon(actor, idx) {
    if (idx === actor.weaponIndex || actor.state !== 'alive') return;
    actor.weaponIndex = idx;
    actor.reloadUntil = 0;
    if (actor.isPlayer) this.hud.setWeapon(WEAPONS[idx].name);
  }

  startReload(actor) {
    if (actor.state !== 'alive' || actor.reloadUntil > 0) return;
    const a = actor.ammo[actor.weaponIndex];
    const w = WEAPONS[actor.weaponIndex];
    if (a.mag >= w.mag || a.reserve <= 0) return;
    actor.reloadUntil = this.now + w.reload;
    if (actor.isPlayer) { this.hud.setReloading(true); Audio.play('reload_start'); }
  }

  finishReload(actor) {
    const a = actor.ammo[actor.weaponIndex];
    const w = WEAPONS[actor.weaponIndex];
    const need = w.mag - a.mag;
    const take = Math.min(need, a.reserve);
    a.mag += take; a.reserve -= take;
    actor.reloadUntil = 0;
    if (actor.isPlayer) { this.hud.setReloading(false); Audio.play('reload_end'); }
  }

  // ---------------- 伤害 / 倒地 / 救援 ----------------
  applyDamage(target, dmg, attacker, isHead) {
    if (target.state === 'dead') return;
    if (target.isPlayer && target.heal) this.cancelHeal(target); // 受击打断治疗
    if (target.state === 'downed') {
      // 倒地被攻击 → 加速流血
      target.bleedUntil -= 2.5;
      target.lastHurtAt = this.now;
      if (target.isPlayer) { this.hud.vignette(); Audio.play('hurt'); }
      return;
    }
    target.hp -= dmg;
    target.lastHurtAt = this.now;
    if (target.isPlayer) { this.hud.vignette(); Audio.play('hurt'); }
    if (attacker) this.alertVictim(target, attacker);
    if (target.hp <= 0) {
      target.hp = 0;
      this.down(target, attacker);
    }
  }

  // ---------------- 载具伤害（打爆/爆炸波及/撞人碾压） ----------------
  damageVehicle(v, dmg, attacker) {
    if (v.wrecked) return;
    v.hp -= dmg * 1.5;
    if (v.hp <= 0) {
      v.hp = 0;
      v.wrecked = true;
      v.speed = 0;
      if (v.driver) this._eject(v.driver); // 先弹下车，爆炸再结算（车里人照样挨炸）
      v.setWrecked();
      this.grenades.explodeAt(new THREE.Vector3(v.pos.x, v.pos.y + 0.8, v.pos.z), attacker);
    }
  }

  // 高速载具碾压路径上的角色：伤害随车速（≈直接撞倒），撞完减速；不分敌我
  _updateRamming() {
    for (const v of this.vehicles) {
      if (v.wrecked || Math.abs(v.speed) < 5) continue;
      for (const a of this.actors) {
        if (a.state !== 'alive' || a === v.driver) continue;
        if (this.now < (a._ramCd || 0)) continue;
        const dx = a.pos.x - v.pos.x, dz = a.pos.z - v.pos.z;
        if (dx * dx + dz * dz > 2.2 * 2.2) continue;
        a._ramCd = this.now + 1;
        const dmg = clamp(Math.abs(v.speed) * 7, 30, 140);
        this.applyDamage(a, dmg, v.driver || null, false);
        v.speed *= 0.55;
        Audio.play('ram', { dist: a.isPlayer ? 0 : a.pos.distanceTo(this.player.pos) });
        break; // 每帧最多撞一个
      }
    }
  }

  // 从载具上弹出（倒地/死亡/任何强制脱离场景）
  _eject(actor) {
    if (!actor.inVehicle) return;
    actor.inVehicle.driver = null;
    actor.inVehicle = null;
    actor.char.group.visible = true;
    if (actor.isPlayer) Audio.engineStop();
  }

  down(target, attacker) {
    this._eject(target);
    target.state = 'downed';
    target.bleedUntil = this.now + BLEED_TIME;
    target.downedAt = this.now;
    target.reviveProgress = 0;
    target.moving = false;
    setDownedPose(target.char);
    if (attacker) attacker.kills++;
    this.hud.killfeed(attacker, target, '击倒');
    if (attacker && attacker.isPlayer) this.hud.eventBanner(`你 击倒了 ${target.name}`);
    else if (target.isPlayer) this.hud.eventBanner(attacker ? `你被 ${attacker.name} 击倒` : '你倒下了', '#ff5b4d');
    if (target.team === 'red') Audio.play('down'); // 自己或队友倒地提示
    if (target.isPlayer) this.hud.onPlayerDowned();
  }

  kill(target, attacker) {
    if (target.state === 'dead') return;
    this._eject(target);
    target.state = 'dead';
    target.hp = 0;
    target.deadAt = this.now;
    setDeadPose(target.char);
    if (attacker) this.hud.killfeed(attacker, target, '淘汰');
    if (attacker && attacker.isPlayer) this.hud.eventBanner(`你 淘汰了 ${target.name}`);
    else if (target.isPlayer) this.hud.eventBanner(attacker ? `你被 ${attacker.name} 淘汰` : '你被淘汰了', '#ff5b4d');
    if (target.isPlayer) this.hud.onPlayerDead();
  }

  // 救援：倒地者身边 3 米内有队友（玩家按 E / AI 进入救援状态）则累积进度
  updateRevives(dt) {
    for (const d of this.actors) {
      if (d.state !== 'downed') continue;
      let reviving = false;
      for (const t of this.actors) {
        if (t === d || t.team !== d.team || t.state !== 'alive') continue;
        if (t.pos.distanceTo(d.pos) > REVIVE_RANGE) continue;
        if (t.isPlayer) {
          if (this.input.reviveHeld) reviving = true;
        } else if (t.ai && t.ai.state === 'revive') {
          reviving = true;
        }
      }
      if (reviving) {
        d.reviveProgress += dt / REVIVE_TIME;
        if (d.reviveProgress >= 1) this.revive(d);
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - dt * 0.4);
      }
    }
  }

  revive(target) {
    target.state = 'alive';
    target.hp = REVIVE_HP;
    target.reviveProgress = 0;
    target.bleedUntil = 0;
    resetPose(target.char);
    this.hud.killfeed(null, target, '被救起');
    if (target.team === 'red') Audio.play('revive'); // 上行琶音
    if (target.isPlayer) this.hud.onPlayerRevived();
  }

  updateBleedouts() {
    for (const a of this.actors) {
      if (a.state === 'downed' && this.now >= a.bleedUntil) {
        this.kill(a, null);
        this.hud.killfeed(null, a, '流血淘汰');
      }
    }
  }

  // 防守 AI 是否响应某方向的警觉：非防守/无哨位恒响应；
  // 防守只响应哨位朝向 ±75° 内的威胁（扇区把守，避免一枪声全队转身）
  _defenseAcceptsAlert(ai, srcPos) {
    if (ai.role !== 'defense' || !ai.post) return true;
    const a = ai.actor;
    const bearing = Math.atan2(srcPos.x - a.pos.x, srcPos.z - a.pos.z);
    let diff = bearing - ai.post.yaw;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff) < 1.3;
  }

  // 受击者警觉：AI 记录攻击者方位
  alertVictim(victim, attacker) {
    if (victim.ai) {
      victim.ai.alertPos = attacker.pos.clone();
      victim.ai.alertUntil = this.now + 6;
    }
    // 附近队友也警觉（防守方按扇区过滤）
    for (const m of this.actors) {
      if (m.team === victim.team && m.ai && m.pos.distanceTo(victim.pos) < 40) {
        if (!this._defenseAcceptsAlert(m.ai, attacker.pos)) continue;
        m.ai.alertPos = attacker.pos.clone();
        m.ai.alertUntil = this.now + 6;
      }
    }
  }

  // 枪声警觉：范围内未交战的敌人朝声源方向注意（防守方按扇区过滤）
  alertEnemies(shooter, radius) {
    for (const e of this.actors) {
      if (e.team === shooter.team || !e.ai || e.state !== 'alive') continue;
      if (e.pos.distanceTo(shooter.pos) > radius) continue;
      if (e.ai.target) continue; // 已在交战
      if (!this._defenseAcceptsAlert(e.ai, shooter.pos)) continue;
      e.ai.alertPos = shooter.pos.clone();
      e.ai.alertUntil = this.now + 5;
    }
  }
}
