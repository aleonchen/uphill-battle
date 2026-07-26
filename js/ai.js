// AI：状态机 + 共用感知（视距 + 视线遮挡 + 警觉），分进攻/防守两套行为
import * as THREE from 'three';
import { WEAPONS, smokeBlocksLos } from './weapons.js';
import { activeColliders, coverSpots, heightAt, DEFENSE_POINTS } from './terrain.js';
import { rand, pick } from './utils.js';

const SIGHT_RANGE = 140;      // 视距
const ENGAGE_RANGE = 120;     // 开火距离

const _eye = new THREE.Vector3();
const _tmp = new THREE.Vector3();

// 线段是否与挡视线的掩体（半径 ≥0.9 的岩石；树干太细不挡视线）相交
function segmentBlockedByCover(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const A = dx * dx + dz * dz;
  for (const c of activeColliders()) {
    if (c.r < 0.9) continue;
    // 快速排除：线段 AABB 与圆柱圆心距离过远
    const minX = Math.min(from.x, to.x) - c.r, maxX = Math.max(from.x, to.x) + c.r;
    const minZ = Math.min(from.z, to.z) - c.r, maxZ = Math.max(from.z, to.z) + c.r;
    if (c.x < minX || c.x > maxX || c.z < minZ || c.z > maxZ) continue;
    let t;
    if (A < 1e-8) {
      t = 0;
    } else {
      // 2D 圆求交
      const ox = from.x - c.x, oz = from.z - c.z;
      const B = 2 * (ox * dx + oz * dz);
      const C = ox * ox + oz * oz - c.r * c.r;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t < 0 || t > 1) continue;
    }
    const y = from.y + (to.y - from.y) * t;
    if (y >= c.y0 && y <= c.y1) return true;
  }
  return false;
}

// 视线遮挡：烟雾云 + 岩石掩体 + 沿线地形采样（眼睛→目标胸口）
export function losClear(from, to, now = 0) {
  if (smokeBlocksLos(from, to, now)) return false;
  if (segmentBlockedByCover(from, to)) return false;
  const dist = from.distanceTo(to);
  const steps = Math.ceil(dist / 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    if (heightAt(x, z) + 0.25 > y) return false;
  }
  return true;
}

export class AIController {
  // opts: { role: 'attack'|'defense', route?: 路点数组, post?: {pos, yaw} }
  constructor(game, actor, opts) {
    this.game = game;
    this.actor = actor;
    this.role = opts.role;
    this.post = opts.post || null;
    // 防守扇区：只在与 post 朝向 ±60° 内的点位间巡逻（守方分兵把守，不全环游走）
    this.sectorPoints = null;
    if (this.role === 'defense' && this.post) {
      this.sectorPoints = DEFENSE_POINTS.filter((d) => {
        let diff = d.yaw - this.post.yaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        return Math.abs(diff) < 1.05;
      });
    }
    // 路点加随机偏移，避免所有 bot 走一条线
    this.route = (opts.route || []).map((p) =>
      p.clone().add(new THREE.Vector3(rand(-4, 4), 0, rand(-4, 4))));
    this.wpIndex = 0;
    this.state = 'idle';        // idle|advance|engage|cover|revive|hunt
    this.target = null;         // 当前可见敌人
    this.exposure = 0;          // 目标持续暴露时间（用于收敛瞄准误差）
    this.burstLeft = 0;         // 点射剩余子弹
    this.burstPauseUntil = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.alertPos = null;       // 警觉位置（枪声/受击）
    this.alertUntil = 0;
    this.coverPos = null;
  }

  eye() { return _eye.set(this.actor.pos.x, this.actor.pos.y + 1.7, this.actor.pos.z); }

  // ---------------- 感知 ----------------
  perceive(dt) {
    const g = this.game, a = this.actor;
    let best = null, bestD = SIGHT_RANGE;
    for (const e of g.actors) {
      if (e.team === a.team || e.state === 'dead') continue;
      const d = a.pos.distanceTo(e.pos);
      if (d > bestD) continue;
      _tmp.set(e.pos.x, e.pos.y + (e.state === 'downed' ? 0.4 : 1.0), e.pos.z);
      if (!losClear(this.eye(), _tmp, g.now)) continue;
      best = e; bestD = d;
    }
    if (best === this.target) this.exposure += dt;
    else this.exposure = 0;
    this.target = best;
  }

  // ---------------- 主状态机 ----------------
  update(dt) {
    const g = this.game, a = this.actor;
    if (g.matchState !== 'combat') return;

    if (a.state === 'downed') { this.updateDowned(dt); return; }
    if (a.state !== 'alive') return;

    this.perceive(dt);
    if (a.reloadUntil > 0 && g.now >= a.reloadUntil) g.finishReload(a);
    if (a.ammo[a.weaponIndex].mag === 0 && a.reloadUntil === 0) g.startReload(a);

    // 1) 救援：附近有倒地队友且自身安全
    const downedMate = this.findDownedMate();
    if (downedMate && !this.target) {
      this.state = 'revive';
      this.moveTo(downedMate.pos, dt, WALK);
      return;
    }

    // 2) 交火
    if (this.target) {
      this.state = 'engage';
      this.updateEngage(dt);
      return;
    }

    // 3) 残血/换弹且刚被警觉 → 去掩体
    if ((a.hp < 35 || a.reloadUntil > 0) && g.now < this.alertUntil) {
      this.state = 'cover';
      if (this.updateCover(dt)) return;
    }

    // 3.5) 治疗：脱战（无目标且 4s 未受击）且血量低 → 原地打药，完成前不动
    if (a.heal) { this.state = 'heal'; a.moving = false; return; }
    if (g.now - a.lastHurtAt > 4) {
      if (a.hp < 45 && a.bag.med > 0) g.useMed(a, 'med');
      else if (a.hp < 60 && a.bag.aid > 0) g.useMed(a, 'aid');
      if (a.heal) { this.state = 'heal'; a.moving = false; return; }
    }

    // 4) 分角色默认行为
    if (this.role === 'attack') this.updateAttack(dt);
    else this.updateDefense(dt);
  }

  // 交火：点射 + 横移 peek，进攻方边打边推
  updateEngage(dt) {
    const g = this.game, a = this.actor, t = this.target;
    const dist = a.pos.distanceTo(t.pos);

    // 面向目标
    a.yaw = Math.atan2(t.pos.x - a.pos.x, t.pos.z - a.pos.z);

    // 横移（peek），定期换向
    if (g.now > this.strafeUntil) {
      this.strafeDir *= -1;
      this.strafeUntil = g.now + rand(0.7, 1.6);
    }
    const toT = _tmp.set(t.pos.x - a.pos.x, 0, t.pos.z - a.pos.z).normalize();
    const strafe = { x: -toT.z * this.strafeDir, z: toT.x * this.strafeDir };
    let mx = strafe.x, mz = strafe.z;

    // 进攻方距离远就边打边压上去；双方都无追击距离限制（全图自由交战）
    if (this.role === 'attack' && dist > 28) { mx += toT.x * 0.9; mz += toT.z * 0.9; }
    const len = Math.hypot(mx, mz) || 1;
    g.applyMovement(a, (mx / len) * STRAFE, (mz / len) * STRAFE, dt);
    a.moving = true;

    // 开火：点射节奏，瞄准误差随暴露时间收敛
    if (dist > ENGAGE_RANGE || a.reloadUntil > 0) return;
    if (this.burstLeft <= 0) {
      if (g.now < this.burstPauseUntil) return;
      this.burstLeft = Math.floor(rand(3, 7));
    }
    const w = WEAPONS[a.weaponIndex];
    const aim = _tmp.set(t.pos.x, t.pos.y + (t.state === 'downed' ? 0.35 : 1.15), t.pos.z);
    const dir = aim.sub(this.eye()).normalize();
    let err = 0.05 * Math.exp(-this.exposure * 1.2) + 0.012;
    if (a.moving) err *= 1.7;
    if (g.tryFire(a, this.eye(), dir, err + w.spread)) this.burstLeft--;
    if (this.burstLeft <= 0) this.burstPauseUntil = g.now + rand(0.4, 0.9);
  }

  // 撤退到最近且比当前位置更远离敌人的掩体
  updateCover(dt) {
    const g = this.game, a = this.actor;
    if (!this.coverPos) {
      const threat = this.alertPos || (this.target && this.target.pos);
      let best = null, bestScore = Infinity;
      for (const c of coverSpots()) {
        const dx = c.x - a.pos.x, dz = c.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 45) continue;
        let score = d;
        if (threat) {
          const td = Math.hypot(c.x - threat.x, c.z - threat.z);
          if (td < a.pos.distanceTo(threat)) score += 30; // 掩体不能比现在还靠近敌人
        }
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (!best) return false;
      // 躲到掩体背敌一侧
      const away = threat
        ? _tmp.set(best.x - threat.x, 0, best.z - threat.z).normalize()
        : _tmp.set(0, 0, 1);
      this.coverPos = new THREE.Vector3(
        best.x + away.x * (best.r + 0.6), 0, best.z + away.z * (best.r + 0.6));
    }
    this.moveTo(this.coverPos, dt, SPRINT);
    if (Math.hypot(this.coverPos.x - a.pos.x, this.coverPos.z - a.pos.z) < 1.5) {
      this.coverPos = null;
      this.alertUntil = 0; // 到位，回默认行为
    }
    return true;
  }

  // 进攻方：沿路线推进 → 到顶后清剿（推进速度比通用疾跑快，缩小与开车玩家的到达差）
  updateAttack(dt) {
    const g = this.game, a = this.actor;
    if (this.wpIndex < this.route.length) {
      this.state = 'advance';
      const wp = this.route[this.wpIndex];
      this.moveTo(wp, dt, ATK_SPRINT);
      if (Math.hypot(wp.x - a.pos.x, wp.z - a.pos.z) < 5) this.wpIndex++;
    } else {
      // 路线走完：有警觉位置就压过去，否则往山顶中心摸（疾跑收尾，避免残局拖超时）
      this.state = 'hunt';
      const dest = (g.now < this.alertUntil && this.alertPos) ? this.alertPos : CENTER;
      this.moveTo(dest, dt, SPRINT);
    }
  }

  // 防守方：无目标时在自己扇区内的点位间巡逻驻守；
  // 有警觉（枪声/受击，且经扇区过滤）则全图自由追查/交战，不设任何距离限制
  updateDefense(dt) {
    const g = this.game, a = this.actor;
    if (g.now < this.alertUntil && this.alertPos) {
      this.state = 'hunt';
      this.moveTo(this.alertPos, dt, SPRINT);
      if (Math.hypot(this.alertPos.x - a.pos.x, this.alertPos.z - a.pos.z) < 3) {
        this.alertUntil = 0; // 到达警觉位置，回巡逻
      }
      return;
    }
    this.state = 'hold';
    const pool = this.sectorPoints || DEFENSE_POINTS;
    if (!this.patrolTarget) {
      this.patrolTarget = pick(pool);
      this.patrolUntil = g.now + rand(5, 10);
    }
    const dx = this.patrolTarget.pos.x - a.pos.x, dz = this.patrolTarget.pos.z - a.pos.z;
    if (Math.hypot(dx, dz) > 3) {
      this.moveTo(this.patrolTarget.pos, dt, WALK);
    } else {
      a.moving = false;
      // 驻守：面朝外缓慢扫描
      a.yaw = this.patrolTarget.yaw + Math.sin(g.now * 0.5 + a.id * 2.1) * 0.4;
      if (g.now > this.patrolUntil) {
        this.patrolTarget = pick(pool);
        this.patrolUntil = g.now + rand(5, 10);
      }
    }
  }

  // 倒地：缓慢向最近存活队友爬
  updateDowned(dt) {
    const g = this.game, a = this.actor;
    let mate = null, bestD = Infinity;
    for (const m of g.actors) {
      if (m.team !== a.team || m.state !== 'alive') continue;
      const d = a.pos.distanceTo(m.pos);
      if (d < bestD) { bestD = d; mate = m; }
    }
    if (mate && bestD > 2) this.moveTo(mate.pos, dt, CRAWL);
  }

  findDownedMate() {
    const g = this.game, a = this.actor;
    for (const m of g.actors) {
      if (m.team !== a.team || m.state !== 'downed') continue;
      if (a.pos.distanceTo(m.pos) < 45) return m;
    }
    return null;
  }

  moveTo(dest, dt, speed) {
    const a = this.actor;
    if (a.heal) this.game.cancelHeal(a); // AI 一旦移动即中断治疗
    const dx = dest.x - a.pos.x, dz = dest.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) { a.moving = false; return; }
    if (this.state !== 'engage') a.yaw = Math.atan2(dx, dz);
    this.game.applyMovement(a, (dx / d) * speed, (dz / d) * speed, dt);
    a.moving = true;
    // 卡住自救（2 格悬崖挡住时）：持续无进展就尝试跳跃
    if (!this._lastPos) this._lastPos = a.pos.clone();
    if (a.pos.distanceTo(this._lastPos) < speed * dt * 0.3) {
      this._stuckTime = (this._stuckTime || 0) + dt;
    } else {
      this._stuckTime = 0;
    }
    this._lastPos.copy(a.pos);
    if (this._stuckTime > 0.6) {
      this.game.tryJump(a);
      this._stuckTime = 0;
    }
  }
}

const CENTER = new THREE.Vector3(0, 0, 0);
const WALK = 4.6, STRAFE = 3.2, SPRINT = 7.2, CRAWL = 1.2;
const ATK_SPRINT = 8.4; // 进攻推进速度（平衡：比通用疾跑快，接近开车的一半）
