// 投掷物：手榴弹（引信爆炸，范围伤害，地形/岩石掩体可挡）+ 烟雾弹（云团挡 AI 视线）
// 物理刻意从简：质点抛物线 + 地面反弹衰减；爆炸遮挡判定复用 castRay（与子弹同一套规则）
import * as THREE from 'three';
import { heightAt } from './terrain.js';
import { castRay, smokeClouds } from './weapons.js';
import { Audio } from './audio.js';

const GRAV = 18;
const THROW_SPEED = 17;
const FRAG_FUSE = 2.6;      // 手雷引信（脱手即计时）
const SMOKE_DELAY = 1.2;    // 烟雾弹落地后起烟延迟
const SMOKE_LIFE = 18;      // 烟团持续时间
const SMOKE_R = 5.5;        // 烟团半径（挡视线）
const FRAG_R = 7;           // 手雷杀伤半径
const FRAG_DMG = 92;        // 中心伤害（边缘线性衰减到 15%）

export class Grenades {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.live = [];           // 飞行/滚动中的投掷物
    this.clouds = [];         // 视觉烟团（与 smokeClouds 同步增删）
    // 投掷物网格池
    this.pool = { frag: [], smoke: [] };
    const fragMat = new THREE.MeshLambertMaterial({ color: 0x2e4632 });
    const smokeMat = new THREE.MeshLambertMaterial({ color: 0x8b9096 });
    for (let i = 0; i < 5; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), fragMat);
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.24, 8), smokeMat);
      f.visible = s.visible = false;
      scene.add(f, s);
      this.pool.frag.push(f);
      this.pool.smoke.push(s);
    }
    // 烟团视觉池：每团 9 个灰色方块，膨胀后缓滞、结尾淡出
    this.cloudPool = [];
    for (let i = 0; i < 4; i++) {
      const group = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({
        color: 0xd3d8dd, transparent: true, opacity: 0, depthWrite: false,
      });
      const geo = new THREE.BoxGeometry(2.2, 2.2, 2.2);
      for (let j = 0; j < 9; j++) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set((Math.random() - 0.5) * 4.5, Math.random() * 2.2, (Math.random() - 0.5) * 4.5);
        m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        group.add(m);
      }
      group.visible = false;
      scene.add(group);
      this.cloudPool.push({ group, mat, life: 0 });
    }
  }

  // 投出：type 'frag'|'smoke'，owner 为投者 actor（自雷也会伤自己）
  throwAt(type, origin, dir, owner) {
    const mesh = this.pool[type].find((m) => !m.visible);
    if (!mesh) return false;
    mesh.visible = true;
    this.live.push({
      type, owner, mesh,
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(THROW_SPEED).add(new THREE.Vector3(0, 3.5, 0)),
      fuse: type === 'frag' ? FRAG_FUSE : SMOKE_DELAY,
      settled: false,
    });
    Audio.play('throw');
    return true;
  }

  update(dt) {
    const g = this.game;
    // 投掷物飞行/反弹/到时触发
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i];
      n.fuse -= dt;
      if (!n.settled) {
        n.vel.y -= GRAV * dt;
        n.pos.addScaledVector(n.vel, dt);
        const ground = heightAt(n.pos.x, n.pos.z);
        if (n.pos.y <= ground + 0.1) {
          n.pos.y = ground + 0.1;
          if (Math.abs(n.vel.y) < 2.5) {
            n.settled = true; // 停住，等引信
            n.vel.set(0, 0, 0);
          } else {
            n.vel.y = -n.vel.y * 0.42;  // 反弹衰减
            n.vel.x *= 0.6; n.vel.z *= 0.6;
            Audio.play('nade_bounce', { dist: n.pos.distanceTo(g.player.pos) });
          }
        }
        n.mesh.position.copy(n.pos);
        n.mesh.rotation.x += dt * 9;
        n.mesh.rotation.z += dt * 7;
      }
      if (n.fuse <= 0) {
        n.mesh.visible = false;
        this.live.splice(i, 1);
        if (n.type === 'frag') this.explodeAt(n.pos, n.owner);
        else this.popSmoke(n.pos);
      }
    }
    // 烟团视觉：膨胀 → 持留 → 最后 3s 淡出
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.life -= dt;
      const age = SMOKE_LIFE + 3 - c.life; // 含 3s 淡出期
      const grow = Math.min(1, age / 2);
      c.group.scale.setScalar(0.4 + grow * 0.6);
      c.mat.opacity = (c.life > 3 ? 0.82 : Math.max(0, c.life / 3) * 0.82) * (0.4 + grow * 0.6);
      if (c.life <= 0) {
        c.group.visible = false;
        this.clouds.splice(i, 1);
      }
    }
    // 过期视线云清理（与视觉寿命对齐，多留淡出期不影响判定之外的场景）
    for (let i = smokeClouds.length - 1; i >= 0; i--) {
      if (g.now >= smokeClouds[i].until) smokeClouds.splice(i, 1);
    }
  }

  // 手雷爆炸：范围内全员掉血（含队友和自己，和平精英规则），地形/岩石/烟雾外掩体可挡
  explodeAt(pos, owner) {
    const g = this.game;
    g.effects.boom(pos);
    Audio.play('boom', { dist: pos.distanceTo(g.player.pos) });
    const _dir = new THREE.Vector3();
    for (const a of g.actors) {
      if (a.state === 'dead') continue;
      const chest = _dir.set(a.pos.x, a.pos.y + (a.state === 'downed' ? 0.4 : 1.1), a.pos.z);
      const d = chest.distanceTo(pos);
      if (d > FRAG_R) continue;
      // 遮挡判定：从爆心向胸口发射线，第一个命中就是本人才能炸到
      const dir = chest.clone().sub(pos).normalize();
      const hit = castRay(g, pos, dir, {});
      if (!hit || hit.target !== a) continue;
      const dmg = FRAG_DMG * (1 - (d / FRAG_R) * 0.85);
      g.applyDamage(a, dmg, owner === a ? null : owner, false);
    }
  }

  // 烟雾弹起烟：注册视线云 + 视觉云团
  popSmoke(pos) {
    const g = this.game;
    smokeClouds.push({ x: pos.x, y: pos.y + 1.6, z: pos.z, r: SMOKE_R, until: g.now + SMOKE_LIFE });
    const c = this.cloudPool.find((x) => x.life <= 0);
    if (c) {
      c.group.position.copy(pos);
      c.group.visible = true;
      c.life = SMOKE_LIFE + 3; // 视觉多 3s 淡出
      this.clouds.push(c);
    }
    Audio.play('smoke_pop', { dist: pos.distanceTo(g.player.pos) });
  }
}
