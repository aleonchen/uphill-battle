// 玩家控制：吃通用输入层（input.js，键盘/触控/未来手柄同构），第三人称越肩相机（防穿地形）
import * as THREE from 'three';
import { WEAPONS, castRay } from './weapons.js';
import { Audio } from './audio.js';
import { heightAt } from './terrain.js';
import { clamp, lerp } from './utils.js';

const EYE_HEIGHT = 1.7; // MC 比例（总高 2.0）视线高
const WALK_SPEED = 5.2, SPRINT_SPEED = 8.0, ADS_SPEED = 3.0;
const NORMAL_FOV = 65, ADS_FOV = 42;

export class PlayerController {
  constructor(game, camera, input, sources, dom) {
    this.game = game;
    this.camera = camera;
    this.input = input;       // 通用输入层（InputState + 事件队列）
    this.sources = sources;   // 输入源列表，每帧 poll（触控源可后补注入）
    this.dom = dom;           // 仅用于 Pointer Lock 请求
    this.ads = false;
    this.fov = NORMAL_FOV;
    this.camPos = new THREE.Vector3();
    this.camT = 1;              // 相机臂长系数（跨帧持久，速率限制）
    this.camEye = new THREE.Vector3(); // 相机用平滑眼位（只影响相机位置，不影响瞄准）
    this.liftY = 0;             // 相机底部离地间隙（跨帧持久，速率限制）
    this.stepTimer = 0;         // 脚步计时
    this._dir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._aimPoint = new THREE.Vector3();
    this._muzzlePos = new THREE.Vector3();
    this._wantDir = new THREE.Vector3();
    this._parentQuat = new THREE.Quaternion();
    this._zAxis = new THREE.Vector3(0, 0, 1);
  }

  // 画风切换等场景：相机状态清零，下一帧直接吸附到合法位置（不做旧位置平滑）
  resetCamera() {
    this.camPos.set(0, 0, 0);   // 触发首帧吸附
    this.camEye.set(0, 0, 0);
    this.camT = 1;
    this.liftY = 0;
  }

  // 每帧最前：轮询输入源连续状态 + 消费动作事件队列
  _handleEvents() {
    for (const s of this.sources) s.poll();
    const g = this.game, p = g.player;
    const evs = this.input.drain();
    if (!p) return;
    for (const ev of evs) {
      switch (ev.type) {
        case 'reload': g.startReload(p); break;
        case 'weapon': g.switchWeapon(p, ev.data == null ? (p.weaponIndex === 0 ? 1 : 0) : ev.data); break;
        case 'med': g.useMed(p, ev.data); break;
        case 'throw': this.throwNade(ev.data); break;
        case 'interact': this.toggleVehicle(); break;
        case 'backpack': this.toggleBackpack(); break;
        case 'mute': g.hud.setMute(Audio.toggleMuted()); break;
        case 'terrain': g.toggleTerrainMode(); break;
        case 'ads': if (!p.inVehicle) this.ads = !this.ads; break; // 点按切换机瞄
      }
    }
  }

  // G/H 投掷：沿相机朝向抛出（驾驶中禁用，避免车速叠加出鬼畜弹道）
  throwNade(type) {
    const g = this.game, p = g.player;
    if (!p || p.inVehicle || g.matchState !== 'combat') return;
    const camDir = this.camera.getWorldDirection(this._camDir);
    g.throwGrenade(p, type, camDir);
  }

  // Tab 背包：关闭时恢复指针锁定
  toggleBackpack() {
    const open = this.game.hud.toggleBackpack(this.game);
    if (!open) this.dom.requestPointerLock();
  }

  // F 键上/下载具：上车吸附到座位并隐藏角色（命中框随车移动），下车放到车右侧
  toggleVehicle() {
    const g = this.game, p = g.player;
    if (!p || p.state !== 'alive' || g.matchState !== 'combat') return;
    if (p.inVehicle) {
      const v = p.inVehicle;
      v.driver = null;
      p.inVehicle = null;
      const rx = -Math.cos(v.yaw), rz = Math.sin(v.yaw); // 车右方向
      p.pos.set(v.pos.x + rx * 2.6, 0, v.pos.z + rz * 2.6);
      p.pos.y = heightAt(p.pos.x, p.pos.z);
      p.char.group.visible = true;
      this.resetCamera();
      Audio.engineStop();
      return;
    }
    let best = null, bd = 16; // 4m 内最近空车（残骸不可上）
    for (const v of g.vehicles) {
      if (v.driver || v.wrecked) continue;
      const d = v.pos.distanceToSquared(p.pos);
      if (d < bd) { bd = d; best = v; }
    }
    if (best) {
      best.driver = p;
      p.inVehicle = best;
      this.input.state.fire = false;
      this.ads = false;
      // 上车直接切到司机视角：面朝车头方向平视（之后鼠标仍可自由环顾）
      p.yaw = best.yaw;
      p.pitch = 0;
      p.char.group.visible = false;
      this.resetCamera();
      Audio.engineStart();
    }
  }

  // 驾驶中：移动向量转油门/转向，跳过步行/开火/跳跃
  updateDriving(dt) {
    const g = this.game, p = g.player, v = p.inVehicle;
    let fwd = 0, steer = 0;
    if (g.matchState === 'combat') {
      if (this.debugDrive) { fwd = 1; steer = 0.12; } // 调试：无头模拟驾驶（main.js ?drive）
      else { fwd = this.input.moveZ; steer = this.input.moveX; }
    }
    g.vehicleInput.fwd = fwd;
    g.vehicleInput.steer = steer;
    p.moving = false;
    p.sprinting = false;
    Audio.engineUpdate(Math.abs(v.speed) / 17);
  }

  // 每帧更新：输入 → 移动 + 开火 + 相机
  update(dt) {
    const g = this.game, p = g.player;
    this._handleEvents();
    if (!p) return;
    const inp = this.input;

    // 视角（键鼠=Pointer Lock 增量 / 触控=滑屏增量，同一消费口）
    const look = inp.takeLook();
    const sens = this.ads ? 0.0012 : 0.0022;
    p.yaw -= look.dx * sens;
    p.pitch = clamp(p.pitch - look.dy * sens, -1.2, 1.2);

    if (p.inVehicle) {
      this.updateDriving(dt);
      this.updateCamera(dt);
      this._updateInteractTip();
      return;
    }
    const inCombat = g.matchState === 'combat';

    // ---- 移动（仅战斗中且存活；模拟量：键盘 0/1，摇杆 0..1） ----
    let ix = 0, iz = 0;
    if (inCombat && p.state === 'alive') { ix = inp.moveX; iz = inp.moveZ; }
    const mag = Math.min(1, Math.hypot(ix, iz));
    const moving = mag > 0.01;
    const sprint = inp.sprint && !this.ads && iz > 0;
    const speed = (this.ads ? ADS_SPEED : sprint ? SPRINT_SPEED : WALK_SPEED) * Math.max(mag, 0.01);
    if (p.heal && moving) g.cancelHeal(p); // 移动打断治疗
    if (moving) {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      // 相机系：前 (sin,cos)，右 (-cos, sin)
      const dx = (sin * iz - cos * ix), dz = (cos * iz + sin * ix);
      const len = Math.hypot(dx, dz) || 1;
      g.applyMovement(p, (dx / len) * speed, (dz / len) * speed, dt);
      p.moving = true;
      p.sprinting = sprint;
    } else {
      p.moving = false;
      p.sprinting = false;
    }
    if (inCombat && p.state === 'alive' && inp.state.jump) {
      if (p.heal) g.cancelHeal(p); // 跳跃打断治疗
      g.tryJump(p);
    }
    g.input.reviveHeld = inp.state.revive; // E 救援（按住）
    p.mesh.rotation.y = p.yaw; // 身体朝向始终跟视角

    // ---- 脚步：移动且落地时按步频播放 ----
    if (moving && p.grounded && p.state === 'alive') {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        Audio.play('step', { sprint });
        this.stepTimer = sprint ? 0.3 : 0.44;
      }
    } else {
      this.stepTimer = 0;
    }

    // ---- 开火（第三人称视差对齐：相机射线取瞄准点，子弹从眼睛射向它） ----
    if (this.ads) p.aimUntil = g.now + 0.25; // 机瞄持枪前举
    if (inCombat && p.state === 'alive' && inp.state.fire) {
      if (p.heal) g.cancelHeal(p); // 开火打断治疗
      const w = WEAPONS[p.weaponIndex];
      let spread = this.ads ? w.adsSpread : w.spread;
      if (moving) spread *= sprint ? 2.2 : 1.5; // 移动/疾跑降低精度
      // 1) 相机位置沿视线正前方发探测射线（与子弹同一套命中逻辑），取第一个命中点
      const camDir = this.camera.getWorldDirection(this._camDir);
      const probe = castRay(g, this.camera.position, camDir, { excludeTeam: p.team });
      const aimPoint = probe
        ? probe.point
        : this._aimPoint.copy(camDir).multiplyScalar(200).add(this.camera.position);
      // 2) 子弹从角色眼睛射向瞄准点，散布照常叠加
      const eye = this._eye.set(p.pos.x, p.pos.y + EYE_HEIGHT, p.pos.z);
      const dir = aimPoint.sub(eye).normalize();
      if (g.tryFire(p, eye, dir, spread)) {
        p.pitch = clamp(p.pitch + 0.0035, -1.2, 1.2); // 轻微后坐
        p.recoil = Math.min(0.35, (p.recoil ?? 0) + 0.0035); // 记录待恢复量
      }
    }
    // 后坐恢复：停火后视角缓慢回弹
    if (!inp.state.fire && (p.recoil ?? 0) > 0) {
      const rec = Math.min(p.recoil, 0.5 * dt);
      p.pitch = clamp(p.pitch - rec, -1.2, 1.2);
      p.recoil -= rec;
    }

    // ---- 相机 ----
    this.updateCamera(dt);

    // ---- 枪管收束：瞄准/开火时枪管指向准星目标点 ----
    this.updateGunConvergence();

    this._updateInteractTip();
  }

  // 交互提示（上/下车）：键鼠显文字提示，触屏显上下文按钮（DOM 写入去抖在 hud 里）
  _updateInteractTip() {
    const g = this.game, p = g.player;
    let tip = null, act = null; // act: 'enter'|'exit'|null → 触屏按钮
    if (p && p.state === 'alive' && g.matchState === 'combat') {
      if (p.inVehicle) {
        act = 'exit';
        const v = p.inVehicle;
        tip = v.wrecked
          ? '载具已损毁 · F 下车'
          : `F 下车 · W/S 油门刹车 · A/D 转向 · 车况 ${Math.ceil((v.hp / v.hpMax) * 100)}%`;
      } else {
        for (const v of g.vehicles) {
          if (v.driver || v.wrecked) continue;
          if (v.pos.distanceToSquared(p.pos) < 16) { act = 'enter'; tip = '按 F 上车'; break; }
        }
      }
    }
    g.hud.interact(this.input.isTouch() ? null : tip);
    g.hud.interactBtn(this.input.isTouch() ? act : null);
  }

  // 让枪管指向准星探测点：枪管/枪口/曳光/弹道同一视觉线（仅玩家，bot 远看不出差别）
  updateGunConvergence() {
    const g = this.game, p = g.player;
    if (!p || !p.char.gun) return;
    const gun = p.char.gun;
    if (g.matchState === 'combat' && p.state === 'alive' && (p.aimBlend ?? 0) > 0.5) {
      // 准星探测点（与开火同一条相机射线）
      const camDir = this.camera.getWorldDirection(this._camDir);
      const probe = castRay(g, this.camera.position, camDir, { excludeTeam: p.team });
      const aimPoint = probe
        ? probe.point
        : this._aimPoint.copy(camDir).multiplyScalar(200).add(this.camera.position);
      p.mesh.updateMatrixWorld(true);
      const muzzlePos = p.char.muzzle.getWorldPosition(this._muzzlePos);
      const want = this._wantDir.copy(aimPoint).sub(muzzlePos).normalize();
      // 期望方向转到 gun 父节点（手臂）的本地空间，令枪管 +Z 轴对齐它
      gun.parent.getWorldQuaternion(this._parentQuat).invert();
      want.applyQuaternion(this._parentQuat);
      gun.quaternion.setFromUnitVectors(this._zAxis, want);
    } else {
      gun.rotation.set(1.35, 0, 0); // 默认持枪预旋转（与 characters.js 约定一致）
    }
  }

  updateCamera(dt) {
    const g = this.game, p = g.player;
    if (g.matchState === 'menu' || g.matchState === 'matchEnd') return;
    // 玩家倒地/死亡且有存活队友 → 观战队友
    const spec = p.state !== 'alive' ? g.getSpectateTarget() : null;
    const veh = spec ? null : p.inVehicle;
    const focus = spec || p;
    const yaw = spec ? focus.yaw : p.yaw;   // 驾驶时也可自由环顾
    const pitch = spec ? 0.15 : p.pitch;

    const boom = spec || !veh ? (this.ads && !spec ? 1.9 : 3.4) : 6.8;
    const shoulder = veh || spec ? 0 : (this.ads ? 0.5 : 0.65);
    const cp = Math.cos(pitch);
    const dir = this._dir.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const right = this._right.set(-dir.z, 0, dir.x).normalize();
    const eyeH = veh ? 2.3 : (focus.state === 'alive' ? EYE_HEIGHT : 0.6);
    const eye = this._eye.set(focus.pos.x, focus.pos.y + eyeH, focus.pos.z);

    // 相机用平滑眼位：只平滑相机跟随的位置基准（朝向仍严格等于瞄准方向），
    // 消除颠簸地形行走时的高频抖动
    if (this.camEye.lengthSq() === 0) this.camEye.copy(eye);
    this.camEye.lerp(eye, 1 - Math.exp(-20 * dt));

    // 期望相机位：向后拉 + 越肩右移 + 抬高（和平精英式高视角：角色在画面中下部，
    // 从肩后上方能看到枪；朝向仍严格等于瞄准方向，准星精度不受影响）
    const desired = this._desired.copy(this.camEye).addScaledVector(dir, -boom).addScaledVector(right, shoulder);
    desired.y += (this.ads && !spec) ? 0.45 : 1.0;

    // 防穿地形：20 步采样找首个受阻点，再在 [上一自由点, 受阻点] 内二分细化，
    // 得到连续的碰撞系数 t（量化到 0.1 曾在陡坡附近造成来回跳动）
    let tHit = 1, lo = 0, hi = 1;
    for (let i = 1; i <= 20; i++) {
      const f = i / 20;
      const x = this.camEye.x + (desired.x - this.camEye.x) * f;
      const y = this.camEye.y + (desired.y - this.camEye.y) * f;
      const z = this.camEye.z + (desired.z - this.camEye.z) * f;
      if (y < heightAt(x, z) + 0.35) { lo = (i - 1) / 20; hi = f; tHit = f; break; }
    }
    if (tHit < 1) {
      for (let j = 0; j < 4; j++) {
        const mid = (lo + hi) / 2;
        const x = this.camEye.x + (desired.x - this.camEye.x) * mid;
        const y = this.camEye.y + (desired.y - this.camEye.y) * mid;
        const z = this.camEye.z + (desired.z - this.camEye.z) * mid;
        if (y < heightAt(x, z) + 0.35) hi = mid; else lo = mid;
      }
      tHit = lo;
    }
    // 目标系数留少量余量；受阻方向快速拉近（保证不穿墙），释放方向缓慢恢复（避免弹出）
    const wantT = clamp(tHit - 0.02, 0.12, 1);
    const rate = wantT < this.camT ? 25 : 4;
    this.camT += clamp(wantT - this.camT, -rate * dt, rate * dt);

    const target = this._target.copy(this.camEye).lerp(desired, this.camT);

    // 底部离地间隙：瞬时钳制改为跨帧持久 liftY——需要抬高时快速升起（25/s），
    // 地形变低后缓慢回落（4/s）；陡坡平移不再每帧猛抽
    const needLift = Math.max(0, heightAt(target.x, target.z) + 0.3 - target.y);
    const lRate = needLift > this.liftY ? 25 : 4;
    this.liftY += clamp(needLift - this.liftY, -lRate * dt, lRate * dt);
    target.y += this.liftY;

    // 平滑跟随（首帧直接吸附）
    if (this.camPos.lengthSq() === 0) { this.camPos.copy(target); this.camT = wantT; this.liftY = needLift; }
    const k = 1 - Math.exp(-18 * dt);
    this.camPos.lerp(target, k);
    this.camera.position.copy(this.camPos);
    // 朝向始终严格对准瞄准方向，不做地形钳制（钳制会让准星与实际弹道脱节）
    this.camera.lookAt(
      this.camEye.x + dir.x * 8,
      this.camEye.y + dir.y * 8,
      this.camEye.z + dir.z * 8,
    );

    // 机瞄 FOV 渐变
    const wantFov = this.ads && p.state === 'alive' && !spec ? ADS_FOV : NORMAL_FOV;
    this.fov = lerp(this.fov, wantFov, 1 - Math.exp(-12 * dt));
    if (Math.abs(this.fov - this.camera.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
