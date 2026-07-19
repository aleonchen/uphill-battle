// 通用数学与噪声工具（无 three 依赖，方便各处复用）

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
export function rand(a = 1, b) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// 确定性整数哈希 → [0,1]
function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// 二维 value 噪声，返回 [-1, 1]
export function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz) * 2 - 1;
}

// 分形叠加噪声
export function fbm(x, z, oct = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise(x * f, z * f);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}
