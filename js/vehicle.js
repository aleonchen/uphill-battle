// 载具：MC 风沙滩车。W/S 油门刹车、A/D 转向、F 上下车。
// 物理刻意从简：质点 + 地形贴地 + 坡度限制 + 圆柱碰撞体（石/树），不做过弯侧倾/悬挂。
import * as THREE from 'three';
import { heightAt, activeColliders } from './terrain.js';
import { clamp } from './utils.js';

const MAX_SPEED = 17;     // 前进极速（≈2 倍疾跑，解决进攻接敌节奏）
const MAX_REVERSE = 6;
const ACCEL = 11;
const BRAKE = 24;
const DRAG = 1.6;         // 松油门后的线性减速
const STEER_RATE = 1.7;   // 转向角速度（随速度缩放）
const MAX_SLOPE = 1.1;    // 可攀爬坡度（高差/水平距离），比步行略差，路线沿途足够
const RADIUS = 1.5;       // 碰撞半径

// 像素风车身：底盘 + 座舱 + 防滚架 + 四轮（与 MC 角色同一套盒体语言）
function buildBuggy() {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: 0xb8433a });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2f });
  const frame = new THREE.MeshLambertMaterial({ color: 0x555b63 });

  const add = (mat, w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(body, 1.5, 0.35, 2.6, 0, 0.55, 0);        // 底盘
  add(body, 1.3, 0.3, 1.1, 0, 0.82, 0.55);      // 引擎盖
  add(dark, 1.1, 0.45, 0.9, 0, 0.85, -0.55);    // 座舱
  add(frame, 0.08, 0.7, 0.08, -0.55, 1.2, -0.95); // 防滚架四柱
  add(frame, 0.08, 0.7, 0.08, 0.55, 1.2, -0.95);
  add(frame, 0.08, 0.7, 0.08, -0.55, 1.2, -0.25);
  add(frame, 0.08, 0.7, 0.08, 0.55, 1.2, -0.25);
  add(frame, 1.18, 0.08, 0.78, 0, 1.56, -0.6);  // 顶架

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10);
  wheelGeo.rotateZ(Math.PI / 2); // 轴沿 X
  const wheels = [];
  for (const [x, z] of [[-0.85, 0.9], [0.85, 0.9], [-0.85, -0.9], [0.85, -0.9]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.position.set(x, 0.42, z);
    w.castShadow = true;
    g.add(w);
    wheels.push(w);
  }
  return { group: g, frontWheels: [wheels[0], wheels[1]], wheels };
}

export class Vehicle {
  constructor(scene, x, z) {
    this.home = new THREE.Vector3(x, 0, z);
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;
    this.steerVis = 0;      // 前轮转向视觉
    this.driver = null;     // 驾驶员 actor（目前只有玩家会上车）
    const b = buildBuggy();
    this.group = b.group;
    this.frontWheels = b.frontWheels;
    this.wheels = b.wheels;
    scene.add(this.group);
    this.reset();
  }

  reset() {
    this.pos.set(this.home.x, heightAt(this.home.x, this.home.z), this.home.z);
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z); // 面朝山
    this.speed = 0;
    this.driver = null;
    this.syncMesh(0);
  }

  // input: { fwd: -1..1, steer: -1..1 } 或 null（无人乘坐时惯性滑行）
  update(dt, input) {
    const fwd = input ? input.fwd : 0;
    const steer = input ? input.steer : 0;

    // ---- 纵向 ----
    if (fwd > 0) this.speed += ACCEL * fwd * dt;
    else if (fwd < 0) this.speed += (this.speed > 0.5 ? -BRAKE : ACCEL * 0.55 * fwd) * dt;
    else {
      const s = Math.sign(this.speed);
      this.speed -= s * Math.min(Math.abs(this.speed), DRAG * dt);
    }
    this.speed = clamp(this.speed, -MAX_REVERSE, MAX_SPEED);

    // ---- 转向（速度越大越灵；倒车时方向反） ----
    if (Math.abs(this.speed) > 0.3 && steer !== 0) {
      const grip = clamp(this.speed / 7, -1, 1);
      this.yaw -= steer * STEER_RATE * grip * dt;
    }
    this.steerVis += (steer * 0.42 - this.steerVis) * Math.min(1, 12 * dt);

    // ---- 位移：坡度限制 + 掩体碰撞，分轴滑动 ----
    const step = this.speed * dt;
    if (Math.abs(step) > 1e-5) {
      const maxClimb = MAX_SLOPE * Math.abs(step); // 本帧允许爬升的高差
      const sx = Math.sin(this.yaw) * step, sz = Math.cos(this.yaw) * step;
      let nx = clamp(this.pos.x + sx, -196, 196);
      let nz = clamp(this.pos.z + sz, -196, 196);
      if (this._blocked(nx, nz, maxClimb)) {
        const nxOnly = clamp(this.pos.x + sx, -196, 196);
        const nzOnly = clamp(this.pos.z + sz, -196, 196);
        if (!this._blocked(nxOnly, this.pos.z, maxClimb)) { nx = nxOnly; nz = this.pos.z; }
        else if (!this._blocked(this.pos.x, nzOnly, maxClimb)) { nx = this.pos.x; nz = nzOnly; }
        else { nx = this.pos.x; nz = this.pos.z; this.speed = 0; } // 撞停
      }
      this.pos.x = nx; this.pos.z = nz;
    }
    this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.syncMesh(dt);
  }

  // 目标点是否不可通行：本帧爬升超限 或 撞上掩体圆柱
  _blocked(x, z, maxClimb) {
    if (heightAt(x, z) - this.pos.y > maxClimb) return true;
    for (const c of activeColliders()) {
      if (this.pos.y > c.y1 || this.pos.y + 1.4 < c.y0) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < (c.r + RADIUS) * (c.r + RADIUS)) return true;
    }
    return false;
  }

  // 车身贴地姿态：用前后左右四点高度差算俯仰/侧倾（平滑过渡）
  syncMesh(dt) {
    const g = this.group;
    g.position.copy(this.pos);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx;
    const hF = heightAt(this.pos.x + fx * 1.3, this.pos.z + fz * 1.3);
    const hB = heightAt(this.pos.x - fx * 1.3, this.pos.z - fz * 1.3);
    const hL = heightAt(this.pos.x - rx * 0.9, this.pos.z - rz * 0.9);
    const hR = heightAt(this.pos.x + rx * 0.9, this.pos.z + rz * 0.9);
    const pitch = Math.atan2(hB - hF, 2.6);
    const roll = Math.atan2(hL - hR, 1.8);
    g.rotation.set(pitch, this.yaw, roll, 'YXZ');
    for (const w of this.frontWheels) w.rotation.y = this.steerVis;
    if (dt > 0) {
      const spin = (this.speed * dt) / 0.42;
      for (const w of this.wheels) w.rotation.x += spin;
    }
  }

  // 座位世界坐标（驾驶员 actor 每帧吸附到这里）
  seatPos(out) {
    return out.set(this.pos.x, this.pos.y + 0.75, this.pos.z);
  }
}
