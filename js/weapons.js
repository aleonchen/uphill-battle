// 武器数据 + hitscan 射击判定 + 曳光/火花特效池
import * as THREE from 'three';
import { heightAt, activeColliders, SNOW_LINE } from './terrain.js';
import { rand } from './utils.js';

export const WEAPONS = [
  {
    name: '突击步枪', mag: 40, reserve: 300, damage: 24, headMult: 1.5,
    rpm: 600, spread: 0.014, adsSpread: 0.005, reload: 2.0,
    falloffStart: 45, falloffEnd: 130, minDmg: 0.45,
  },
  {
    name: '轻机枪 M249', mag: 150, reserve: 300, damage: 17, headMult: 1.5,
    rpm: 720, spread: 0.032, adsSpread: 0.018, reload: 4.2,
    falloffStart: 40, falloffEnd: 120, minDmg: 0.45,
  },
];

const MAX_RANGE = 300;

// ---------------- 烟雾云注册表（grenades.js 写入，ai.js losClear 查询） ----------------
// {x, y, z, r, until}：until 用 game.now 计时，过期不再挡视线
export const smokeClouds = [];

// 线段（from→to）是否穿过任一团有效烟雾
export function smokeBlocksLos(from, to, now) {
  for (const c of smokeClouds) {
    if (now >= c.until) continue;
    // 点到线段距离 < r 即相交
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 > 0
      ? ((c.x - from.x) * dx + (c.y - from.y) * dy + (c.z - from.z) * dz) / len2
      : 0;
    t = Math.max(0, Math.min(1, t));
    const px = from.x + dx * t - c.x, py = from.y + dy * t - c.y, pz = from.z + dz * t - c.z;
    if (px * px + py * py + pz * pz < c.r * c.r) return true;
  }
  return false;
}

// 在 dir 周围加随机圆锥散布
function applySpread(dir, spread) {
  const d = dir.clone();
  d.x += (Math.random() * 2 - 1) * spread;
  d.y += (Math.random() * 2 - 1) * spread;
  d.z += (Math.random() * 2 - 1) * spread;
  return d.normalize();
}

// 射线与球求交，返回最近 t（无交点返回 Infinity）
function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

// 射线与竖直圆柱求交（掩体：岩石/树干），返回最近 t
function rayCylinder(o, d, c) {
  const ox = o.x - c.x, oz = o.z - c.z;
  const A = d.x * d.x + d.z * d.z;
  if (A < 1e-8) return Infinity; // 近乎垂直的射线不判圆柱（交给地形）
  const B = 2 * (ox * d.x + oz * d.z);
  const C = ox * ox + oz * oz - c.r * c.r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t <= 0) return Infinity;
  const y = o.y + d.y * t;
  if (y < c.y0 || y > c.y1) return Infinity;
  return t;
}

// 沿射线与当前画风的掩体碰撞体求交，返回最近 t
function rayCovers(o, d) {
  let best = Infinity;
  for (const c of activeColliders()) {
    // 快速排除：圆柱在射线反方向
    const t = rayCylinder(o, d, c);
    if (t < best) best = t;
  }
  return best;
}

// 沿射线与地形求交（步进 + 二分），返回 t
function rayTerrain(o, d) {
  let t = 1.0;
  let px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
  let prevT = t;
  while (t < MAX_RANGE) {
    if (py < heightAt(px, pz)) {
      // 二分细化
      let lo = prevT, hi = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        const my = o.y + d.y * mid;
        if (my < heightAt(o.x + d.x * mid, o.z + d.z * mid)) hi = mid; else lo = mid;
      }
      return hi;
    }
    prevT = t;
    t += Math.max(1.2, py - heightAt(px, pz)); // 高出地面越多步长越大
    px = o.x + d.x * t; py = o.y + d.y * t; pz = o.z + d.z * t;
  }
  return Infinity;
}

// 对单个角色做命中检测（头部球体 1.5 倍判定 + 躯干双球，贴合 MC 比例：头中心~1.75、躯干~1.1）
function hitActor(o, d, actor) {
  const p = actor.pos;
  if (actor.state === 'downed') {
    // 侧倒：低矮大球
    const t = raySphere(o, d, p.x, p.y + 0.35, p.z, 0.8);
    return { t, isHead: false };
  }
  // 头部（用头部网格的世界位置，与姿态一致）
  const hp = actor.char.head.getWorldPosition(_v1);
  let best = raySphere(o, d, hp.x, hp.y, hp.z, 0.28);
  let isHead = best < Infinity;
  // 躯干双球（腿 + 胸）
  const bodyT = Math.min(
    raySphere(o, d, p.x, p.y + 0.4, p.z, 0.36),
    raySphere(o, d, p.x, p.y + 1.1, p.z, 0.44),
  );
  if (bodyT < best) { best = bodyT; isHead = false; }
  return { t: best, isHead };
}

const _v1 = new THREE.Vector3();

// 纯查询射线求交：地形 + 掩体（石/树）+ 角色（可排除），不造成伤害/特效。
// 返回 { point, target, isHead, dist, onCover }，未命中返回 null
export function castRay(game, origin, dir, { excludeActor = null, excludeTeam = null } = {}) {
  const tTerr = rayTerrain(origin, dir);
  const tCov = rayCovers(origin, dir);
  let tHit = Math.min(tTerr, tCov);
  const onCover = tCov < tTerr; // 首个阻挡是掩体（而非地面）
  let hitTarget = null, isHead = false;
  for (const actor of game.actors) {
    if (actor === excludeActor) continue;
    if (excludeTeam && actor.team === excludeTeam) continue;
    if (actor.state === 'dead') continue;
    const { t, isHead: head } = hitActor(origin, dir, actor);
    if (t < tHit) { tHit = t; hitTarget = actor; isHead = head; }
  }
  if (tHit === Infinity) return null;
  const point = dir.clone().multiplyScalar(tHit).add(origin);
  return { point, target: hitTarget, isHead, dist: tHit, onCover: hitTarget ? false : onCover };
}

// 开火主逻辑：判定 + 伤害 + 特效。返回命中信息
export function fire(game, shooter, origin, dir, spread) {
  const weapon = WEAPONS[shooter.weaponIndex];
  const d = applySpread(dir, spread);
  const hit = castRay(game, origin, d, { excludeTeam: shooter.team });

  const end = hit ? hit.point : d.clone().multiplyScalar(MAX_RANGE).add(origin);

  // 特效：曳光从枪口出发；命中角色冒绿烟，命中掩体石灰，命中地形尘雾按表面变色（雪地白/土岩灰）
  shooter.char.muzzle.getWorldPosition(_v1);
  game.effects.tracer(_v1, end);
  if (hit) {
    if (hit.target) {
      game.effects.smoke(end, 0x35d04a);
    } else if (hit.onCover) {
      game.effects.spark(end, 0x7d786f);
    } else {
      game.effects.spark(end, end.y > SNOW_LINE ? 0xf0f4fa : 0x8a857e);
    }
  }

  if (hit && hit.target) {
    // 距离衰减
    const dist = hit.dist;
    let dmg = weapon.damage;
    if (dist > weapon.falloffStart) {
      const f = Math.min(1, (dist - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart));
      dmg *= 1 - f * (1 - weapon.minDmg);
    }
    if (hit.isHead) dmg *= weapon.headMult;
    game.applyDamage(hit.target, dmg, shooter, hit.isHead);
    return { target: hit.target, isHead: hit.isHead, point: end };
  }
  return { target: null, isHead: false, point: end };
}

// ---------------- 特效池 ----------------
export class Effects {
  constructor(scene) {
    // 曳光：细长发光盒子，快速消退
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(0.045, 0.045, 1);
    for (let i = 0; i < 30; i++) {
      const mesh = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({
        color: 0xffe08a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    // 火花：小四面体向外飞溅
    this.sparks = [];
    const sGeo = new THREE.TetrahedronGeometry(0.09);
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({
        color: 0xffb050, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false;
      scene.add(mesh);
      this.sparks.push({ mesh, life: 0, vel: new THREE.Vector3() });
    }
    // 绿烟：3 个小方块一簇，上升膨胀淡出（命中角色反馈，和平精英风）
    this.smokes = [];
    const mGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    for (let i = 0; i < 12; i++) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({
        color: 0x35d04a, transparent: true, opacity: 0, depthWrite: false,
      });
      for (let j = 0; j < 3; j++) group.add(new THREE.Mesh(mGeo, mat));
      group.visible = false;
      scene.add(group);
      this.smokes.push({ group, mat, life: 0 });
    }
    // 爆炸火球：橙色方盒急速膨胀淡出（手榴弹）
    this.booms = [];
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(bGeo, new THREE.MeshBasicMaterial({
        color: 0xffa245, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false;
      scene.add(mesh);
      this.booms.push({ mesh, life: 0 });
    }
  }

  // 爆炸：中心火球 + 火花 + 灰烟
  boom(p) {
    const b = this.booms.find((x) => x.life <= 0);
    if (b) {
      b.mesh.position.copy(p);
      b.mesh.scale.setScalar(0.6);
      b.mesh.material.opacity = 0.95;
      b.mesh.visible = true;
      b.life = 0.28;
    }
    for (let i = 0; i < 6; i++) this.spark(p, 0xffb050);
    this.smoke(p, 0x9aa0a6);
  }

  tracer(a, b) {
    const t = this.tracers.find((t) => t.life <= 0);
    if (!t) return;
    const len = Math.max(0.1, a.distanceTo(b));
    t.mesh.position.copy(a).lerp(b, 0.5);
    t.mesh.lookAt(b);
    t.mesh.scale.set(1, 1, len);
    t.mesh.visible = true;
    t.mesh.material.opacity = 0.85;
    t.life = 0.09;
  }

  spark(p, color = 0xffb050) {
    const s = this.sparks.find((s) => s.life <= 0);
    if (!s) return;
    s.mesh.position.copy(p);
    s.mesh.material.color.set(color);
    s.mesh.visible = true;
    s.mesh.material.opacity = 1;
    s.vel.set(rand(-2.5, 2.5), rand(1, 4), rand(-2.5, 2.5));
    s.life = 0.18;
  }

  smoke(p, color = 0x35d04a) {
    const s = this.smokes.find((s) => s.life <= 0);
    if (!s) return;
    s.group.position.copy(p);
    s.mat.color.set(color);
    s.mat.opacity = 0.9;
    for (const m of s.group.children) {
      m.position.set(rand(-0.18, 0.18), rand(-0.1, 0.25), rand(-0.18, 0.18));
      m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    }
    s.group.scale.setScalar(1);
    s.group.visible = true;
    s.life = 0.55;
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, (t.life / 0.09) * 0.85);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.y -= 14 * dt;
      s.mesh.material.opacity = Math.max(0, s.life / 0.18);
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (const s of this.smokes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const f = Math.max(0, s.life / 0.55);
      s.group.position.y += 1.4 * dt;          // 上升
      s.group.scale.setScalar(1 + (1 - f) * 1.6); // 膨胀
      s.mat.opacity = f * 0.9;                  // 淡出
      if (s.life <= 0) s.group.visible = false;
    }
    for (const b of this.booms) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const f = Math.max(0, b.life / 0.28);
      b.mesh.scale.setScalar(0.6 + (1 - f) * 3.4); // 0.6 → 4.0 急速膨胀
      b.mesh.material.opacity = f * 0.95;
      if (b.life <= 0) b.mesh.visible = false;
    }
  }
}
