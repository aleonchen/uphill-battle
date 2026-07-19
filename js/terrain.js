// 地形：双画风（经典平滑 heightfield / MC 方块阶梯），setTerrainMode 切换
// heightAt 按模式分派——物理/AI/子弹/相机全部自动跟随当前模式
import * as THREE from 'three';
import { fbm, valueNoise, clamp, smoothstep, rand } from './utils.js';
import { setFaceUV } from './characters.js';

export const WORLD_SIZE = 400;
export const WORLD_HALF = WORLD_SIZE / 2;
export const SNOW_LINE = 30;
export const BLOCK = 1.5;               // 方块边长（MC 模式块高）

// ---------------- 双模式高度 ----------------
// 平滑地形高度（经典模式的 ground truth，也是 MC 量化前的原始形状）
function smoothHeightAt(x, z) {
  const r = Math.hypot(x, z);
  const m1 = 52 * Math.exp(-(r * r) / (2 * 70 * 70));   // 主山体
  const m2 = 14 * Math.exp(-(r * r) / (2 * 24 * 24));   // 山顶陡帽
  const hillMask = 1 - clamp((m1 + m2) / 30, 0, 1);
  const hills = fbm(x * 0.012 + 3.7, z * 0.012 - 1.3, 4) * 5.0 * hillMask;
  const ridge = fbm(x * 0.03 + 21.4, z * 0.03 - 8.9, 3) * 2.2 * clamp((m1 + m2) / 40, 0, 1);
  const detail = fbm(x * 0.06 + 11.1, z * 0.06 + 5.2, 2) * 0.7;
  return m1 + m2 + hills + ridge + detail;
}

function mcHeightAt(x, z) {
  return BLOCK * Math.round(smoothHeightAt(x, z) / BLOCK);
}

let terrainMode = 'classic'; // 默认经典
let classicGroup = null, mcGroup = null;

export function getTerrainMode() { return terrainMode; }

export function setTerrainMode(mode) {
  terrainMode = mode === 'mc' ? 'mc' : 'classic';
  if (classicGroup) classicGroup.visible = terrainMode === 'classic';
  if (mcGroup) mcGroup.visible = terrainMode === 'mc';
  refreshWaypoints();
}

export function heightAt(x, z) {
  return terrainMode === 'mc' ? mcHeightAt(x, z) : smoothHeightAt(x, z);
}

// 平滑坡度（经典物理/方块分类/树的摆放用，非 MC 物理）
export function slopeAt(x, z) {
  const e = 0.6;
  const dx = (smoothHeightAt(x + e, z) - smoothHeightAt(x - e, z)) / (2 * e);
  const dz = (smoothHeightAt(x, z + e) - smoothHeightAt(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

// ---------------- 出生点 / 路线 / 防守点位（y 随模式刷新） ----------------
const V3 = (x, z) => new THREE.Vector3(x, heightAt(x, z), z);

export const ATTACK_SPAWNS = { front: V3(0, 178), back: V3(-70, 172) };

export const ROUTES = {
  front: [V3(0, 178), V3(6, 130), V3(-8, 92), V3(10, 58), V3(-4, 34), V3(0, 14)],
  // 后山线：西南绕行（平衡基线几何）
  back: [V3(-70, 172), V3(-95, 105), V3(-85, 40), V3(-60, -10), V3(-25, -5), V3(0, 0)],
};

// 出生点周围不放石头/树（避免开局被卡）
function nearSpawn(x, z, r) {
  for (const k of Object.keys(ATTACK_SPAWNS)) {
    const s = ATTACK_SPAWNS[k];
    if (Math.hypot(x - s.x, z - s.z) < r) return true;
  }
  return false;
}

export const DEFENSE_POINTS = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const x = Math.cos(a) * 15, z = Math.sin(a) * 15;
  DEFENSE_POINTS.push({ pos: V3(x, z), yaw: Math.atan2(x, z) });
}

// 模式切换后把所有航点 y 重贴当前地形
function refreshWaypoints() {
  for (const k of Object.keys(ATTACK_SPAWNS)) {
    const p = ATTACK_SPAWNS[k];
    p.y = heightAt(p.x, p.z);
  }
  for (const wps of Object.values(ROUTES)) {
    for (const p of wps) p.y = heightAt(p.x, p.z);
  }
  for (const d of DEFENSE_POINTS) d.pos.y = heightAt(d.pos.x, d.pos.z);
}

// 掩体碰撞体：竖直圆柱 {x, z, y0, y1, r}，按画风分开登记（两 mode 石/树摆法不同）
// 子弹与 AI 视线都查询 activeColliders()；coverSpots() 是 AI 躲掩体用的较大半径子集
export const colliders = { classic: [], mc: [] };
export function activeColliders() { return colliders[terrainMode] || colliders.classic; }
export function coverSpots() { return activeColliders().filter((c) => c.r >= 1.0); }

// ================================================================
// 经典画风：平滑 heightfield + 顶点色、锥形雪顶松、圆润岩石
// ================================================================
function buildClassic(group) {
  const seg = 200;
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x4a7a34), cGrassY = new THREE.Color(0x7a9a3e);
  const cGrassD = new THREE.Color(0x39632c);
  const cRock = new THREE.Color(0x6f6a63), cRockD = new THREE.Color(0x59544d);
  const cSnow = new THREE.Color(0xeef2f8), cSnowB = new THREE.Color(0xdde8f6);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = smoothHeightAt(x, z);
    pos.setY(i, h);
    const s = slopeAt(x, z);
    // 草地：黄绿/深绿噪声斑驳
    const g = valueNoise(x * 0.05, z * 0.05) * 0.5 + 0.5;
    const g2 = valueNoise(x * 0.13 + 40, z * 0.13 - 17) * 0.5 + 0.5;
    c.copy(cGrass).lerp(cGrassY, g * 0.7).lerp(cGrassD, g2 * 0.45);
    // 陡坡露岩：水平岩层色带
    const rockMix = smoothstep(0.45, 0.85, s);
    if (rockMix > 0.01) {
      const band = valueNoise(x * 0.02, h * 0.35) * 0.5 + 0.5;
      c.lerp(cRock.clone().lerp(cRockD, band), rockMix);
    }
    // 雪线以上积雪：冷蓝色调变化
    const snowMix = smoothstep(SNOW_LINE, SNOW_LINE + 9, h) * (1 - smoothstep(1.0, 1.5, s));
    if (snowMix > 0.01) {
      const sb = valueNoise(x * 0.08 - 9, z * 0.08 + 23) * 0.5 + 0.5;
      c.lerp(cSnow.clone().lerp(cSnowB, sb * 0.6), snowMix);
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  group.add(ground);

  buildClassicRocks(group);
  buildClassicTrees(group);
}

// 经典岩石：圆润多面体 + 山顶环形巨石阵 + 进攻路线沿途掩体链
function buildClassicRocks(group) {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0x7b766e });
  const placements = [];
  const addRock = (x, z, s) => {
    placements.push({ x, z, s });
    const y0 = smoothHeightAt(x, z);
    colliders.classic.push({ x, z, y0, y1: y0 + s * 1.05, r: s * 0.95 });
  };
  for (let i = 0; i < 9; i++) { // 山顶环形巨石
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const r = rand(19, 25);
    addRock(Math.cos(a) * r, Math.sin(a) * r, rand(2.0, 3.2));
  }
  // 进攻路线沿途的掩体链（每条路线每个中途航点旁放 1~2 块可藏身的石头）
  for (const wps of Object.values(ROUTES)) {
    for (let i = 1; i < wps.length - 1; i++) {
      const n = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        addRock(wps[i].x + rand(-9, 9), wps[i].z + rand(-9, 9), rand(1.5, 2.4));
      }
    }
  }
  let tries = 0;
  while (placements.length < 9 + 170 && tries++ < 1400) {
    const x = rand(-190, 190), z = rand(-190, 190);
    if (smoothHeightAt(x, z) > SNOW_LINE) continue;
    if (nearSpawn(x, z, 12)) continue;
    const s = 0.5 + 1.7 * Math.random() ** 1.6;
    addRock(x, z, s);
  }
  const inst = new THREE.InstancedMesh(geo, mat, placements.length);
  inst.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  placements.forEach((p, i) => {
    e.set(rand(0, 0.4), rand(0, Math.PI * 2), rand(0, 0.4));
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(p.x, smoothHeightAt(p.x, p.z) + p.s * 0.25, p.z),
      q,
      new THREE.Vector3(p.s * rand(0.8, 1.3), p.s * rand(0.6, 1.0), p.s * rand(0.8, 1.3))
    );
    inst.setMatrixAt(i, m);
  });
  group.add(inst);
}

// 经典树：锥形雪顶松（圆柱树干 + 下绿上白双锥）
function buildClassicTrees(group) {
  const spots = treeSpots();
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.22, 1.6, 5);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4230 });
  const coneGeo = new THREE.ConeGeometry(1.4, 2.6, 6);
  const cone2Geo = new THREE.ConeGeometry(0.95, 1.9, 6);
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x2d5a2a });
  const snowMat = new THREE.MeshLambertMaterial({ color: 0xe8eef4 });

  const n = spots.length;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const cones1 = new THREE.InstancedMesh(coneGeo, leafMat, n);
  const cones2 = new THREE.InstancedMesh(cone2Geo, snowMat, n);
  trunks.castShadow = cones1.castShadow = cones2.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  spots.forEach((p, i) => {
    const y = p.y;
    e.set(0, rand(0, Math.PI * 2), 0); q.setFromEuler(e);
    const sc = new THREE.Vector3(p.s, p.s, p.s);
    m.compose(new THREE.Vector3(p.x, y + 0.8 * p.s, p.z), q, sc);
    trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, y + 2.7 * p.s, p.z), q, sc);
    cones1.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, y + 4.0 * p.s, p.z), q, sc);
    cones2.setMatrixAt(i, m);
    // 树干碰撞体（挡子弹；太细，不挡 AI 视线）
    colliders.classic.push({ x: p.x, z: p.z, y0: y, y1: y + 1.6 * p.s, r: 0.22 * p.s });
  });
  group.add(trunks, cones1, cones2);
}

// 两种画风共用的树位（基于平滑高度，两种模式下位置都合理）
// 结果做模块级缓存——两种画风必须用同一批树位，否则切换画风树会"搬家"
let _treeSpotsCache = null;
function treeSpots() {
  if (_treeSpotsCache) return _treeSpotsCache;
  const spots = [];
  let tries = 0;
  while (spots.length < 240 && tries++ < 3000) {
    const x = rand(-195, 195), z = rand(-195, 195);
    const h = smoothHeightAt(x, z);
    if (h < 1 || h > 24) continue;
    if (slopeAt(x, z) > 0.55) continue;
    if (Math.random() > 1 - (h / 24) * 0.8) continue; // 密度随高度衰减
    if (nearSpawn(x, z, 14)) continue;
    spots.push({ x, z, y: h, s: rand(0.85, 1.3), trunk: 2 + Math.floor(Math.random() * 2) });
  }
  _treeSpotsCache = spots;
  return spots;
}

// ================================================================
// MC 画风：方块阶梯地形 + 方块树石（像素 atlas）
// ================================================================
const ATLAS_W = 128, ATLAS_H = 16;
const TILE = { grassTop: 0, grassSide: 1, dirt: 2, rock: 3, snowTop: 4, snowSide: 5, trunk: 6, leaf: 7 };
const tileRect = (t) => ({ x: t * 16, y: 0, w: 16, h: 16 });
let mcAtlas = null;

function makeAtlas() {
  if (typeof document === 'undefined') return null; // node 冒烟环境无 canvas
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const ctx = cv.getContext('2d');
  const fill = (t, base, spots, n = 70) => {
    const x0 = t * 16;
    ctx.fillStyle = base;
    ctx.fillRect(x0, 0, 16, 16);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = spots[Math.floor(Math.random() * spots.length)];
      ctx.fillRect(x0 + Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 1, 1);
    }
  };
  fill(TILE.grassTop, '#5d8f3e', ['#527f36', '#6a9e47', '#47722e']);
  fill(TILE.grassSide, '#7a5a36', ['#6b4e2e', '#8a6a42'], 50);
  ctx.fillStyle = '#5d8f3e'; ctx.fillRect(TILE.grassSide * 16, 0, 16, 4); // 侧面上绿下土
  fill(TILE.dirt, '#7a5a36', ['#6b4e2e', '#8a6a42']);
  fill(TILE.rock, '#7b766e', ['#6b665f', '#8b8680', '#5d5850']);
  fill(TILE.snowTop, '#eef2f8', ['#e2e9f4', '#f7fafd']);
  fill(TILE.snowSide, '#dfe6f0', ['#cfd8e6', '#eef2f8']);
  fill(TILE.trunk, '#5a4230', ['#4d3826', '#6b5138']);
  fill(TILE.leaf, '#2d5a2a', ['#254c23', '#38682f', '#1f421d'], 90);

  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 方块类型：0 草 1 岩石 2 雪
function classify(x, z, hQ) {
  if (hQ >= SNOW_LINE) return 2;
  if (slopeAt(x, z) > 0.55 || hQ >= 18) return 1;
  return 0;
}

function buildMC(group) {
  if (!mcAtlas) mcAtlas = makeAtlas();
  const mat = new THREE.MeshLambertMaterial({ map: mcAtlas });

  // 列高度网格
  const N = Math.floor((WORLD_HALF * 2) / BLOCK) + 1;
  const origin = -((N - 1) / 2) * BLOCK;
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      H[j * N + i] = mcHeightAt(origin + i * BLOCK, origin + j * BLOCK);
    }
  }

  // 顶块 + 侧面补墙（邻居低 k 格就向下补 k-1 块）
  const placements = [[], [], []];
  const push = (x, y, z, type) => placements[type].push(x, y, z);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = origin + i * BLOCK, z = origin + j * BLOCK;
      const h = H[j * N + i];
      push(x, h - BLOCK / 2, z, classify(x, z, h));
      if (i + 1 < N) {
        const k = Math.round((h - H[j * N + i + 1]) / BLOCK);
        if (k > 1) for (let d = 1; d < k; d++) push(x, h - BLOCK / 2 - d * BLOCK, z, classify(x, z, h));
        else if (k < -1) {
          const nh = H[j * N + i + 1];
          for (let d = 1; d < -k; d++) push(x + BLOCK, nh - BLOCK / 2 - d * BLOCK, z, classify(x + BLOCK, z, nh));
        }
      }
      if (j + 1 < N) {
        const k = Math.round((h - H[(j + 1) * N + i]) / BLOCK);
        if (k > 1) for (let d = 1; d < k; d++) push(x, h - BLOCK / 2 - d * BLOCK, z, classify(x, z, h));
        else if (k < -1) {
          const nh = H[(j + 1) * N + i];
          for (let d = 1; d < -k; d++) push(x, nh - BLOCK / 2 - d * BLOCK, z + BLOCK, classify(x, z + BLOCK, nh));
        }
      }
    }
  }

  const faceTiles = [
    { top: TILE.grassTop, side: TILE.grassSide, bottom: TILE.dirt },
    { top: TILE.rock, side: TILE.rock, bottom: TILE.rock },
    { top: TILE.snowTop, side: TILE.snowSide, bottom: TILE.rock },
  ];
  const m4 = new THREE.Matrix4();
  const cInst = new THREE.Color();
  let total = 0;
  placements.forEach((list, type) => {
    const n = list.length / 3;
    total += n;
    const geo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
    const t = faceTiles[type];
    setFaceUV(geo, 0, tileRect(t.side), ATLAS_W, ATLAS_H);
    setFaceUV(geo, 1, tileRect(t.side), ATLAS_W, ATLAS_H);
    setFaceUV(geo, 2, tileRect(t.top), ATLAS_W, ATLAS_H);
    setFaceUV(geo, 3, tileRect(t.bottom), ATLAS_W, ATLAS_H);
    setFaceUV(geo, 4, tileRect(t.side), ATLAS_W, ATLAS_H);
    setFaceUV(geo, 5, tileRect(t.side), ATLAS_W, ATLAS_H);
    const inst = new THREE.InstancedMesh(geo, mat, n);
    inst.receiveShadow = true;
    inst.castShadow = type !== 0;
    for (let k = 0; k < n; k++) {
      m4.makeTranslation(list[k * 3], list[k * 3 + 1], list[k * 3 + 2]);
      inst.setMatrixAt(k, m4);
      const v = 0.94 + valueNoise(list[k * 3] * 0.4, list[k * 3 + 2] * 0.4) * 0.08;
      inst.setColorAt(k, cInst.setScalar(v));
    }
    group.add(inst);
  });
  console.info(`[terrain-mc] 方块实例总数: ${total}`);

  buildMCRocks(group);
  buildMCTrees(group);
}

// MC 岩石：灰色像素方块堆 + 山顶环形巨石阵 + 进攻路线沿途掩体链
function buildMCRocks(group) {
  const placements = [];
  const addPile = (x, z, maxBlocks, scaleBase) => {
    const n = 1 + Math.floor(Math.random() * maxBlocks);
    const y0 = mcHeightAt(x, z);
    for (let b = 0; b < n; b++) {
      const s = scaleBase * rand(0.8, 1.3) * (1 - b * 0.2);
      placements.push({
        x: x + rand(-0.3, 0.3) * b, y: y0 + s / 2 + b * s * 0.85,
        z: z + rand(-0.3, 0.3) * b, s,
      });
    }
    // 整堆登记一个圆柱碰撞体
    colliders.mc.push({ x, z, y0, y1: y0 + 2.6 * scaleBase, r: scaleBase * 1.15 });
  };
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const r = rand(19, 25);
    addPile(Math.cos(a) * r, Math.sin(a) * r, 3, 2.0);
  }
  // 进攻路线沿途的掩体链（与经典画风同一批位置）
  for (const wps of Object.values(ROUTES)) {
    for (let i = 1; i < wps.length - 1; i++) {
      const n = 1 + (Math.random() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        addPile(wps[i].x + rand(-9, 9), wps[i].z + rand(-9, 9), 3, rand(1.4, 2.2));
      }
    }
  }
  let tries = 0, piles = 0;
  while (piles < 150 && tries++ < 1200) {
    const x = rand(-190, 190), z = rand(-190, 190);
    if (mcHeightAt(x, z) > SNOW_LINE) continue;
    if (nearSpawn(x, z, 12)) continue;
    addPile(x, z, 3, rand(0.6, 1.6));
    piles++;
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let f = 0; f < 6; f++) setFaceUV(geo, f, tileRect(TILE.rock), ATLAS_W, ATLAS_H);
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ map: mcAtlas }), placements.length);
  inst.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  placements.forEach((p, i) => {
    e.set(0, rand(0, Math.PI * 2), 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
    inst.setMatrixAt(i, m);
  });
  group.add(inst);
}

// MC 树：像素方块树干 + 3 层递减树叶方块
function buildMCTrees(group) {
  const spots = treeSpots();
  const trunkGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let f = 0; f < 6; f++) setFaceUV(trunkGeo, f, tileRect(TILE.trunk), ATLAS_W, ATLAS_H);
  const leafGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let f = 0; f < 6; f++) setFaceUV(leafGeo, f, tileRect(TILE.leaf), ATLAS_W, ATLAS_H);

  const n = spots.length;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ map: mcAtlas }), n);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ map: mcAtlas }), n * 3);
  trunks.castShadow = leaves.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const leafSizes = [2.4, 1.8, 1.1];
  spots.forEach((p, i) => {
    e.set(0, rand(0, Math.PI * 2), 0); q.setFromEuler(e);
    const y = mcHeightAt(p.x, p.z);
    const th = p.trunk * BLOCK * p.s;
    m.compose(new THREE.Vector3(p.x, y + th / 2, p.z), q,
      new THREE.Vector3(0.5 * p.s, th, 0.5 * p.s));
    trunks.setMatrixAt(i, m);
    leafSizes.forEach((ls, b) => {
      m.compose(new THREE.Vector3(p.x, y + th + (b + 0.5) * BLOCK * 0.8 * p.s, p.z), q,
        new THREE.Vector3(ls * p.s, BLOCK * 0.8 * p.s, ls * p.s));
      leaves.setMatrixAt(i * 3 + b, m);
    });
    // 树干碰撞体
    colliders.mc.push({ x: p.x, z: p.z, y0: y, y1: y + th, r: 0.3 * p.s });
  });
  group.add(trunks, leaves);
}

// ================================================================
// 入口：两套都建，visible 切换；远景雪山共用
// ================================================================
export function buildTerrain(scene) {
  classicGroup = new THREE.Group();
  classicGroup.name = 'terrain-classic';
  buildClassic(classicGroup);
  mcGroup = new THREE.Group();
  mcGroup.name = 'terrain-mc';
  buildMC(mcGroup);
  scene.add(classicGroup, mcGroup);
  buildBackdrop(scene);
  setTerrainMode(terrainMode); // 应用可见性
}

// 远景雪山剪影（两种画风共用）
function buildBackdrop(scene) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xdfe8f2 });
  const geo = new THREE.ConeGeometry(1, 1, 7);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rand(-0.2, 0.2);
    const r = rand(480, 680);
    const h = rand(120, 220);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * r, h * 0.4 - 10, Math.sin(a) * r);
    m.scale.set(rand(120, 200), h, rand(120, 200));
    m.rotation.y = rand(0, Math.PI);
    scene.add(m);
  }
}
