// MC 风角色：方块比例（头0.5立方/躯干0.5×0.75×0.25/四肢0.25×0.75×0.25，带关节 pivot）
// 像素贴图用 canvas 程序生成（NearestFilter、无 mipmap），队伍色上衣
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp } from './utils.js';

// ---------------- GLB 枪模（异步加载，盒枪兜底） ----------------
// GLB 分析结论（Quaternius Assault Rifle，见汇报）：节点变换 scale=100 + 绕X转-90° 后，
// 枪管沿 +X（x∈[-1.49, 3.61]，枪口 +3.61 细截面端），握把/弹匣约在 x=0.63，模型高约 1.8
const GLB_GRIP_X = 0.63;   // 握把在模型世界 x 上的位置（归零用）
const GLB_TARGET_LEN = 1.15; // 目标全长（米，MC 比例偏大更清晰）

let glbTemplate = null;    // 对齐完成（缩放/旋转/握把归零）的模板
let glbMuzzleLocal = null; // 模板枪口在 gun 挂点本地坐标
let glbLoading = false;
const gunMounts = [];      // 已创建角色的挂点登记

// 给某个角色换上 GLB 枪（隐藏盒枪，移动 muzzle/闪光到枪管前端）
function equipGlbGun(m) {
  if (!glbTemplate || m.equipped) return;
  m.equipped = true;
  const inst = glbTemplate.clone(true);
  inst.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  m.gun.add(inst);
  m.boxGun.visible = false; // 盒枪 fallback 隐藏
  m.muzzle.position.copy(glbMuzzleLocal);
  m.flash.position.copy(glbMuzzleLocal);
}

function loadGunModel() {
  if (glbLoading || typeof window === 'undefined') return; // node 冒烟环境跳过
  glbLoading = true;
  new GLTFLoader().load('models/assault-rifle.glb', (gltf) => {
    // 对齐：枪管 +X → 角色前方 +Z；握把移到原点；全长缩放
    const inner = gltf.scene;
    inner.position.x = -GLB_GRIP_X;
    const align = new THREE.Group();
    align.rotation.y = -Math.PI / 2; // +X → +Z，枪管严格指向弹道方向（高相机已保证可见性，不再加侧倾/内扣）
    align.add(inner);
    // 提亮材质到枪灰：原模型基色接近纯黑，背后视角几乎隐形
    inner.traverse((o) => {
      if (o.isMesh && o.material && o.material.color) {
        o.material.color.setRGB(0.22, 0.23, 0.26);
        if ('metalness' in o.material) o.material.metalness = 0.25;
        if ('roughness' in o.material) o.material.roughness = 0.55;
      }
    });
    const wrap = new THREE.Group();
    wrap.add(align);
    const bb = new THREE.Box3().setFromObject(wrap);
    const s = GLB_TARGET_LEN / (bb.max.z - bb.min.z);
    wrap.scale.setScalar(s);
    glbTemplate = wrap;
    // 模板包围盒（缩放后）→ 枪口本地坐标：枪管最前端、枪管轴线高度
    const bb2 = new THREE.Box3().setFromObject(wrap);
    glbMuzzleLocal = new THREE.Vector3(0, (bb2.min.y + bb2.max.y) / 2, bb2.max.z);
    for (const m of gunMounts) equipGlbGun(m);
  }, undefined, (err) => {
    console.warn('[characters] GLB 枪模加载失败，保留盒枪兜底', err);
  });
}

const TEAM_COLORS = {
  red:  { base: '#c0392b', light: '#d9593f', dark: '#8a2a1e' },
  blue: { base: '#2e5fc0', light: '#4d7fd9', dark: '#1f4080' },
};

// ---------------- 像素 atlas（64×64，canvas 生成） ----------------
const TEX_W = 64, TEX_H = 64;
const R = {
  face:  { x: 0,  y: 0, w: 8,  h: 8  },
  hair:  { x: 8,  y: 0, w: 8,  h: 8  },
  skin:  { x: 16, y: 0, w: 8,  h: 8  },
  shirt: { x: 24, y: 0, w: 16, h: 16 },
  pants: { x: 40, y: 0, w: 16, h: 16 },
  dark:  { x: 56, y: 0, w: 8,  h: 8  },
};

function px(ctx, rect, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x + x, rect.y + y, w, h);
}

// 区域内填底色 + 噪点
function fillNoise(ctx, rect, base, spots, n) {
  ctx.fillStyle = base;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = spots[Math.floor(Math.random() * spots.length)];
    ctx.fillRect(rect.x + Math.floor(Math.random() * rect.w),
                 rect.y + Math.floor(Math.random() * rect.h), 1, 1);
  }
}

function makeCharTexture(team) {
  if (typeof document === 'undefined') return null; // node 冒烟环境无 canvas
  const col = TEAM_COLORS[team];
  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const ctx = cv.getContext('2d');
  // 皮肤
  fillNoise(ctx, R.skin, '#e0ac69', ['#d39c58', '#ecc07f'], 10);
  // 头发
  fillNoise(ctx, R.hair, '#3a2a1a', ['#2e2113', '#4a3826'], 14);
  // 脸：皮肤底 + 眼睛 + 嘴
  fillNoise(ctx, R.face, '#e0ac69', ['#d39c58'], 5);
  px(ctx, R.face, 2, 3, 1, 1, '#ffffff'); px(ctx, R.face, 5, 3, 1, 1, '#ffffff');
  px(ctx, R.face, 2, 4, 1, 1, '#2a2a3a'); px(ctx, R.face, 5, 4, 1, 1, '#2a2a3a');
  px(ctx, R.face, 3, 6, 2, 1, '#8a5a3a');
  // 上衣：队伍色像素迷彩
  fillNoise(ctx, R.shirt, col.base, [col.light, col.dark, col.base], 90);
  // 裤鞋
  fillNoise(ctx, R.pants, '#2f3542', ['#262b36', '#3a4152'], 60);
  // 深色（鞋底等）
  fillNoise(ctx, R.dark, '#1c1c1c', ['#141414', '#262626'], 12);

  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const charTextures = { red: null, blue: null };

// BoxGeometry 某面 UV 重映射到 atlas 区域（面序：+x,-x,+y,-y,+z,-z）
export function setFaceUV(geo, face, rect, texW = TEX_W, texH = TEX_H) {
  const uv = geo.attributes.uv;
  const u0 = rect.x / texW, u1 = (rect.x + rect.w) / texW;
  const v0 = 1 - (rect.y + rect.h) / texH, v1 = 1 - rect.y / texH;
  const coords = [[u0, v1], [u1, v1], [u0, v0], [u1, v0]];
  for (let i = 0; i < 4; i++) uv.setXY(face * 4 + i, coords[i][0], coords[i][1]);
  uv.needsUpdate = true;
}

function boxWithUV(w, h, d, mat, faceRects) {
  const geo = new THREE.BoxGeometry(w, h, d);
  faceRects.forEach((rect, face) => { if (rect) setFaceUV(geo, face, rect); });
  return new THREE.Mesh(geo, mat);
}

// ---------------- 角色 ----------------
// 尺寸：腿 0.75、躯干 0.75、头 0.5，总高 2.0；group 原点在脚底，+z 为面向
const LEG_H = 0.75, TORSO_H = 0.75, HEAD_S = 0.5;
const HIP_Y = LEG_H;                       // 髋部 pivot 高
const SHOULDER_Y = LEG_H + TORSO_H - 0.07; // 肩部 pivot 高
const NECK_Y = LEG_H + TORSO_H;            // 颈部 pivot 高

export function createCharacter(team) {
  if (!charTextures[team]) charTextures[team] = makeCharTexture(team);
  const mat = new THREE.MeshLambertMaterial({ map: charTextures[team] });
  const matDark = new THREE.MeshLambertMaterial({ color: 0x232323 });

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // 腿：pivot 在髋部
  const mkLeg = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, HIP_Y, 0);
    const mesh = boxWithUV(0.25, LEG_H, 0.25, mat,
      [R.pants, R.pants, R.pants, R.dark, R.pants, R.pants]);
    mesh.position.y = -LEG_H / 2;
    pivot.add(mesh);
    return pivot;
  };
  const legL = mkLeg(-0.13), legR = mkLeg(0.13);

  // 躯干：上衣
  const torso = boxWithUV(0.5, TORSO_H, 0.25, mat,
    [R.shirt, R.shirt, R.shirt, R.shirt, R.shirt, R.shirt]);
  torso.position.y = HIP_Y + TORSO_H / 2;

  // 手臂：pivot 在肩部
  const mkArm = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, SHOULDER_Y, 0);
    const mesh = boxWithUV(0.25, 0.75, 0.25, mat,
      [R.shirt, R.shirt, R.shirt, R.shirt, R.shirt, R.shirt]);
    mesh.position.y = -0.375;
    pivot.add(mesh);
    return pivot;
  };
  const armL = mkArm(-0.375), armR = mkArm(0.375);

  // 头：pivot 在颈部，脸贴 +z 面
  const headPivot = new THREE.Group();
  headPivot.position.set(0, NECK_Y, 0);
  const head = boxWithUV(HEAD_S, HEAD_S, HEAD_S, mat,
    [R.hair, R.hair, R.hair, R.skin, R.face, R.hair]);
  head.position.y = HEAD_S / 2;
  headPivot.add(head);

  // 枪：挂右手（右手判定：yaw=0 面朝 +z 时越肩侧 right=(-dir.z,0,dir.x)=(-1,0,0)，
  // 即右手在 -x 侧 → armL(-0.375)）。gun 是统一挂点：盒枪(boxGun)为占位/fallback，
  // GLB 加载成功后由 equipGlbGun 替换显示（姿态约定 rotation.x=1.35 + 握把偏移不变）
  const gun = new THREE.Group();
  gun.name = 'gun';
  const boxGun = new THREE.Group(); // 占位盒枪（fallback）
  const gunPart = (name, w, h, d, x, y, z) => {
    const mesh = boxWithUV(w, h, d, mat, [R.dark, R.dark, R.dark, R.dark, R.dark, R.dark]);
    mesh.name = name;
    mesh.position.set(x, y, z);
    boxGun.add(mesh);
    return mesh;
  };
  gunPart('receiver', 0.09, 0.12, 0.30, 0, 0, 0.05);   // 机匣
  gunPart('barrel', 0.045, 0.045, 0.36, 0, 0.03, 0.38); // 枪管
  gunPart('mag', 0.05, 0.16, 0.08, 0, -0.13, 0.02);     // 弹匣
  gunPart('stock', 0.07, 0.10, 0.20, 0, -0.01, -0.22);  // 枪托
  const sight = new THREE.Group();                       // 简易瞄具：照门 + 准星
  sight.name = 'sight';
  const sightRear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.02), matDark);
  sightRear.position.set(0, 0.095, -0.05);
  const sightFront = new THREE.Mesh(
    new THREE.BoxGeometry(0.016, 0.05, 0.016),
    new THREE.MeshLambertMaterial({ color: 0xd23a2a })); // 准星一点红
  sightFront.position.set(0, 0.085, 0.5);
  sight.add(sightRear, sightFront);
  boxGun.add(sight);
  gun.add(boxGun);
  // 预旋转：常态（手臂下垂）枪口朝前略下；手臂前举 -1.35 端枪时枪身恰好水平
  gun.rotation.x = 1.35;
  gun.position.set(0, -0.68, 0.05); // 握把点对齐右手掌心（手臂末端）
  armL.add(gun);
  // 枪口参考点（曳光起点）+ 枪口闪光（池化面片），挂在枪管最前端
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, 0.58);
  gun.add(muzzle);
  const flash = new THREE.Mesh(
    new THREE.CircleGeometry(0.16, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffe9a0, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  flash.position.copy(muzzle.position);
  flash.visible = false;
  gun.add(flash);
  // 登记挂点；若 GLB 已就绪则立即换装
  const mount = { gun, boxGun, muzzle, flash, equipped: false };
  gunMounts.push(mount);
  equipGlbGun(mount);

  body.add(legL, legR, torso, armL, armR, headPivot);
  body.traverse((o) => { if (o.isMesh && o !== flash) o.castShadow = true; });
  return { group, body, head, headPivot, armL, armR, legL, legR, gun, muzzle, flash };
}

// ---------------- 姿态（由 updateCharacterAnim 每帧驱动，这里做一次性切换） ----------------
export function setDownedPose(char) {  // MC 死亡风：整体侧倒 90°
  char.body.rotation.z = Math.PI / 2;
  char.body.position.y = 0.35;
}
export function setDeadPose(char) {
  char.body.rotation.z = Math.PI / 2;
  char.body.position.y = 0.3;
}
export function resetPose(char) {
  char.body.rotation.set(0, 0, 0);
  char.body.position.set(0, 0, 0);
  char.armL.rotation.set(0, 0, 0);
  char.armR.rotation.set(0, 0, 0);
  char.legL.rotation.set(0, 0, 0);
  char.legR.rotation.set(0, 0, 0);
  char.headPivot.rotation.set(0, 0, 0);
}

// 每帧动画：走/跑四肢对摆、持枪/开镜姿态混合、倒地抽动、死亡下沉（无分配）
export function updateCharacterAnim(actor, dt, now) {
  const char = actor.char, body = char.body;
  const k = Math.max(0, 1 - 12 * dt);

  if (actor.state === 'downed' || actor.state === 'dead') {
    // 手臂回中，枪随身体侧倒，不穿帮
    char.armL.rotation.x *= k;
    char.armR.rotation.x *= k;
    body.rotation.y = 0; // 侧身站姿复位
    actor.aimBlend = 0;
    if (actor.state === 'downed') {
      // 侧倒 + 短时抽动后静止
      const t = now - (actor.downedAt || now);
      const jitter = t < 0.6 ? Math.sin(t * 40) * 0.08 * (1 - t / 0.6) : 0;
      body.rotation.z = Math.PI / 2 + jitter;
      body.position.y = 0.35;
    } else {
      body.rotation.z = Math.PI / 2;
      // 缓慢下沉（3 秒沉 0.25m 后停）
      const t = now - (actor.deadAt || now);
      body.position.y = 0.3 - Math.min(0.25, t * 0.08);
    }
    return;
  }

  // 走/跑：四肢对摆（手臂摆动量先记下，后面与端枪姿态混合）；静止指数回零
  let swing = 0;
  if (actor.moving) {
    actor.bobPhase = (actor.bobPhase || 0) + dt * (actor.sprinting ? 11 : 7.5);
    swing = Math.sin(actor.bobPhase) * 0.7;
    char.legL.rotation.x = swing;
    char.legR.rotation.x = -swing;
    body.position.y = Math.abs(Math.sin(actor.bobPhase)) * 0.04;
    body.rotation.x = 0.06; // 轻微前倾
  } else {
    char.legL.rotation.x *= k; char.legR.rotation.x *= k;
    body.position.y *= k;
    body.rotation.x *= k;
  }

  // 持枪姿态混合（aimUntil 由开火/机瞄/AI 交战续期）：0=腰射低位持枪 1=端枪肩眼高
  // 过渡速率 ~10/s；瞄准时手臂停止行走摆动（腿部摆动继续）
  const aiming = actor.aimUntil && now < actor.aimUntil ? 1 : 0;
  actor.aimBlend = (actor.aimBlend ?? 0) + clamp(aiming - (actor.aimBlend ?? 0), -10 * dt, 10 * dt);
  const b = actor.aimBlend;
  const pitch = actor.pitch || 0;
  // 右手（armL，枪）随 pitch 俯仰；左手（armR）托举跟随；头部微低做贴腮感
  char.armL.rotation.x = (-swing * 0.9) * (1 - b) + (-1.35 - pitch) * b;
  char.armR.rotation.x = (swing * 0.9) * (1 - b) + (-1.35 - pitch * 0.7) * b;
  char.headPivot.rotation.x = (pitch * 0.4 + 0.12) * b;
  // 端枪时上身轻微侧转（一点点站姿感即可，扭多了枪管会明显偏离弹道）
  char.body.rotation.y = -0.15 * b;
}

// 模块加载即开始异步拉取 GLB 枪模（加载完成前/失败都用盒枪，无空手窗口）
loadGunModel();
