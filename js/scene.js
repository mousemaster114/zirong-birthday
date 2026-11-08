/**
 * scene.js — La Pâtisserie de Minuit
 * ---------------------------------------------------------------
 * 送给黄子荣的生日网站 · 唯一 3D 场景模块。
 *
 * 午夜法式甜品店：墨绿护墙板 + 冷月光拱窗 + 黄铜壁灯；大理石台面上是
 * 黄铜蛋糕架与三层奶油蛋糕（奶油白 / 开心果绿 / 奶油白），玻璃餐盖
 * 罩着 5 支细蜡烛。reveal / blow / celebrate / relight / reset 全部
 * 通过内部时间轴实现，幂等、可被中断。
 *
 * 契约见 CONTRACT.md；本文件只 import 'three' / 'three/addons/*' 与 './bus.js'。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { bus } from './bus.js';

/* ============================================================
 * 0. 色板（与 DESIGN.md / styles.css 对齐）
 * ========================================================== */

const PALETTE = {
  ink: 0x04100b,
  forestDeep: 0x071a12,
  forest: 0x0c241a,
  forestSoft: 0x153b2c,
  cream: 0xf6efe3,
  creamHi: 0xfffbf2,
  gold: 0xd8b678,
  goldHi: 0xf2dca8,
  goldDeep: 0x9a7038,
  amber: 0xffb45c,
  oxblood: 0x6b2430,
  sage: 0x8fa28c,
  moonlight: 0x9fc3d9,
};

const DEG = Math.PI / 180;

/* ============================================================
 * 1. 小工具：数学 / 缓动 / Canvas
 * ========================================================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

const EASE = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => {
    const c1 = 1.1;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasTexture(canvas, options = {}) {
  const { srgb = true, wrap = false, repeat = null, anisotropy = 4 } = options;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  if (wrap) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (repeat) tex.repeat.set(repeat[0], repeat[1]);
  tex.needsUpdate = true;
  return tex;
}

/** 在 canvas 上居中绘制带字距的文本（Canvas 2D 的 letterSpacing 兼容性一般，手动排） */
function drawSpacedText(ctx, text, cx, y, spacing) {
  const chars = Array.from(text);
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  let total = spacing * (chars.length - 1);
  for (const w of widths) total += w;
  let x = cx - total / 2;
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += widths[i] + spacing;
  }
}

/* ============================================================
 * 2. 程序化贴图
 * ========================================================== */

/** 大理石：深绿底 + 奶油色/香槟金细脉；roughness 由亮度推导，得到抛光感 */
function createMarbleMaps() {
  const S = 1024;
  const c = createCanvas(S, S);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(7);

  ctx.fillStyle = '#0d2419';
  ctx.fillRect(0, 0, S, S);

  // 大块云纹
  for (let i = 0; i < 26; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 90 + rnd() * 380;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (rnd() > 0.45) {
      g.addColorStop(0, 'rgba(40,78,61,0.5)');
      g.addColorStop(0.6, 'rgba(26,55,42,0.22)');
    } else {
      g.addColorStop(0, 'rgba(2,10,7,0.65)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 石脉
  const drawVein = (alpha, width, gold) => {
    let x = rnd() * S;
    let y = rnd() * S;
    let ang = rnd() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 50 + Math.floor(rnd() * 90);
    for (let i = 0; i < steps; i++) {
      ang += (rnd() - 0.5) * 0.6;
      x += Math.cos(ang) * (5 + rnd() * 18);
      y += Math.sin(ang) * (5 + rnd() * 18);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = gold
      ? `rgba(216,182,120,${alpha.toFixed(3)})`
      : `rgba(226,218,198,${alpha.toFixed(3)})`;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.stroke();
  };
  for (let i = 0; i < 24; i++) drawVein(0.05 + rnd() * 0.19, 0.7 + rnd() * 2.6, false);
  for (let i = 0; i < 11; i++) drawVein(0.06 + rnd() * 0.16, 0.6 + rnd() * 1.6, true);

  // 细颗粒
  const img = ctx.getImageData(0, 0, S, S);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rnd() - 0.5) * 9;
    data[i] += n;
    data[i + 1] += n;
    data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  // 由亮度推导 roughness：亮脉略粗糙，暗底更抛光
  const rc = createCanvas(S, S);
  const rctx = rc.getContext('2d');
  const rimg = rctx.createImageData(S, S);
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    const rough = clamp(0.28 + l * 0.3, 0.26, 0.62);
    const v = Math.round(rough * 255);
    rimg.data[i] = v;
    rimg.data[i + 1] = v;
    rimg.data[i + 2] = v;
    rimg.data[i + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  return {
    map: canvasTexture(c, { srgb: true, wrap: true }),
    roughnessMap: canvasTexture(rc, { srgb: false, wrap: true }),
  };
}

/**
 * 奶油挤花：竖向挤花脊 → 法线贴图 + roughness 贴图。
 * 贴图水平方向有 8 个完整脊，材质里按周长设置 repeat 保持实际脊宽一致。
 */
function createFrostingMaps() {
  const S = 1024;
  const heights = new Float32Array(S * S);
  const rnd = mulberry32(21);
  const periods = 8;
  const phase = new Float32Array(periods);
  const amp = new Float32Array(periods);
  for (let i = 0; i < periods; i++) {
    phase[i] = rnd() * Math.PI * 2;
    amp[i] = 0.72 + rnd() * 0.5;
  }

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = (x / S) * periods;
      const idx = Math.floor(u) % periods;
      const f = u - Math.floor(u);
      const ridge = Math.pow(Math.sin(Math.PI * f), 1.35);
      const wobble = 0.5 + 0.5 * Math.sin(v * Math.PI * 6 + phase[idx]);
      const taper = 0.9 + 0.1 * Math.sin(v * Math.PI * 3 + phase[idx] * 0.5);
      heights[y * S + x] =
        ridge * amp[idx] * (0.55 + 0.45 * wobble) * taper +
        Math.sin(v * Math.PI * 2 * 3) * 0.05 +
        (rnd() - 0.5) * 0.025;
    }
  }

  const nc = createCanvas(S, S);
  const nctx = nc.getContext('2d');
  const nimg = nctx.createImageData(S, S);
  // 奶油挤花法线强度
  const strength = 3.1;
  for (let y = 0; y < S; y++) {
    const y0 = (y - 1 + S) % S;
    const y1 = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const x0 = (x - 1 + S) % S;
      const x1 = (x + 1) % S;
      const dx = heights[y * S + x1] - heights[y * S + x0];
      const dy = heights[y1 * S + x] - heights[y0 * S + x];
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * S + x) * 4;
      nimg.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      nimg.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nimg.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nimg.data[o + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const rc = createCanvas(S, S);
  const rctx = rc.getContext('2d');
  const rimg = rctx.createImageData(S, S);
  const rnd2 = mulberry32(33);
  for (let i = 0; i < S * S; i++) {
    const v = clamp(0.5 + (heights[i] - 0.5) * 0.3 + (rnd2() - 0.5) * 0.05, 0.2, 0.85);
    const b = Math.round(v * 255);
    rimg.data[i * 4] = b;
    rimg.data[i * 4 + 1] = b;
    rimg.data[i * 4 + 2] = b;
    rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);

  return {
    normalMap: canvasTexture(nc, { srgb: false, wrap: true }),
    roughnessMap: canvasTexture(rc, { srgb: false, wrap: true }),
  };
}

/** 烛焰：白热芯 + 琥珀外焰，交给 AdditiveBlending / Bloom 继续发光 */
function createFlameTexture() {
  const W = 128;
  const H = 256;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');

  const halo = ctx.createRadialGradient(W / 2, H * 0.62, 6, W / 2, H * 0.62, W * 0.95);
  halo.addColorStop(0, 'rgba(255,196,120,0.9)');
  halo.addColorStop(0.3, 'rgba(255,150,60,0.42)');
  halo.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);

  const body = ctx.createRadialGradient(W / 2, H * 0.62, 4, W / 2, H * 0.62, H * 0.44);
  body.addColorStop(0, 'rgba(255,255,238,1)');
  body.addColorStop(0.22, 'rgba(255,236,182,1)');
  body.addColorStop(0.55, 'rgba(255,176,76,0.9)');
  body.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(W / 2, H * 0.07);
  ctx.bezierCurveTo(W * 0.79, H * 0.4, W * 0.72, H * 0.83, W / 2, H * 0.9);
  ctx.bezierCurveTo(W * 0.28, H * 0.83, W * 0.21, H * 0.4, W / 2, H * 0.07);
  ctx.closePath();
  ctx.fill();

  const core = ctx.createRadialGradient(W / 2, H * 0.68, 2, W / 2, H * 0.68, W * 0.24);
  core.addColorStop(0, 'rgba(255,255,252,1)');
  core.addColorStop(0.55, 'rgba(255,244,206,0.78)');
  core.addColorStop(1, 'rgba(255,224,164,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.ellipse(W / 2, H * 0.68, W * 0.2, H * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();

  return canvasTexture(c, { srgb: true });
}

/** 通用软光斑（壁灯光晕 / 光尘 / bokeh） */
function createGlowTexture(size = 256, falloff = 2.2) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const a = Math.pow(1 - t, falloff);
    g.addColorStop(t, `rgba(255,255,255,${a.toFixed(3)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c, { srgb: true });
}

/** bokeh：中心略暗、边缘更柔，像失焦光点 */
function createBokehTexture(size = 256) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.3)');
  g.addColorStop(0.82, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c, { srgb: true });
}

/** 烛烟：一团横向散开的灰白软雾 */
function createSmokeTexture(size = 256) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const rnd = mulberry32(91);
  for (let i = 0; i < 9; i++) {
    const x = size * (0.3 + rnd() * 0.4);
    const y = size * (0.3 + rnd() * 0.4);
    const r = size * (0.14 + rnd() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(226,232,228,0.26)');
    g.addColorStop(1, 'rgba(226,232,228,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvasTexture(c, { srgb: true });
}

/** 拱窗玻璃：冷月光 + 窗外夜色，弱化剪影避免像风景画 */
function createWindowTexture() {
  const W = 512;
  const H = 1024;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#aec9d9');
  g.addColorStop(0.35, '#8fb2c6');
  g.addColorStop(0.72, '#5c7f92');
  g.addColorStop(1, '#35505c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 月晕
  const moonX = W * 0.56;
  const moonY = H * 0.22;
  const halo = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, W * 0.7);
  halo.addColorStop(0, 'rgba(232,244,250,0.72)');
  halo.addColorStop(0.22, 'rgba(214,234,245,0.28)');
  halo.addColorStop(1, 'rgba(190,220,236,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(246,252,255,0.9)';
  ctx.beginPath();
  ctx.arc(moonX, moonY, 18, 0, Math.PI * 2);
  ctx.fill();

  // 夜间薄雾（水平柔光带，不画具体景物）
  const rnd = mulberry32(17);
  for (let i = 0; i < 7; i++) {
    const y = H * (0.34 + rnd() * 0.5);
    const bandH = 30 + rnd() * 90;
    const bg = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
    bg.addColorStop(0, 'rgba(220,236,245,0)');
    bg.addColorStop(0.5, `rgba(220,236,245,${(0.04 + rnd() * 0.05).toFixed(3)})`);
    bg.addColorStop(1, 'rgba(220,236,245,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, y - bandH, W, bandH * 2);
  }

  // 底部压暗，避免过亮
  const bottom = ctx.createLinearGradient(0, H * 0.68, 0, H);
  bottom.addColorStop(0, 'rgba(12,28,34,0)');
  bottom.addColorStop(1, 'rgba(12,28,34,0.55)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, H * 0.68, W, H * 0.32);

  return canvasTexture(c, { srgb: true });
}

/** 黄铜名牌（桌面叙事细节） */
function createPlaqueTexture() {
  const W = 1024;
  const H = 320;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#d5b079');
  g.addColorStop(0.45, '#b98f52');
  g.addColorStop(1, '#8f6831');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 拉丝纹理
  const rnd = mulberry32(45);
  for (let i = 0; i < 260; i++) {
    const y = rnd() * H;
    ctx.strokeStyle = `rgba(255,240,205,${(0.015 + rnd() * 0.03).toFixed(3)})`;
    ctx.lineWidth = 0.7 + rnd() * 1.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + (rnd() - 0.5) * 3);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(58,40,16,0.75)';
  ctx.lineWidth = 6;
  ctx.strokeRect(22, 22, W - 44, H - 44);
  ctx.strokeStyle = 'rgba(255,238,198,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, W - 72, H - 72);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const drawEngraved = (text, x, y, font, spacing) => {
    ctx.font = font;
    ctx.fillStyle = 'rgba(255,244,214,0.55)';
    drawSpacedText(ctx, text, x, y + 3, spacing);
    ctx.fillStyle = 'rgba(46,32,12,0.92)';
    drawSpacedText(ctx, text, x, y, spacing);
  };

  drawEngraved('JOYEUX ANNIVERSAIRE', W / 2, H * 0.36, '500 44px "Bodoni Moda", Didot, Georgia, serif', 7);
  drawEngraved('· 黄 子 荣 ·', W / 2, H * 0.68, '500 74px "Noto Serif SC", "Songti SC", SimSun, serif', 4);

  return canvasTexture(c, { srgb: true });
}

/** HAPPY BIRTHDAY 黄铜字牌：透明底金字，板子由几何体另建 */
function createSignTexture() {
  const W = 2048;
  const H = 512;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const gold = ctx.createLinearGradient(0, H * 0.18, 0, H * 0.84);
  gold.addColorStop(0, '#fff4d6');
  gold.addColorStop(0.22, '#f2dca8');
  gold.addColorStop(0.55, '#d8b678');
  gold.addColorStop(0.82, '#b98f52');
  gold.addColorStop(1, '#e6cc95');

  ctx.font = '500 168px "Bodoni Moda", Didot, "Playfair Display", Georgia, serif';
  ctx.shadowColor = 'rgba(216,182,120,0.55)';
  ctx.shadowBlur = 34;
  ctx.fillStyle = gold;
  drawSpacedText(ctx, 'HAPPY BIRTHDAY', W / 2, H * 0.48, 26);
  ctx.shadowBlur = 0;

  // 极细的双线，增加「黄铜刻字」的精致度
  ctx.strokeStyle = 'rgba(242,220,168,0.65)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W * 0.16, H * 0.74);
  ctx.lineTo(W * 0.84, H * 0.74);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(242,220,168,0.28)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W * 0.2, H * 0.8);
  ctx.lineTo(W * 0.8, H * 0.8);
  ctx.stroke();

  ctx.font = '400 52px "Bodoni Moda", Didot, Georgia, serif';
  ctx.fillStyle = 'rgba(242,220,168,0.82)';
  drawSpacedText(ctx, 'LA PÂTISSERIE DE MINUIT', W / 2, H * 0.9, 12);

  return canvasTexture(c, { srgb: true });
}

/** 火柴盒标签 */
function createMatchboxTexture() {
  const W = 512;
  const H = 384;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#0b2118';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.5, H * 0.42, 10, W * 0.5, H * 0.42, W * 0.62);
  glow.addColorStop(0, 'rgba(33,72,55,0.85)');
  glow.addColorStop(1, 'rgba(9,26,19,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(216,182,120,0.85)';
  ctx.lineWidth = 5;
  ctx.strokeRect(18, 18, W - 36, H - 36);
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, W - 64, H - 64);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d8b678';
  ctx.font = '500 54px "Bodoni Moda", Didot, Georgia, serif';
  drawSpacedText(ctx, 'ALLUMETTES', W / 2, H * 0.34, 8);
  ctx.fillStyle = 'rgba(242,220,168,0.9)';
  ctx.font = '400 30px "Bodoni Moda", Didot, Georgia, serif';
  drawSpacedText(ctx, 'DE MINUIT', W / 2, H * 0.54, 10);

  // 小火苗图标
  ctx.fillStyle = 'rgba(255,180,92,0.9)';
  ctx.beginPath();
  ctx.moveTo(W / 2, H * 0.68);
  ctx.bezierCurveTo(W / 2 + 26, H * 0.74, W / 2 + 20, H * 0.84, W / 2, H * 0.86);
  ctx.bezierCurveTo(W / 2 - 20, H * 0.84, W / 2 - 26, H * 0.74, W / 2, H * 0.68);
  ctx.fill();

  return canvasTexture(c, { srgb: true });
}

/** 桌面接触阴影（径向渐变，贴地假阴影） */
function createShadowTexture() {
  const S = 256;
  const c = createCanvas(S, S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return canvasTexture(c, { srgb: false });
}

/* ============================================================
 * 3. 程序化几何体
 * ========================================================== */

/** 单层蛋糕：底部平、侧面微微内收、上沿圆角、顶面轻拱（Lathe 保证轮廓顺滑） */
function createTierGeometry(R, h, edge = 0.038) {
  const pts = [];
  const sideTop = R * 0.995;
  pts.push(new THREE.Vector2(0.001, 0));
  pts.push(new THREE.Vector2(R * 0.55, 0));
  pts.push(new THREE.Vector2(R - edge * 0.7, 0.002));
  pts.push(new THREE.Vector2(R - edge * 0.18, 0.012));
  pts.push(new THREE.Vector2(R, edge));
  pts.push(new THREE.Vector2(sideTop, h * 0.34));
  pts.push(new THREE.Vector2(sideTop * 0.998, h * 0.7));
  pts.push(new THREE.Vector2(sideTop, h - edge));
  // 上沿圆角
  const cx = sideTop - edge;
  const cy = h - edge;
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(cx + Math.cos(a) * edge, cy + Math.sin(a) * edge));
  }
  // 顶面轻拱
  pts.push(new THREE.Vector2(R * 0.7, h + edge * 0.5));
  pts.push(new THREE.Vector2(R * 0.36, h + edge * 0.85));
  pts.push(new THREE.Vector2(R * 0.12, h + edge * 1.0));
  pts.push(new THREE.Vector2(0.001, h + edge * 1.02));
  return new THREE.LatheGeometry(pts, 112);
}

/** 挤花奶油卷（单个贝壳形 dollop）：扁一点的旋转体，尖端略收 */
function createDollopGeometry() {
  const pts = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(0.034, 0.001),
    new THREE.Vector2(0.055, 0.008),
    new THREE.Vector2(0.062, 0.02),
    new THREE.Vector2(0.058, 0.034),
    new THREE.Vector2(0.044, 0.046),
    new THREE.Vector2(0.026, 0.056),
    new THREE.Vector2(0.012, 0.064),
    new THREE.Vector2(0.001, 0.07),
  ];
  return new THREE.LatheGeometry(pts, 12);
}

/** 马卡龙外壳（平底 + 圆顶 + 裙边）与夹心 */
function createMacaronGeometries() {
  const shell = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.001, 0),
      new THREE.Vector2(0.036, 0),
      new THREE.Vector2(0.052, 0.003),
      new THREE.Vector2(0.061, 0.009),
      new THREE.Vector2(0.064, 0.016),
      new THREE.Vector2(0.059, 0.024),
      new THREE.Vector2(0.05, 0.032),
      new THREE.Vector2(0.032, 0.039),
      new THREE.Vector2(0.001, 0.042),
    ],
    28
  );
  const filling = new THREE.CylinderGeometry(1, 1, 1, 24);
  return { shell, filling };
}

/** 月牙把手：两个圆求交得到的 lune，用采样点构成 Shape 再挤出 */
function createCrescentGeometry(outerR = 0.17, innerR = 0.155, offset = 0.07, depth = 0.032) {
  const x = (outerR * outerR - innerR * innerR + offset * offset) / (2 * offset);
  const y = Math.sqrt(Math.max(0.0001, outerR * outerR - x * x));
  const aOuter = Math.atan2(y, x);
  const innerCx = offset;
  const shape = new THREE.Shape();
  const steps = 26;
  // 外弧：从上方交点到下方交点，经过 180°
  for (let i = 0; i <= steps; i++) {
    const a = aOuter + (Math.PI * 2 - 2 * aOuter) * (i / steps);
    const px = Math.cos(a) * outerR;
    const py = Math.sin(a) * outerR;
    if (i === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  }
  // 内弧：从下方交点回到上方交点（沿逆时针的反向，经过 180°）
  const aInnerUp = Math.atan2(y, x - innerCx);
  const aInnerLow = Math.PI * 2 - aInnerUp;
  const step2 = 24;
  for (let i = 1; i <= step2; i++) {
    const t = i / step2;
    const a = aInnerLow + (aInnerUp - aInnerLow) * t;
    shape.lineTo(innerCx + Math.cos(a) * innerR, Math.sin(a) * innerR);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** 金箔碎屑：轻微起伏的小面片，双面金属 */
function createGoldFlakeGeometry() {
  const geo = new THREE.PlaneGeometry(0.06, 0.048, 3, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, (Math.random() - 0.5) * 0.014);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 拱形（矩形 + 半圆顶）Shape；用于窗玻璃与窗框 */
function createArchShape(width, height) {
  const halfW = width / 2;
  const spring = height - halfW;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(-halfW, spring);
  shape.absarc(0, spring, halfW, Math.PI, 0, true);
  shape.lineTo(halfW, 0);
  shape.closePath();
  return shape;
}

/** 给 ShapeGeometry 补一套规整 UV（ShapeGeometry 的 uv 默认等于 xy 坐标） */
function normalizeShapeUVs(geometry, width, height) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) + width / 2) / width, pos.getY(i) / height);
  }
  uv.needsUpdate = true;
}

/* ============================================================
 * 4. 自定义 FXAA（EffectComposer 里没有 MSAA，加一个轻量抗锯齿通道）
 * ========================================================== */

const FXAAShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float luma(vec3 rgb) { return dot(rgb, vec3(0.299, 0.587, 0.114)); }

    void main() {
      vec2 inv = 1.0 / uResolution;
      vec3 center = texture2D(tDiffuse, vUv).rgb;
      float lC = luma(center);

      vec3 nw = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * inv).rgb;
      vec3 ne = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * inv).rgb;
      vec3 sw = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * inv).rgb;
      vec3 se = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * inv).rgb;

      float lNW = luma(nw), lNE = luma(ne), lSW = luma(sw), lSE = luma(se);
      float lMin = min(lC, min(min(lNW, lNE), min(lSW, lSE)));
      float lMax = max(lC, max(max(lNW, lNE), max(lSW, lSE)));
      float edge = lMax - lMin;

      if (edge < 0.028) {
        gl_FragColor = vec4(center, 1.0);
        return;
      }

      // 依据亮度梯度决定横向/纵向取样
      float gx = (lNW + lNE) - (lSW + lSE);
      float gy = (lNW + lSW) - (lNE + lSE);
      float dir = abs(gx) >= abs(gy) ? 0.0 : 1.0;
      vec2 stepv = dir > 0.5 ? vec2(0.0, inv.y) : vec2(inv.x, 0.0);

      vec3 a = texture2D(tDiffuse, vUv - stepv * 1.35).rgb;
      vec3 b = texture2D(tDiffuse, vUv - stepv * 0.45).rgb;
      vec3 c = texture2D(tDiffuse, vUv + stepv * 0.45).rgb;
      vec3 d = texture2D(tDiffuse, vUv + stepv * 1.35).rgb;

      float wa = 1.0 / (1.0 + abs(luma(a) - lC) * 22.0);
      float wb = 1.0 / (1.0 + abs(luma(b) - lC) * 22.0);
      float wc = 1.0 / (1.0 + abs(luma(c) - lC) * 22.0);
      float wd = 1.0 / (1.0 + abs(luma(d) - lC) * 22.0);

      vec3 blended = (a * wa + b * wb + c * wc + d * wd) / max(0.0001, wa + wb + wc + wd);
      float strength = clamp(edge * 9.0, 0.0, 0.55);
      gl_FragColor = vec4(mix(center, blended, strength), 1.0);
    }
  `,
};

/* ============================================================
 * 5. 场景主类
 * ========================================================== */

class BirthdayScene {
  constructor(container, canvas, renderer) {
    this.container = container;
    this.canvas = canvas;
    this.renderer = renderer;

    this.disposed = false;
    this.time = 0;
    this.phase = 'intro';
    this.revealed = false;
    this.candlesLit = false;
    this.signUp = false;
    this.reducedMotion =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
    this.quality = 'high';
    this.softwareGL = false;

    // 灯光/材质动画的中间变量
    this.candleGlow = 0;
    this.warmGlow = 0;
    this.dim = 0;
    this._wish = 0;
    this._wishTarget = 0;

    // 动画时间轴
    this._motionScale = this.reducedMotion ? 0.35 : 1;
    this._tasks = [];
    this._seq = null;
    this._seqId = 0;
    this._promises = {};
    this._cinematic = 0;

    // 相机 / 交互
    this._layout = '';
    this._userInteracted = false;
    this._lastInteraction = 0;
    this._camLock = false;

    // 性能统计
    this.fps = 60;
    this.lastInfo = { calls: 0, triangles: 0 };
    this._fpsTime = 0;
    this._fpsFrames = 0;
    this._perfTime = 0;
    this._perfFrames = 0;
    this._qualityChecked = false;

    // 场景内容
    this.flames = [];
    this.smokes = [];
    this.bokeh = [];
    this.clocheMats = [];
    this.macaronGeometries = null;
    this.textures = {};
    this.mats = {};
    this.lights = {};
    this._handlers = {};

    this.width = 1;
    this.height = 1;
    this.dpr = 1;

    // rAF / 事件回调里需要稳定的 this
    this._tick = this._tick.bind(this);
    this._onResize = this._onResize.bind(this);

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initControls();
    this._initLights();
    this._buildEnvironment();
    this._buildRoom();
    this._buildWindow();
    this._buildSconces();
    this._buildTable();
    this._buildTableProps();
    this._buildCakeStand();
    this._buildCake();
    this._buildCandles();
    this._buildCloche();
    this._buildSign();
    this._buildAtmosphere();
    this._initPost();
    this._bindEvents();
    this._applyLayout(true);
    this._syncStateVisuals();
  }

  /* ---------------- 5.1 基础初始化 ---------------- */

  _measure() {
    const el = this.container;
    const w = Math.max(1, Math.floor(el.clientWidth || window.innerWidth || 1));
    const h = Math.max(1, Math.floor(el.clientHeight || window.innerHeight || 1));
    return { w, h };
  }

  _computeDpr() {
    const dpr = window.devicePixelRatio || 1;
    const small = Math.min(window.innerWidth || 1, window.innerHeight || 1) < 820;
    const cap = small ? 1.5 : 1.75;
    return Math.min(dpr, cap);
  }

  _initRenderer() {
    const { w, h } = this._measure();
    this.width = w;
    this.height = h;
    this.dpr = this._computeDpr();

    const renderer = this.renderer;
    renderer.setPixelRatio(this.dpr);
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._baseExposure = 0.98;
    renderer.toneMappingExposure = this._baseExposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false;

    // 软件渲染（SwiftShader / llvmpipe）不做「低帧率自动降级」，避免 QA 截图被降质
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
      this.softwareGL = /swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch (err) {
      this.softwareGL = false;
    }
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.ink);
    this.scene.fog = new THREE.FogExp2(PALETTE.ink, 0.026);
  }

  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(38, this.width / this.height, 0.1, 90);
    this.camera.position.set(3.2, 3.6, 7.2);
  }

  _initControls() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.75;
    controls.minDistance = 7;
    controls.maxDistance = 14;
    controls.minPolarAngle = 55 * DEG;
    controls.maxPolarAngle = 82 * DEG;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.32;
    controls.target.set(0, 1.15, 0);
    this.controls = controls;
  }

  _computePreset(portrait) {
    const aspect = this.width / Math.max(1, this.height);
    if (portrait) {
      // 高窄屏（平板竖屏）比手机需要更近的机位，否则蛋糕太小、墙太空
      if (aspect > 0.56) {
        return {
          fov: 44,
          phi: 70,
          theta: 15,
          radius: 7.6,
          target: [0, 1.36, 0],
          offX: 0,
          offY: 0.042,
          autoSpeed: 0.26,
        };
      }
      return {
        fov: 44,
        phi: 71,
        theta: 15,
        radius: 9.45,
        target: [0, 1.42, 0],
        offX: 0,
        offY: 0.015,
        autoSpeed: 0.26,
      };
    }
    return {
      fov: 38,
      phi: 68,
      theta: 25,
      radius: 7.95,
      target: [0, 1.02, 0],
      offX: -0.115,
      offY: 0.004,
      autoSpeed: 0.32,
    };
  }

  _presetCameraPosition(preset) {
    const phi = preset.phi * DEG;
    const theta = preset.theta * DEG;
    const t = preset.target;
    return new THREE.Vector3(
      t[0] + preset.radius * Math.sin(phi) * Math.sin(theta),
      t[1] + preset.radius * Math.cos(phi),
      t[2] + preset.radius * Math.sin(phi) * Math.cos(theta)
    );
  }

  _applyLayout(initial) {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const portrait = h > w * 1.06;
    const layout = portrait ? 'portrait' : 'landscape';
    const layoutChanged = layout !== this._layout;
    this._layout = layout;
    this.preset = this._computePreset(portrait);

    this.camera.aspect = w / h;
    this.camera.fov = this.preset.fov;
    this.camera.setViewOffset(
      w,
      h,
      this.preset.offX * w,
      this.preset.offY * h,
      w,
      h
    );
    this.camera.updateProjectionMatrix();

    const target = new THREE.Vector3(...this.preset.target);
    this.controls.target.copy(target);
    if (initial || layoutChanged || !this._userInteracted) {
      this.camera.position.copy(this._presetCameraPosition(this.preset));
      this.controls.update();
    }
    if (this.controls.autoRotate) {
      this.controls.autoRotateSpeed = this.preset.autoSpeed;
    }

    // 竖屏：字牌整体缩小、后移，避免横向压过蛋糕和窗
    const signScale = portrait ? 0.65 : 1;
    this._signZ = portrait ? -1.62 : -1.32;
    this._signTargetY = portrait ? 2.3 : 2.44;
    if (this.sign) {
      this.sign.scale.setScalar(signScale);
      this.sign.position.z = this._signZ;
    }
  }

  _setViewOffsetNow() {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    this.camera.setViewOffset(w, h, this.preset.offX * w, this.preset.offY * h, w, h);
    this.camera.updateProjectionMatrix();
  }

  /* ---------------- 5.2 灯光 ---------------- */

  _initLights() {
    const scene = this.scene;

    this.hemi = new THREE.HemisphereLight(PALETTE.moonlight, PALETTE.forestDeep, 0.62);
    this.hemi.position.set(0, 6, 0);
    scene.add(this.hemi);

    // 冷月光（右后上方）——不投影
    const moon = new THREE.DirectionalLight(PALETTE.moonlight, 0.95);
    moon.position.set(4.6, 5.6, -2.4);
    moon.target.position.set(0, 1.0, 0);
    scene.add(moon);
    scene.add(moon.target);

    // 拱窗透进来的冷光斑（SpotLight，无阴影）
    const windowSpot = new THREE.SpotLight(PALETTE.moonlight, 13, 18, 0.62, 0.95, 1.6);
    windowSpot.position.set(1.2, 2.8, -3.0);
    windowSpot.target.position.set(0.2, 0.4, 0.5);
    scene.add(windowSpot);
    scene.add(windowSpot.target);

    // 暖色主光（左上前方）——唯一投影灯
    const key = new THREE.DirectionalLight(0xffdcae, 0);
    key.position.set(-4.2, 5.4, 4.6);
    key.target.position.set(0, 1.05, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -4.0;
    key.shadow.camera.right = 4.0;
    key.shadow.camera.top = 4.4;
    key.shadow.camera.bottom = -2.6;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 18;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.022;
    scene.add(key);
    scene.add(key.target);

    // 两支黄铜壁灯点光
    const sconceL = new THREE.PointLight(PALETTE.amber, 0, 7.0, 2);
    sconceL.position.set(-4.4, 2.03, -2.92);
    scene.add(sconceL);

    const sconceR = new THREE.PointLight(PALETTE.amber, 0, 7.0, 2);
    sconceR.position.set(2.24, 2.11, -2.92);
    scene.add(sconceR);

    // 蜡烛共享点光（最多两盏）
    const candleA = new THREE.PointLight(PALETTE.amber, 0, 3.2, 2);
    candleA.position.set(0, 1.72, 0.03);
    scene.add(candleA);

    const candleB = new THREE.PointLight(PALETTE.amber, 0, 2.4, 2);
    candleB.position.set(0, 1.52, 0.06);
    scene.add(candleB);

    // 主光阴影是静态的（只有蜡烛/壁灯开关），关掉每帧 autoUpdate 省很多
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    this.lights = { hemi: this.hemi, moon, windowSpot, key, sconceL, sconceR, candleA, candleB };
  }

  /* ---------------- 5.3 程序化 PMREM 环境 ---------------- */

  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const disposables = [];

    const roomGeo = new THREE.BoxGeometry(26, 18, 26);
    const roomMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x0a1c14).multiplyScalar(0.85),
      side: THREE.BackSide,
    });
    const room = new THREE.Mesh(roomGeo, roomMat);
    room.position.y = 3.5;
    envScene.add(room);
    disposables.push(roomGeo, roomMat);

    const panel = (color, intensity, w, h, pos, rot) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      envScene.add(mesh);
      disposables.push(geo, mat);
    };

    // 左侧暖色大光面（壁灯一侧）
    panel(0xffb45c, 2.6, 4.2, 3.0, [-7.5, 3.6, 2.5], [0, Math.PI / 2, 0]);
    panel(0xff9a44, 3.4, 1.6, 1.6, [-4.6, 2.7, 5.0], [0, -0.6, 0]);
    // 右侧冷月光窗
    panel(PALETTE.moonlight, 3.2, 3.4, 5.0, [3.5, 3.2, -6.5], [0, 0, 0]);
    // 顶部奶油色柔光
    panel(0xfff4e2, 1.05, 10, 10, [0, 8.5, 0.5], [Math.PI / 2, 0, 0]);
    // 底部暖金反射
    panel(0xd8b678, 0.85, 9, 9, [0, -1.6, 0.5], [-Math.PI / 2, 0, 0]);
    // 细长高光条，让黄铜出现拉丝高光
    panel(0xfff0cd, 4.2, 0.22, 5.0, [-3.2, 4.2, 4.2], [0, Math.PI / 2.4, 0]);
    panel(0xdfeef7, 3.6, 0.18, 4.0, [4.8, 3.6, 2.4], [0, -Math.PI / 2.6, 0]);
    panel(0xf2dca8, 2.2, 3.0, 0.18, [0.5, 5.4, 2.6], [0.35, 0, 0]);

    const rt = pmrem.fromScene(envScene, 0.03);
    this.envRT = rt;
    this.scene.environment = rt.texture;

    for (const d of disposables) d.dispose();
    pmrem.dispose();
  }

  /* ---------------- 5.4 共享材质 ---------------- */

  _initMaterials() {
    const frosting = createFrostingMaps();

    const tierMaterial = (color, repeat) => {
      const nm = frosting.normalMap.clone();
      nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
      nm.repeat.set(repeat, 1);
      nm.needsUpdate = true;
      const rm = frosting.roughnessMap.clone();
      rm.wrapS = rm.wrapT = THREE.RepeatWrapping;
      rm.repeat.set(repeat, 1);
      rm.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 1,
        metalness: 0,
        normalMap: nm,
        normalScale: new THREE.Vector2(1.05, 1.05),
        roughnessMap: rm,
        envMapIntensity: 0.7,
      });
      const texs = [nm, rm];
      this._ownedTextures = this._ownedTextures || [];
      this._ownedTextures.push(...texs);
      return mat;
    };

    this.mats.cream = tierMaterial(0xf4ebda, 9);
    this.mats.sage = tierMaterial(PALETTE.sage, 7);
    this.mats.creamTop = tierMaterial(0xf8f1e4, 5);
    this._frostingMaps = frosting;

    // 挤花 / 蜡烛底座的奶油（不带竖向纹理，纯色高光更干净）
    this.mats.creamPlain = new THREE.MeshStandardMaterial({
      color: PALETTE.cream,
      roughness: 0.58,
      metalness: 0,
      envMapIntensity: 0.75,
    });
    this.mats.sagePlain = new THREE.MeshStandardMaterial({
      color: PALETTE.sage,
      roughness: 0.58,
      metalness: 0,
      envMapIntensity: 0.65,
    });

    this.mats.brass = new THREE.MeshStandardMaterial({
      color: 0xc79a5b,
      metalness: 1,
      roughness: 0.3,
      envMapIntensity: 1.2,
    });
    this.mats.brassBright = new THREE.MeshStandardMaterial({
      color: 0xe3c184,
      metalness: 1,
      roughness: 0.2,
      envMapIntensity: 1.35,
    });
    this.mats.brassDark = new THREE.MeshStandardMaterial({
      color: 0x8a6534,
      metalness: 1,
      roughness: 0.42,
      envMapIntensity: 1.1,
    });
    this.mats.goldLeaf = new THREE.MeshStandardMaterial({
      color: 0xf4d89c,
      metalness: 1,
      roughness: 0.17,
      envMapIntensity: 1.55,
      side: THREE.DoubleSide,
    });
    this.mats.wall = new THREE.MeshStandardMaterial({
      color: 0x174a37,
      roughness: 0.82,
      metalness: 0,
      envMapIntensity: 0.48,
    });
    this.mats.wallDeep = new THREE.MeshStandardMaterial({
      color: 0x0c2b1f,
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 0.32,
    });
    this.mats.wallSoft = new THREE.MeshStandardMaterial({
      color: 0x24604a,
      roughness: 0.78,
      metalness: 0,
      envMapIntensity: 0.52,
    });
    this.mats.sconceGlow = new THREE.MeshStandardMaterial({
      color: PALETTE.amber,
      emissive: PALETTE.amber,
      emissiveIntensity: 0.1,
      roughness: 0.5,
      metalness: 0,
    });
  }

  /* ---------------- 5.5 房间 / 墙面 ---------------- */

  _buildRoom() {
    this._initMaterials();
    const scene = this.scene;

    // 背景墙
    const wall = new THREE.Mesh(new THREE.BoxGeometry(15, 8.4, 0.4), this.mats.wall);
    wall.position.set(0, 3.0, -3.5);
    scene.add(wall);

    // 深色背板，增加墙面前的阅读层次
    const backPanel = new THREE.Mesh(new THREE.BoxGeometry(15, 8.4, 0.3), this.mats.wallDeep);
    backPanel.position.set(0, 3.0, -3.85);
    scene.add(backPanel);

    // 竖向护墙板（InstancedMesh 降低 draw call；给拱窗让出开口）
    const battenGeo = new THREE.BoxGeometry(1, 1, 1);
    const battenXs = [];
    for (let i = 0; i < 33; i++) {
      const x = -6.6 + i * 0.4125;
      if (Math.abs(x - 1.18) < 1.06) continue;
      battenXs.push(x);
    }
    const battens = new THREE.InstancedMesh(battenGeo, this.mats.wallSoft, battenXs.length);
    const dummy = new THREE.Object3D();
    battenXs.forEach((x, i) => {
      dummy.position.set(x, 1.55, -3.24);
      dummy.scale.set(0.035, 2.6, 0.045);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      battens.setMatrixAt(i, dummy.matrix);
    });
    battens.instanceMatrix.needsUpdate = true;
    battens.frustumCulled = false;
    scene.add(battens);

    // 护墙板横线：chair rail + base + 上部压线（chair rail 给拱窗让位，分两段）
    const railMat = this.mats.wallSoft;
    const addRail = (x1, x2, y, z, thicknessScale = 1, depthScale = 1) => {
      const w = x2 - x1;
      const geo = new THREE.BoxGeometry(w, 0.075, 0.085);
      const rail = new THREE.Mesh(geo, railMat);
      rail.position.set((x1 + x2) / 2, y, z);
      rail.scale.set(1, thicknessScale, depthScale);
      scene.add(rail);
    };
    addRail(-6.7, 0.14, 2.88, -3.235);
    addRail(2.22, 6.7, 2.88, -3.235);
    addRail(-6.7, 6.7, 0.24, -3.235, 1.2, 1);
    addRail(-6.7, 6.7, 3.98, -3.24, 0.72, 0.8);

    // 护墙板腰线上的黄铜细线（灯光下会亮起来，给墨绿墙面一点层次）
    const addTrim = (x1, x2, y) => {
      const geo = new THREE.BoxGeometry(x2 - x1, 0.01, 0.012);
      const trim = new THREE.Mesh(geo, this.mats.brassDark);
      trim.position.set((x1 + x2) / 2, y, -3.2);
      scene.add(trim);
    };
    addTrim(-6.7, 0.14, 2.918);
    addTrim(2.22, 6.7, 2.918);
    addTrim(-6.7, 6.7, 0.292);

    // 上部大墙面：浅一些的竖向分缝
    const upperPanelGeo = new THREE.BoxGeometry(13.4, 2.0, 0.035);
    const upperPanel = new THREE.Mesh(upperPanelGeo, this.mats.wall);
    upperPanel.position.set(0, 5.05, -3.27);
    scene.add(upperPanel);

    // 墙脚 / 台面后方的防溅挡板
    const splash = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.42, 0.12), this.mats.wallDeep);
    splash.position.set(0, 0.21, -3.16);
    scene.add(splash);
  }

  /* ---------------- 5.6 拱窗 ---------------- */

  _buildWindow() {
    const scene = this.scene;
    const w = 1.32;
    const h = 2.18;
    const bottom = 0.72;
    const cx = 1.18;
    const z = -3.26;

    // 窗玻璃
    const glassShape = createArchShape(w, h);
    const glassGeo = new THREE.ShapeGeometry(glassShape, 24);
    normalizeShapeUVs(glassGeo, w, h);
    this.textures.window = createWindowTexture();
    const glassMat = new THREE.MeshBasicMaterial({
      map: this.textures.window,
      color: 0xacbcc7,
      side: THREE.DoubleSide,
    });
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.set(cx, bottom, z - 0.01);
    scene.add(glass);

    // 窗后冷月光晕（Bloom 会吃到）
    const glowTex = createGlowTexture(256, 2.4);
    this.textures.glow = glowTex;
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: new THREE.Color(PALETTE.moonlight).multiplyScalar(1.05),
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(cx, bottom + h * 0.55, z + 0.14);
    glow.scale.set(2.0, 2.8, 1);
    glowMat.opacity = 0.16;
    glow.visible = false; // 先关掉验证窗面斜向光带来源（QA 临时）
    scene.add(glow);
    this.lights.windowGlow = glow;

    // 窗框（拱形挤出的环）
    const outer = createArchShape(w + 0.14, h + 0.14);
    const inner = createArchShape(w, h);
    outer.holes.push(inner);
    const frameGeo = new THREE.ExtrudeGeometry(outer, {
      depth: 0.11,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.01,
      bevelSegments: 1,
      curveSegments: 24,
    });
    const frame = new THREE.Mesh(frameGeo, this.mats.brassDark);
    frame.position.set(cx, bottom - 0.02, z - 0.055);
    frame.castShadow = false;
    scene.add(frame);

    // 竖棂 + 横棂
    const mullionMat = this.mats.brassDark;
    const spring = bottom + h - w / 2;
    const vbar = new THREE.Mesh(new THREE.BoxGeometry(0.032, spring - bottom, 0.03), mullionMat);
    vbar.position.set(cx, bottom + (spring - bottom) / 2, z + 0.015);
    scene.add(vbar);

    for (const yy of [bottom + 0.46, bottom + 0.92, bottom + 1.38]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w - 0.03, 0.026, 0.026), mullionMat);
      bar.position.set(cx, yy, z + 0.015);
      scene.add(bar);
    }
    // 拱顶放射棂
    const spokeGeo = new THREE.BoxGeometry(0.026, w / 2 - 0.02, 0.028);
    for (const ang of [-0.62, 0, 0.62]) {
      const spoke = new THREE.Mesh(spokeGeo, mullionMat);
      spoke.position.set(
        cx + Math.sin(ang) * (w / 4),
        bottom + h - w / 2 + Math.cos(ang) * (w / 4),
        z + 0.012
      );
      spoke.rotation.z = -ang;
      scene.add(spoke);
    }

    // 窗台
    const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.34, 0.07, 0.24), this.mats.brassDark);
    sill.position.set(cx, bottom - 0.055, z + 0.06);
    scene.add(sill);

    // 窗光斑：冷月光扫过蛋糕左前方（不要落在空桌面上形成光斑）
    const spot = this.lights.windowSpot;
    spot.position.set(cx, bottom + h * 0.62, z + 0.12);
    spot.target.position.set(cx - 1.15, 0.85, -0.1);
    spot.target.updateMatrixWorld();
  }

  /* ---------------- 5.7 黄铜壁灯 ---------------- */

  _buildSconce(x, y, z) {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // 背板
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.075, 0.03, 24).rotateX(Math.PI / 2),
      this.mats.brass
    );
    plate.position.set(0, 0, 0.02);
    group.add(plate);

    // 弯臂
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0.02),
      new THREE.Vector3(0, 0.02, 0.11),
      new THREE.Vector3(0, 0.1, 0.2),
      new THREE.Vector3(0, 0.24, 0.245),
    ]);
    const arm = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.011, 6, false), this.mats.brass);
    group.add(arm);

    // 灯罩托盘（浅碗）
    const bowl = new THREE.Mesh(
      new THREE.LatheGeometry(
        [
          new THREE.Vector2(0.012, 0.0),
          new THREE.Vector2(0.045, 0.005),
          new THREE.Vector2(0.075, 0.022),
          new THREE.Vector2(0.094, 0.05),
          new THREE.Vector2(0.098, 0.078),
          new THREE.Vector2(0.094, 0.086),
        ],
        32
      ),
      this.mats.brass
    );
    bowl.position.set(0, 0.25, 0.245);
    group.add(bowl);

    // 碗内暖光
    const innerGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.088, 28).rotateX(-Math.PI / 2),
      this.mats.sconceGlow
    );
    innerGlow.position.set(0, 0.345, 0.245);
    group.add(innerGlow);

    // 光晕 sprite
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.textures.glow,
        color: new THREE.Color(PALETTE.amber).multiplyScalar(1.1),
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    halo.position.set(0, 0.35, 0.25);
    halo.scale.set(1.15, 1.15, 1);
    group.add(halo);
    this.bokeh.push({ sprite: halo, base: halo.position.clone(), phase: Math.random() * 6.28, amp: 0.02, speed: 0.7, baseOpacity: 0.34, kind: 'sconce' });

    // 打在墙面上的暖色光斑（让黄铜壁灯与墨绿墙产生关系）
    const wallGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.textures.glow,
        color: new THREE.Color(PALETTE.amber).multiplyScalar(0.9),
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    wallGlow.position.set(0, 0.12, -0.04);
    wallGlow.scale.set(2.1, 2.1, 1);
    group.add(wallGlow);
    this.bokeh.push({ sprite: wallGlow, base: wallGlow.position.clone(), phase: Math.random() * 6.28, amp: 0.01, speed: 0.4, baseOpacity: 0.4, kind: 'sconceWall' });

    this.scene.add(group);
    return group;
  }

  _buildSconces() {
    this._buildSconce(-4.4, 1.72, -3.16);
    this._buildSconce(2.24, 1.8, -3.16);
  }

  /* ---------------- 5.8 大理石台面 ---------------- */

  _buildTable() {
    const { map, roughnessMap } = createMarbleMaps();
    map.repeat.set(2.4, 1.8);
    roughnessMap.repeat.set(2.4, 1.8);
    this.textures.marbleMap = map;
    this.textures.marbleRough = roughnessMap;

    const marbleMat = new THREE.MeshStandardMaterial({
      map,
      roughnessMap,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 1.0,
    });
    this.mats.marble = marbleMat;

    const top = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.5, 4.9), marbleMat);
    top.position.set(0, -0.25, 0.35);
    top.receiveShadow = true;
    this.scene.add(top);

    // 台面前沿黄铜嵌线
    const inlay = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.022, 0.022), this.mats.brassDark);
    inlay.position.set(0, -0.012, 2.792);
    this.scene.add(inlay);

    // 台面下裙板，避免底部空
    const apron = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.9, 0.22), this.mats.wallDeep);
    apron.position.set(0, -0.72, 2.71);
    this.scene.add(apron);

    // 台面后的挡水条
    const backsplash = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.16, 0.1), this.mats.wallSoft);
    backsplash.position.set(0, 0.08, -2.08);
    this.scene.add(backsplash);
  }

  /* ---------------- 5.9 桌面叙事细节：黄铜名牌 / 火柴盒 ---------------- */

  _buildTableProps() {
    // 黄铜名牌
    const plaqueW = 0.9;
    const plaqueH = 0.28;
    this.textures.plaque = createPlaqueTexture();
    const plaqueMat = new THREE.MeshStandardMaterial({
      map: this.textures.plaque,
      roughness: 0.38,
      metalness: 0.85,
      envMapIntensity: 1.2,
      bumpMap: this.textures.plaque,
      bumpScale: 0.004,
    });
    const plaqueBack = new THREE.Mesh(
      new THREE.BoxGeometry(plaqueW + 0.03, 0.018, plaqueH + 0.03),
      this.mats.brassDark
    );
    const plaqueGroup = new THREE.Group();
    plaqueGroup.add(plaqueBack);
    const plaqueFace = new THREE.Mesh(new THREE.PlaneGeometry(plaqueW, plaqueH), plaqueMat);
    plaqueFace.rotation.x = -Math.PI / 2;
    plaqueFace.position.y = 0.0105;
    plaqueGroup.add(plaqueFace);
    plaqueGroup.position.set(-1.48, 0.012, 1.22);
    plaqueGroup.rotation.y = 0.55;
    plaqueGroup.rotation.x = -0.02;
    this.scene.add(plaqueGroup);

    // 火柴盒
    this.textures.matchbox = createMatchboxTexture();
    const boxMat = new THREE.MeshStandardMaterial({
      color: PALETTE.forest,
      roughness: 0.7,
      metalness: 0.05,
      envMapIntensity: 0.4,
    });
    const matchbox = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.315, 0.085, 0.215), boxMat);
    box.castShadow = true;
    matchbox.add(box);
    const labelTop = new THREE.Mesh(
      new THREE.PlaneGeometry(0.285, 0.19),
      new THREE.MeshStandardMaterial({ map: this.textures.matchbox, roughness: 0.62, metalness: 0.1 })
    );
    labelTop.rotation.x = -Math.PI / 2;
    labelTop.position.y = 0.0435;
    matchbox.add(labelTop);
    const labelFront = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.075),
      new THREE.MeshStandardMaterial({ map: this.textures.matchbox, roughness: 0.62, metalness: 0.1 })
    );
    labelFront.position.set(0, 0, 0.1085);
    matchbox.add(labelFront);
    matchbox.position.set(1.52, 0.044, 1.42);
    matchbox.rotation.y = -0.42;
    this.scene.add(matchbox);

    // 散落的火柴
    const stickMat = new THREE.MeshStandardMaterial({ color: 0xd9c7a2, roughness: 0.8 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x7a2a22, roughness: 0.45 });
    const stickGeo = new THREE.CylinderGeometry(0.0038, 0.0034, 0.17, 6).rotateZ(Math.PI / 2);
    const headGeo = new THREE.SphereGeometry(0.0075, 8, 6);
    const spots = [
      [1.26, 0.006, 1.62, 0.5],
      [1.36, 0.006, 1.58, 0.15],
      [1.45, 0.006, 1.7, -0.35],
      [1.18, 0.006, 1.5, 1.1],
    ];
    for (const [x, y, zz, rot] of spots) {
      const g = new THREE.Group();
      const stick = new THREE.Mesh(stickGeo, stickMat);
      g.add(stick);
      const head = new THREE.Mesh(headGeo, headMat);
      head.scale.set(1.5, 1, 1);
      head.position.x = 0.087;
      g.add(head);
      g.position.set(x, y, zz);
      g.rotation.y = rot;
      this.scene.add(g);
    }
  }

  /* ---------------- 5.10 黄铜蛋糕架 ---------------- */

  _buildCakeStand() {
    const pts = [
      new THREE.Vector2(0.001, 0.0),
      new THREE.Vector2(0.16, 0.0),
      new THREE.Vector2(0.5, 0.0),
      new THREE.Vector2(0.6, 0.004),
      new THREE.Vector2(0.635, 0.016),
      new THREE.Vector2(0.64, 0.034),
      new THREE.Vector2(0.615, 0.045),
      new THREE.Vector2(0.34, 0.038),
      new THREE.Vector2(0.14, 0.055),
      new THREE.Vector2(0.075, 0.095),
      new THREE.Vector2(0.055, 0.15),
      new THREE.Vector2(0.06, 0.22),
      new THREE.Vector2(0.085, 0.28),
      new THREE.Vector2(0.15, 0.318),
      new THREE.Vector2(0.45, 0.348),
      new THREE.Vector2(0.82, 0.366),
      new THREE.Vector2(1.0, 0.378),
      new THREE.Vector2(1.055, 0.388),
      new THREE.Vector2(1.045, 0.401),
      new THREE.Vector2(0.95, 0.402),
      new THREE.Vector2(0.5, 0.4),
      new THREE.Vector2(0.001, 0.399),
    ];
    const stand = new THREE.Mesh(new THREE.LatheGeometry(pts, 112), this.mats.brass);
    stand.castShadow = true;
    stand.receiveShadow = true;
    this.scene.add(stand);
    this.cakeStand = stand;

    // 碟沿高光
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.055, 0.011, 8, 96), this.mats.brassBright);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.392;
    this.scene.add(rim);

    const baseRing = new THREE.Mesh(new THREE.TorusGeometry(0.635, 0.008, 6, 80), this.mats.brassBright);
    baseRing.rotation.x = Math.PI / 2;
    baseRing.position.y = 0.032;
    this.scene.add(baseRing);

    // 碟面细金线
    const inlay = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.004, 5, 88), this.mats.brassBright);
    inlay.rotation.x = Math.PI / 2;
    inlay.position.y = 0.4005;
    this.scene.add(inlay);
  }

  /* ---------------- 5.11 三层蛋糕 ---------------- */

  _buildCake() {
    const cake = new THREE.Group();
    cake.position.y = 0.398;
    this.scene.add(cake);
    this.cake = cake;

    const tiers = [
      { R: 0.82, h: 0.36, y: 0, mat: this.mats.cream },
      { R: 0.64, h: 0.31, y: 0.358, mat: this.mats.sage },
      { R: 0.47, h: 0.28, y: 0.666, mat: this.mats.creamTop },
    ];

    this.tiers = [];
    for (const spec of tiers) {
      const geo = createTierGeometry(spec.R, spec.h);
      const mesh = new THREE.Mesh(geo, spec.mat);
      mesh.position.y = spec.y;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      cake.add(mesh);
      this.tiers.push({
        R: spec.R,
        h: spec.h,
        baseY: spec.y,
        topY: spec.y + spec.h,
        mesh,
      });
    }

    this._buildPiping();
    this._buildGoldDecor();
    this._buildMacarons();
    this._buildBerries();
    this._buildRibbon();
  }

  /** 每层上沿 / 下沿一圈挤花奶油卷 */
  _buildPiping() {
    const dollopGeo = createDollopGeometry();
    const mats = [];
    const dummy = new THREE.Object3D();

    const addRing = (radius, y, count, scale = 1, tilt = 0) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.04;
        dummy.position.set(Math.sin(a) * radius, y, Math.cos(a) * radius);
        dummy.rotation.set(tilt + (Math.random() - 0.5) * 0.1, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.12);
        const s = scale * (0.86 + Math.random() * 0.28);
        dummy.scale.set(s, s * (0.9 + Math.random() * 0.25), s);
        dummy.updateMatrix();
        mats.push(dummy.matrix.clone());
      }
    };

    for (const tier of this.tiers) {
      const topCount = Math.max(26, Math.round((Math.PI * 2 * tier.R) / 0.072));
      // 上沿
      addRing(tier.R - 0.045, tier.topY - 0.01, topCount, 0.62);
      // 下沿（贴着下层顶面 / 碟面）
      addRing(tier.R + 0.022, tier.baseY + 0.008, topCount, 0.68);
    }

    const inst = new THREE.InstancedMesh(dollopGeo, this.mats.creamPlain, mats.length);
    for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mats[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    this.cake.add(inst);
  }

  /** 金箔碎屑 + 金色糖珠 */
  _buildGoldDecor() {
    const flakeGeo = createGoldFlakeGeometry();
    const flakeCount = 112;
    const flakes = new THREE.InstancedMesh(flakeGeo, this.mats.goldLeaf, flakeCount);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < flakeCount; i++) {
      const tier = this.tiers[Math.floor(Math.random() * this.tiers.length)];
      const onSide = Math.random() < 0.62;
      if (onSide) {
        const a = Math.random() * Math.PI * 2;
        const y = rand(tier.baseY + 0.05, tier.topY - 0.04);
        dummy.position.set(Math.sin(a) * (tier.R + 0.004), y, Math.cos(a) * (tier.R + 0.004));
        dummy.rotation.set((Math.random() - 0.5) * 0.8, a + Math.PI / 2, (Math.random() - 0.5) * 1.2);
      } else {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * (tier.R - 0.1);
        dummy.position.set(Math.sin(a) * rr, tier.topY + 0.018, Math.cos(a) * rr);
        dummy.rotation.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.6, Math.random() * Math.PI * 2, 0);
      }
      const s = 0.7 + Math.random() * 0.65;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      flakes.setMatrixAt(i, dummy.matrix);
    }
    flakes.instanceMatrix.needsUpdate = true;
    flakes.castShadow = false;
    flakes.frustumCulled = false;
    this.cake.add(flakes);

    // 金色糖珠
    const pearlGeo = new THREE.SphereGeometry(1, 8, 6);
    const pearlCount = 44;
    const pearls = new THREE.InstancedMesh(pearlGeo, this.mats.brassBright, pearlCount);
    for (let i = 0; i < pearlCount; i++) {
      const tier = this.tiers[Math.floor(Math.random() * this.tiers.length)];
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * (tier.R - 0.06);
      dummy.position.set(Math.sin(a) * rr, tier.topY + 0.022, Math.cos(a) * rr);
      dummy.rotation.set(0, 0, 0);
      const s = 0.008 + Math.random() * 0.006;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      pearls.setMatrixAt(i, dummy.matrix);
    }
    pearls.instanceMatrix.needsUpdate = true;
    pearls.castShadow = false;
    pearls.frustumCulled = false;
    this.cake.add(pearls);
  }

  /** 马卡龙：象牙 / 香槟金 / 鼠尾草三种 */
  _buildMacarons() {
    const { shell, filling } = createMacaronGeometries();
    this.macaronGeometries = { shell, filling };

    const colors = [
      { shell: 0xf3e3c8, fill: 0xd8b678 },
      { shell: 0xe4c48c, fill: 0x8a5a3a },
      { shell: PALETTE.sage, fill: 0xf2e6cf },
    ];

    const makeMacaron = (idx, scale = 1) => {
      const c = colors[idx % colors.length];
      const g = new THREE.Group();
      const shellMat = new THREE.MeshStandardMaterial({
        color: c.shell,
        roughness: 0.46,
        metalness: 0,
        envMapIntensity: 0.8,
      });
      const fillMat = new THREE.MeshStandardMaterial({
        color: c.fill,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.5,
      });
      const bottom = new THREE.Mesh(shell, shellMat);
      bottom.rotation.x = Math.PI;
      bottom.position.y = 0.0;
      g.add(bottom);
      const fill = new THREE.Mesh(filling, fillMat);
      fill.scale.set(0.052, 0.014, 0.052);
      fill.position.y = 0.007;
      g.add(fill);
      const top = new THREE.Mesh(shell, shellMat);
      top.position.y = 0.014;
      g.add(top);
      g.scale.setScalar(scale);
      return g;
    };

    // 蛋糕上的马卡龙（相对蛋糕组坐标）
    const cakePlaces = [
      { idx: 0, pos: [-0.26, 0.968, 0.18], rotY: 0.4, scale: 0.95 },
      { idx: 1, pos: [0.27, 0.968, 0.16], rotY: -0.5, scale: 0.9 },
      { idx: 2, pos: [-0.03, 0.968, -0.29], rotY: 1.2, scale: 0.86 },
      { idx: 1, pos: [-0.44, 0.688, 0.36], rotY: 0.2, scale: 1.0 },
      { idx: 0, pos: [0.48, 0.688, 0.2], rotY: -0.9, scale: 0.95 },
    ];
    for (const p of cakePlaces) {
      const m = makeMacaron(p.idx, p.scale);
      m.position.set(p.pos[0], p.pos[1], p.pos[2]);
      m.rotation.y = p.rotY;
      m.castShadow = true;
      this.cake.add(m);
    }

    // 台面上的马卡龙（世界坐标）
    const tablePlaces = [
      { idx: 2, pos: [-1.42, 0.021, 0.86], rotY: 0.6, scale: 1.15 },
      { idx: 1, pos: [-1.26, 0.021, 1.04], rotY: -0.3, scale: 1.05 },
      { idx: 0, pos: [1.48, 0.021, 0.62], rotY: 1.4, scale: 1.1 },
    ];
    for (const p of tablePlaces) {
      const m = makeMacaron(p.idx, p.scale);
      m.position.set(p.pos[0], p.pos[1], p.pos[2]);
      m.rotation.y = p.rotY;
      m.castShadow = true;
      this.scene.add(m);
    }
  }

  /** 深红浆果（带一点点叶子和高光） */
  _buildBerries() {
    const berryMat = new THREE.MeshPhysicalMaterial({
      color: 0x7d2b38,
      roughness: 0.24,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.3,
    });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f4d39, roughness: 0.6, metalness: 0 });
    const berryGeo = new THREE.SphereGeometry(0.043, 16, 12);
    const leafGeo = new THREE.SphereGeometry(1, 8, 6);

    const addCluster = (parent, x, y, z, scale = 1) => {
      const cluster = new THREE.Group();
      cluster.position.set(x, y, z);
      const n = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const b = new THREE.Mesh(berryGeo, berryMat);
        const a = (i / n) * Math.PI * 2 + Math.random();
        b.position.set(Math.cos(a) * 0.035, 0.03 + Math.random() * 0.02, Math.sin(a) * 0.035);
        b.scale.set(0.82 + Math.random() * 0.3, 0.92 + Math.random() * 0.3, 0.82 + Math.random() * 0.3);
        b.castShadow = true;
        cluster.add(b);
      }
      for (let i = 0; i < 2; i++) {
        const leaf = new THREE.Mesh(leafGeo, leafMat);
        leaf.scale.set(0.035, 0.004, 0.018);
        leaf.position.set((Math.random() - 0.5) * 0.08, 0.055, (Math.random() - 0.5) * 0.08);
        leaf.rotation.set(Math.random(), Math.random() * Math.PI, 0.3);
        cluster.add(leaf);
      }
      cluster.scale.setScalar(scale);
      parent.add(cluster);
    };

    addCluster(this.cake, 0.5, 0.69, 0.3, 1.0);
    addCluster(this.cake, -0.34, 0.69, 0.47, 0.95);
    addCluster(this.cake, 0.08, 0.968, -0.3, 0.85);
    addCluster(this.cake, -0.02, 0.382, 0.66, 1.1);
    addCluster(this.scene, -1.0, 0.02, 1.55, 1.2);
  }

  /** 墨绿丝带 + 蝴蝶结 */
  _buildRibbon() {
    const tier = this.tiers[0];
    const bandY = tier.baseY + 0.085;
    const satin = new THREE.MeshPhysicalMaterial({
      color: 0x1d4a37,
      roughness: 0.4,
      metalness: 0.05,
      sheen: 1,
      sheenColor: new THREE.Color(0x7fa68e),
      sheenRoughness: 0.5,
      envMapIntensity: 0.9,
      side: THREE.DoubleSide,
    });
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(tier.R + 0.012, tier.R + 0.012, 0.15, 72, 1, true),
      satin
    );
    band.position.y = bandY;
    band.castShadow = false;
    this.cake.add(band);

    // 蝴蝶结（贴在正面偏左的丝带上）
    const bow = new THREE.Group();
    const angle = 0.42;
    bow.position.set(Math.sin(angle) * (tier.R + 0.02), bandY, Math.cos(angle) * (tier.R + 0.02));
    bow.rotation.y = angle;

    const loopGeo = new THREE.TorusGeometry(0.072, 0.021, 8, 22, Math.PI * 1.35);
    const loopL = new THREE.Mesh(loopGeo, satin);
    loopL.position.set(-0.058, 0.006, 0.014);
    loopL.rotation.z = 2.2;
    bow.add(loopL);
    const loopR = new THREE.Mesh(loopGeo, satin);
    loopR.position.set(0.058, 0.006, 0.014);
    loopR.rotation.z = -2.2;
    bow.add(loopR);
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), satin);
    knot.scale.set(1, 0.85, 0.7);
    knot.position.z = 0.018;
    bow.add(knot);
    const pin = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), this.mats.brassBright);
    pin.position.set(0, 0.002, 0.03);
    bow.add(pin);
    const tailGeo = new THREE.BoxGeometry(0.04, 0.15, 0.008);
    const tailL = new THREE.Mesh(tailGeo, satin);
    tailL.position.set(-0.025, -0.095, 0.01);
    tailL.rotation.z = 0.28;
    bow.add(tailL);
    const tailR = new THREE.Mesh(tailGeo, satin);
    tailR.position.set(0.025, -0.095, 0.01);
    tailR.rotation.z = -0.22;
    bow.add(tailR);

    this.cake.add(bow);
  }

  /* ---------------- 5.12 蜡烛 + 火焰 ---------------- */

  _buildCandles() {
    this.sconceHalos = this.sconceHalos || [];
    const topTier = this.tiers[2];
    const baseY = topTier.topY + 0.024;

    const candleMat = new THREE.MeshStandardMaterial({
      color: 0xf1e6d2,
      roughness: 0.5,
      metalness: 0,
      envMapIntensity: 0.7,
    });
    const wickMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.9 });
    const flameTex = createFlameTexture();
    this.textures.flame = flameTex;
    const smokeTex = createSmokeTexture();
    this.textures.smoke = smokeTex;

    const specs = [
      { x: -0.26, z: 0.1, h: 0.3, seed: 0.31 },
      { x: -0.13, z: 0.165, h: 0.27, seed: 1.73 },
      { x: 0.0, z: 0.19, h: 0.31, seed: 2.97 },
      { x: 0.13, z: 0.165, h: 0.26, seed: 4.11 },
      { x: 0.26, z: 0.1, h: 0.29, seed: 5.53 },
    ];

    const dollopGeo = createDollopGeometry();
    const baseMat = this.mats.creamPlain;

    for (const spec of specs) {
      const group = new THREE.Group();
      group.position.set(spec.x, baseY, spec.z);

      // 蜡烛底座的一小坨奶油
      const dollop = new THREE.Mesh(dollopGeo, baseMat);
      dollop.scale.set(1.7, 0.5, 1.7);
      dollop.position.y = 0.002;
      group.add(dollop);

      const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.023, spec.h, 18, 1), candleMat);
      wax.position.y = spec.h / 2 + 0.004;
      wax.castShadow = true;
      wax.receiveShadow = true;
      group.add(wax);

      const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.0016, 0.028, 5), wickMat);
      wick.position.y = spec.h + 0.014;
      group.add(wick);

      const flameGroup = new THREE.Group();
      flameGroup.position.set(0, spec.h + 0.074, 0);

      const outer = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flameTex,
          color: 0xffe8c6,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      );
      outer.scale.set(0.082, 0.172, 1);
      flameGroup.add(outer);

      const core = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flameTex,
          color: 0xfff4d8,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      );
      core.scale.set(0.038, 0.085, 1);
      core.position.y = -0.01;
      flameGroup.add(core);

      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.textures.glow,
          color: new THREE.Color(PALETTE.amber).multiplyScalar(1.15),
          transparent: true,
          opacity: 0.24,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      );
      halo.scale.set(0.36, 0.36, 1);
      halo.position.y = 0.02;
      flameGroup.add(halo);

      flameGroup.visible = false;
      group.add(flameGroup);
      this.cake.add(group);

      this.flames.push({
        group,
        flameGroup,
        outer,
        core,
        halo,
        x: spec.x,
        z: spec.z,
        flameLocalY: spec.h + 0.074,
        baseFlameY: baseY + spec.h + 0.074,
        candleIndex: this.flames.length,
        seed: spec.seed,
        ext: 1,
        alive: false,
        lean: 0,
        smokeSpawned: true,
      });
    }

    // 预建烛烟 sprite，吹灭时复用
    for (let ci = 0; ci < this.flames.length; ci++) {
      const f = this.flames[ci];
      for (let i = 0; i < 3; i++) {
        const mat = new THREE.SpriteMaterial({
          map: smokeTex,
          color: 0xb9c4bf,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        this.cake.add(sprite);
        this.smokes.push({
          sprite,
          candleIndex: ci,
          active: false,
          t: 0,
          dur: 1.7 + Math.random() * 0.6,
          delay: i * 0.16,
          baseY: f.baseFlameY + i * 0.025,
          baseX: f.x + (Math.random() - 0.5) * 0.02,
          baseZ: f.z + (Math.random() - 0.5) * 0.02,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  /* ---------------- 5.13 玻璃餐盖 ---------------- */

  _buildCloche() {
    const group = new THREE.Group();
    this.scene.add(group);
    this.cloche = group;
    this.clocheMats = [];

    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xcfe2ea,
      metalness: 0,
      roughness: 0.04,
      transparent: true,
      opacity: 0.08,
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const brassMat = this.mats.brass.clone();
    brassMat.color = new THREE.Color(0xd0a865);
    const brassBrightMat = this.mats.brassBright.clone();

    this.clocheMats.push({ mat: glassMat, base: 0.08 });
    this.clocheMats.push({ mat: brassMat, base: 1 });
    this.clocheMats.push({ mat: brassBrightMat, base: 1 });

    const profile = [
      new THREE.Vector2(1.245, 0.02),
      new THREE.Vector2(1.25, 0.09),
      new THREE.Vector2(1.243, 0.3),
      new THREE.Vector2(1.228, 0.55),
      new THREE.Vector2(1.2, 0.85),
      new THREE.Vector2(1.155, 1.14),
      new THREE.Vector2(1.075, 1.4),
      new THREE.Vector2(0.94, 1.62),
      new THREE.Vector2(0.76, 1.8),
      new THREE.Vector2(0.54, 1.93),
      new THREE.Vector2(0.32, 2.0),
      new THREE.Vector2(0.14, 2.03),
      new THREE.Vector2(0.001, 2.037),
    ];
    const dome = new THREE.Mesh(new THREE.LatheGeometry(profile, 112), glassMat);
    dome.castShadow = false;
    group.add(dome);

    // 底部黄铜圈
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.246, 0.032, 10, 112), brassMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.042;
    group.add(ring);

    // 底圈上的细亮边
    const ringHi = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.008, 6, 112), brassBrightMat);
    ringHi.rotation.x = Math.PI / 2;
    ringHi.position.y = 0.072;
    group.add(ringHi);

    // 顶部黄铜颈 + 月牙把手
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.045, 28), brassMat);
    collar.position.y = 2.028;
    group.add(collar);

    const crescent = new THREE.Mesh(createCrescentGeometry(0.17, 0.155, 0.07, 0.026), brassBrightMat);
    crescent.position.set(0, 2.18, 0);
    crescent.rotation.z = -0.22;
    crescent.rotation.y = 0.4;
    crescent.scale.setScalar(1.08);
    group.add(crescent);

    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.05, 18, 14), brassMat);
    finial.position.y = 2.06;
    group.add(finial);

    this._clocheAlpha = 1;
    this._setClocheOpacity(1);
  }

  _setClocheOpacity(alpha) {
    this._clocheAlpha = alpha;
    for (const entry of this.clocheMats) {
      const m = entry.mat;
      m.opacity = entry.base * alpha;
      if (entry.base > 0.9) {
        const shouldBeOpaque = alpha > 0.985;
        if (m.transparent !== !shouldBeOpaque) {
          m.transparent = !shouldBeOpaque;
          m.depthWrite = shouldBeOpaque;
          m.needsUpdate = true;
        }
      }
    }
  }

  /* ---------------- 5.14 HAPPY BIRTHDAY 黄铜字牌 ---------------- */

  _buildSign() {
    const group = new THREE.Group();
    group.position.set(0, 0.2, -1.32);
    group.rotation.y = -0.085;
    group.rotation.x = -0.03;
    group.visible = false; // 未庆祝前完全藏起来，避免边角从蛋糕后露出来
    this.scene.add(group);
    this.sign = group;

    const W = 2.26;
    const H = 0.62;
    const R = 0.05;

    const roundedRect = (w, h, r) => {
      const s = new THREE.Shape();
      const x = -w / 2;
      const y = -h / 2;
      s.moveTo(x + r, y);
      s.lineTo(x + w - r, y);
      s.quadraticCurveTo(x + w, y, x + w, y + r);
      s.lineTo(x + w, y + h - r);
      s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      s.lineTo(x + r, y + h);
      s.quadraticCurveTo(x, y + h, x, y + h - r);
      s.lineTo(x, y + r);
      s.quadraticCurveTo(x, y, x + r, y);
      return s;
    };

    // 深绿珐琅背板
    const boardShape = roundedRect(W, H, R);
    const boardGeo = new THREE.ExtrudeGeometry(boardShape, {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 8,
    });
    const boardMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a1f16,
      roughness: 0.3,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.9,
    });
    const board = new THREE.Mesh(boardGeo, boardMat);
    group.add(board);

    // 黄铜细框
    const frameShape = roundedRect(W + 0.1, H + 0.1, R + 0.02);
    frameShape.holes.push(roundedRect(W - 0.005, H - 0.005, R - 0.005));
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.035,
      bevelEnabled: true,
      bevelThickness: 0.007,
      bevelSize: 0.007,
      bevelSegments: 1,
      curveSegments: 10,
    });
    const frameMat = this.mats.brass.clone();
    frameMat.color = new THREE.Color(0xc79a5b);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.z = 0.028;
    group.add(frame);

    // 金字
    this.textures.sign = createSignTexture();
    const textMat = new THREE.MeshBasicMaterial({
      map: this.textures.sign,
      transparent: true,
      depthWrite: false,
      toneMapped: true,
      color: new THREE.Color(1.15, 1.15, 1.15),
    });
    const text = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.9, H * 0.86), textMat);
    text.position.z = 0.073;
    group.add(text);

    // 字牌背后的柔光（庆祝时淡入，Bloom 会吃到）
    this.signGlowMat = new THREE.SpriteMaterial({
      map: this.textures.glow,
      color: new THREE.Color(PALETTE.goldHi).multiplyScalar(1.2),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const signGlow = new THREE.Sprite(this.signGlowMat);
    signGlow.scale.set(3.1, 1.35, 1);
    signGlow.position.z = 0.02;
    group.add(signGlow);

    // 黄铜短支架（不让细长杆露出来；字牌升起时从蛋糕后出现）
    const stubGeo = new THREE.CylinderGeometry(0.016, 0.016, 0.16, 10);
    for (const x of [-W * 0.34, W * 0.34]) {
      const stub = new THREE.Mesh(stubGeo, this.mats.brassDark);
      stub.position.set(x, -H / 2 - 0.07, -0.01);
      group.add(stub);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), this.mats.brass);
      foot.position.set(x, -H / 2 - 0.15, -0.01);
      group.add(foot);
    }
  }

  /* ---------------- 5.15 氛围：接触阴影 / bokeh / 光尘 ---------------- */

  _buildAtmosphere() {
    // 蛋糕架下的接触阴影
    const shadowTex = createShadowTexture();
    this.textures.shadow = shadowTex;
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        color: 0x000000,
      })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0.02, 0.003, 0.12);
    this.scene.add(shadow);

    // 背景 bokeh
    const bokehTex = createBokehTexture();
    this.textures.bokeh = bokehTex;
    const specs = [
      { color: 0xffb45c, x: -4.6, y: 3.1, z: -3.0, s: 0.26, o: 0.2 },
      { color: 0xf2dca8, x: -3.2, y: 2.0, z: -2.95, s: 0.18, o: 0.14 },
      { color: 0x9fc3d9, x: 2.4, y: 3.7, z: -3.02, s: 0.3, o: 0.14 },
      { color: 0xffd9a0, x: 3.9, y: 2.4, z: -2.9, s: 0.18, o: 0.16 },
      { color: 0xffb45c, x: -1.6, y: 3.9, z: -3.05, s: 0.2, o: 0.12 },
      { color: 0x9fc3d9, x: -2.2, y: 4.3, z: -3.06, s: 0.16, o: 0.12 },
      { color: 0xd8b678, x: 1.4, y: 1.5, z: -2.98, s: 0.1, o: 0.18 },
    ];
    for (const b of specs) {
      const mat = new THREE.SpriteMaterial({
        map: bokehTex,
        color: new THREE.Color(b.color).multiplyScalar(1.5),
        transparent: true,
        opacity: b.o,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(b.x, b.y, b.z);
      sprite.scale.set(b.s, b.s, 1);
      this.scene.add(sprite);
      this.bokeh.push({
        sprite,
        kind: 'ambient',
        base: sprite.position.clone(),
        baseOpacity: b.o,
        phase: Math.random() * Math.PI * 2,
        amp: 0.04 + Math.random() * 0.05,
        speed: 0.25 + Math.random() * 0.3,
      });
    }

    // 3D 光尘
    const count = 200;
    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = rand(-2.5, 2.5);
      positions[i * 3 + 1] = rand(0.35, 2.85);
      positions[i * 3 + 2] = rand(-1.6, 1.75);
      vel[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dustMat = new THREE.PointsMaterial({
      map: this.textures.glow,
      color: new THREE.Color(PALETTE.goldHi).multiplyScalar(1.3),
      size: 0.038,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.frustumCulled = false;
    this.scene.add(dust);
    this.dust = dust;
    this._dustCount = count;
    this._dustVel = vel;
    this._dustTarget = 0.05;
  }

  /* ---------------- 5.16 后处理 ---------------- */

  _initPost() {
    const w = this.width;
    const h = this.height;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    const portrait = this.height > this.width * 1.06;
    const strength = portrait ? 0.33 : 0.38;
    this._baseBloom = strength;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), strength, 0.5, 0.88);
    this.composer.addPass(this.bloomPass);

    this.fxaaPass = new ShaderPass(FXAAShader);
    this.fxaaPass.material.uniforms.uResolution.value.set(w * this.dpr, h * this.dpr);
    this.composer.addPass(this.fxaaPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // 内部像素比可能因降级变化
    this._composerPixelRatio = this.renderer.getPixelRatio();
  }

  _syncStateVisuals() {
    if (this.cloche) this._setClocheOpacity(1);
    if (this.sign) {
      this.sign.position.y = 0.2;
      this.sign.visible = false;
    }
    if (this.signGlowMat) this.signGlowMat.opacity = 0;
    this._dustTarget = this.revealed ? 0.42 : 0.05;
    this.candleGlow = this.candlesLit ? 1 : 0;
    this.warmGlow = this.revealed ? 1 : 0;
  }

  _renderFrame() {
    if (!this.composer) return;
    this.renderer.info.reset();
    this.composer.render();
    const info = this.renderer.info.render;
    this.lastInfo.calls = info.calls;
    this.lastInfo.triangles = info.triangles;
  }

  /* ---------------- 5.17 事件绑定 / resize ---------------- */

  _bindEvents() {
    this._handlers.controlStart = () => {
      this.controls.autoRotate = false;
      this._lastInteraction = performance.now();
      this._userInteracted = true;
    };
    this.controls.addEventListener('start', this._handlers.controlStart);

    this._handlers.resize = () => this._queueResize();
    window.addEventListener('resize', this._handlers.resize);
    if (typeof ResizeObserver === 'function') {
      this._resizeObserver = new ResizeObserver(this._handlers.resize);
      this._resizeObserver.observe(this.container);
    }

    this._handlers.visibility = () => {
      this._lastTime = performance.now();
    };
    document.addEventListener('visibilitychange', this._handlers.visibility);
  }

  _queueResize() {
    if (this._resizeQueued || this.disposed) return;
    this._resizeQueued = true;
    requestAnimationFrame(() => {
      this._resizeQueued = false;
      this._onResize();
    });
  }

  _onResize() {
    if (this.disposed) return;
    const { w, h } = this._measure();
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.dpr = this._computeDpr();

    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.fxaaPass.material.uniforms.uResolution.value.set(w * this.dpr, h * this.dpr);
    this._composerPixelRatio = this.dpr;

    this._applyLayout(false);
    this._setViewOffsetNow();
    if (this._lostShadowAfterDegrade) this.renderer.shadowMap.enabled = false;
  }

  /* ---------------- 5.18 主循环 ---------------- */

  start() {
    if (this.disposed) return;
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch (err) {
      // 个别驱动对 compile 不友好，忽略即可，首帧仍会编译
    }
    this._renderFrame();
    this._lastTime = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick() {
    if (this.disposed) return;
    this._raf = requestAnimationFrame(this._tick);

    const now = performance.now();
    let rawDt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (!(rawDt > 0)) rawDt = 1 / 60;
    // 关键：动画时间轴必须按「真实秒」推进（低 FPS/SwiftShader 下也不能按帧拖慢）。
    // 只做一个防跳变的上限，避免切回标签页时瞬移。
    const simDt = Math.min(rawDt, 0.5);
    this.time += simDt;

    this._updateTasks(simDt);
    this._updateControls(now);
    this._updateLights();
    this._updateFlames();
    this._updateSmoke(simDt);
    this._updateDust(simDt);
    this._updateBokeh();
    this._updateWish(simDt);
    this._updateFps(rawDt);
    this._checkQuality(rawDt);

    if (!document.hidden) this._renderFrame();
  }

  _updateControls(now) {
    const controls = this.controls;
    if (this.reducedMotion || this._camLock) {
      controls.autoRotate = false;
    } else if (this._cinematic === 0 && !controls.autoRotate) {
      if (now - this._lastInteraction > 5000) {
        controls.autoRotateSpeed = this.preset ? this.preset.autoSpeed : 0.32;
        controls.autoRotate = true;
      }
    }
    controls.update();
  }

  _updateLights() {
    const t = this.time;
    const wish = this._wish;
    const flick =
      0.86 +
      0.09 * Math.sin(t * 9.3) +
      0.05 * Math.sin(t * 15.7 + 1.3) +
      0.04 * Math.sin(t * 4.1 + 2.1);

    // 暖光第一次亮起时刷新一次静态阴影贴图
    if (this.warmGlow > 0.02 && !this._shadowWarm) {
      this._shadowWarm = true;
      this.renderer.shadowMap.needsUpdate = true;
    } else if (this.warmGlow < 0.01 && this._shadowWarm) {
      this._shadowWarm = false;
      this.renderer.shadowMap.needsUpdate = true;
    }

    const candleI = 0.78 * this.candleGlow * flick * (1 - this.dim * 0.85);
    this.lights.candleA.intensity = Math.max(0, candleI);
    this.lights.candleB.intensity = Math.max(0, candleI * 0.5);
    this.lights.candleA.position.y = 1.71 + Math.sin(t * 7.7) * 0.006;

    const sconceI = 5.0 * this.warmGlow * (1 - this.dim * 0.5) * (1 - 0.16 * wish);
    this.lights.sconceL.intensity = Math.max(0, sconceI * (0.94 + 0.06 * Math.sin(t * 6.1)));
    this.lights.sconceR.intensity = Math.max(0, sconceI * (0.9 + 0.08 * Math.sin(t * 5.3 + 1.7)));

    const boost = this._celebrateBoost || 0;
    this.lights.key.intensity =
      1.02 * this.warmGlow * (1 + boost * 0.1) * (1 - 0.22 * wish) * (1 - this.dim * 0.6);
    this.lights.windowSpot.intensity = 4.8 * (1 - 0.18 * wish);
    this.lights.hemi.intensity = 0.52 * (1 - 0.22 * wish) + 0.04 * this.candleGlow;

    this.mats.sconceGlow.emissiveIntensity =
      (0.1 + this.warmGlow * 2.2) * (0.94 + 0.06 * Math.sin(t * 6.1));

    for (const b of this.bokeh) {
      if (b.kind === 'sconce') {
        b.sprite.material.opacity = b.baseOpacity * (0.1 + this.warmGlow * 0.9);
      } else if (b.kind === 'sconceWall') {
        b.sprite.material.opacity = b.baseOpacity * this.warmGlow;
      }
    }
  }

  _updateFlames() {
    const t = this.time;
    for (const f of this.flames) {
      const ext = f.ext;
      const k = clamp(1 - ext, 0, 1);
      const visible = f.alive && k > 0.01;
      f.flameGroup.visible = visible;
      if (!visible) continue;
      const n =
        Math.sin(t * 11.4 + f.seed * 7.3) * 0.5 +
        Math.sin(t * 17.9 + f.seed * 3.7) * 0.3 +
        Math.sin(t * 6.3 + f.seed * 11.1) * 0.2;
      f.flameGroup.position.x = Math.sin(t * 2.1 + f.seed) * 0.0035 + f.lean * 0.06;
      f.flameGroup.position.z = Math.cos(t * 1.7 + f.seed) * 0.003;
      f.flameGroup.position.y = f.flameLocalY + 0.06 * f.lean;
      const sx = k * (1 - n * 0.05);
      const sy = k * (1 + n * 0.11);
      f.flameGroup.scale.set(sx, sy, 1);
      f.outer.material.rotation = -f.lean * 0.42 + n * 0.05;
      f.core.material.opacity = k;
      f.outer.material.opacity = clamp(k * 1.1, 0, 1);
      f.halo.material.opacity = 0.28 * k * (0.8 + 0.2 * (n * 0.5 + 0.5));
    }
  }

  _spawnSmoke(flame) {
    const puffs = this.smokes.filter((s) => s.candleIndex === flame.candleIndex);
    for (let i = 0; i < puffs.length; i++) {
      const s = puffs[i];
      s.active = true;
      s.t = -s.delay;
      s.sprite.visible = false;
      s.sprite.material.opacity = 0;
    }
    flame.smokeSpawned = true;
  }

  _clearSmoke() {
    for (const s of this.smokes) {
      s.active = false;
      s.t = 0;
      s.sprite.visible = false;
      s.sprite.material.opacity = 0;
    }
  }

  _updateSmoke(dt) {
    for (const s of this.smokes) {
      if (!s.active) continue;
      s.t += dt * (this.reducedMotion ? 0.55 : 1);
      if (s.t < 0) {
        s.sprite.visible = false;
        continue;
      }
      const prog = s.t / s.dur;
      if (prog >= 1) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      s.sprite.visible = true;
      s.sprite.position.y = s.baseY + prog * 0.6;
      s.sprite.position.x = s.baseX + Math.sin(prog * 2.4 + s.phase) * 0.065 * prog;
      s.sprite.position.z = s.baseZ + Math.cos(prog * 1.8 + s.phase) * 0.055 * prog;
      const sc = 0.1 + prog * 0.4;
      s.sprite.scale.set(sc, sc * 1.25, 1);
      s.sprite.material.rotation = s.phase + prog * 0.6;
      s.sprite.material.opacity =
        0.26 * Math.sin(Math.PI * Math.min(1, prog * 0.9 + 0.06)) * (1 - prog * 0.5);
    }
  }

  _updateDust(dt) {
    if (!this.dust) return;
    const mat = this.dust.material;
    const target = this._dustTarget || 0;
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 2.0);
    mat.size = 0.034 + (this._dustTarget > 0.6 ? 0.014 : 0);

    const pos = this.dust.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this._dustCount; i++) {
      const i3 = i * 3;
      arr[i3 + 1] += dt * (0.015 + this._dustVel[i] * 0.035);
      arr[i3] += Math.sin(this.time * 0.35 + i * 1.7) * dt * 0.008;
      if (arr[i3 + 1] > 2.9) arr[i3 + 1] = 0.35;
    }
    pos.needsUpdate = true;
  }

  _updateBokeh() {
    const t = this.time;
    for (const b of this.bokeh) {
      b.sprite.position.y = b.base.y + Math.sin(t * b.speed + b.phase) * b.amp;
      b.sprite.position.x = b.base.x + Math.cos(t * b.speed * 0.7 + b.phase) * b.amp * 0.6;
      if (b.kind === 'ambient') {
        b.sprite.material.opacity = b.baseOpacity * (0.82 + 0.18 * Math.sin(t * 0.7 + b.phase));
      }
    }
  }

  _updateWish(dt) {
    this._wish += (this._wishTarget - this._wish) * Math.min(1, dt * 2.6);
    const wish = this._wish;
    this.renderer.toneMappingExposure = this._baseExposure - 0.18 * wish;
    if (this.bloomPass) this.bloomPass.strength = this._baseBloom * (1 - 0.28 * wish);
  }

  _updateFps(dt) {
    this._fpsTime += dt;
    this._fpsFrames++;
    if (this._fpsTime >= 0.5) {
      this.fps = this._fpsFrames / this._fpsTime;
      this._fpsTime = 0;
      this._fpsFrames = 0;
    }
  }

  _checkQuality(dt) {
    if (this._qualityChecked) return;
    this._perfTime += dt;
    this._perfFrames++;
    if (this._perfTime < 4) return;
    this._qualityChecked = true;
    const avg = this._perfFrames / this._perfTime;
    if (!this.softwareGL && avg < 40) this._degradeQuality();
  }

  _degradeQuality() {
    if (this.quality === 'low') return;
    this.quality = 'low';
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = false;
    this._lostShadowAfterDegrade = true;
    if (this.lights.key) this.lights.key.castShadow = false;
    this.scene.traverse((obj) => {
      if (!obj.material) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of list) if (m) m.needsUpdate = true;
    });
    this.composer.setPixelRatio(1);
    this.composer.setSize(this.width, this.height);
    this.fxaaPass.material.uniforms.uResolution.value.set(this.width, this.height);
    this._composerPixelRatio = 1;
  }

  /* ---------------- 5.19 时间轴工具 ---------------- */

  _tween(duration, onUpdate, ease = EASE.outCubic, delay = 0) {
    const scale = this._motionScale;
    const d = Math.max(0.001, duration * scale);
    const dly = Math.max(0, delay * scale);
    return new Promise((resolve) => {
      this._tasks.push({ kind: 'tween', t: -dly, d, onUpdate, ease, resolve });
    });
  }

  _wait(seconds) {
    const d = Math.max(0.001, seconds * this._motionScale);
    return new Promise((resolve) => {
      this._tasks.push({ kind: 'wait', t: 0, d, resolve });
    });
  }

  _updateTasks(dt) {
    for (let i = this._tasks.length - 1; i >= 0; i--) {
      const task = this._tasks[i];
      task.t += dt;
      if (task.kind === 'tween') {
        if (task.t < 0) continue;
        const raw = clamp(task.t / task.d, 0, 1);
        task.onUpdate(task.ease(raw), raw);
        if (raw >= 1) {
          this._tasks.splice(i, 1);
          task.resolve();
        }
      } else if (task.t >= task.d) {
        this._tasks.splice(i, 1);
        task.resolve();
      }
    }
  }

  _clearTasks() {
    const tasks = this._tasks;
    this._tasks = [];
    for (const task of tasks) {
      try {
        task.resolve();
      } catch (err) {
        /* noop */
      }
    }
  }

  _newSequence() {
    if (this._seq) {
      this._seq.cancelled = true;
      this._seq = null;
      this._clearTasks();
    }
    const seq = { id: ++this._seqId, cancelled: false };
    this._seq = seq;
    return seq;
  }

  _seqAlive(seq) {
    return !this.disposed && seq && !seq.cancelled;
  }

  _beginCinematic() {
    this._cinematic++;
    this.controls.autoRotate = false;
  }

  _endCinematic() {
    this._cinematic = Math.max(0, this._cinematic - 1);
    this._lastInteraction = performance.now();
    if (this._cinematic === 0) this.controls.autoRotate = false;
  }

  _cinematicDolly(delta, targetDY, duration, ease) {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const dir = startPos.clone().sub(startTarget);
    const dist0 = dir.length();
    dir.normalize();
    return this._tween(
      duration,
      (p) => {
        const d = Math.max(6.4, dist0 + delta * p);
        this.controls.target.set(startTarget.x, startTarget.y + targetDY * p, startTarget.z);
        this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
      },
      ease || EASE.inOutCubic
    );
  }

  /* ---------------- 5.20 生命周期动作 ---------------- */

  reveal() {
    if (this.disposed) return Promise.resolve();
    if (this.revealed) return Promise.resolve();
    if (this._promises.reveal) return this._promises.reveal;
    const seq = this._newSequence();
    this._beginCinematic();
    let p;
    p = this._doReveal(seq)
      .catch((err) => console.error('[scene] reveal failed', err))
      .finally(() => {
        if (this._promises.reveal === p) this._promises.reveal = null;
        this._endCinematic();
      });
    this._promises.reveal = p;
    return p;
  }

  async _doReveal(seq) {
    if (this.revealed) return;
    this.phase = 'reveal';
    this.cloche.visible = true;

    const rise = this._tween(
      2.7,
      (p) => {
        this.cloche.position.y = p * 0.98;
        this.cloche.rotation.y = p * 2.35;
        this.cloche.scale.setScalar(1 + p * 0.05);
      },
      EASE.inOutCubic
    );
    const fade = this._tween(2.0, (p) => this._setClocheOpacity(1 - p), EASE.outCubic, 1.05);
    const n = this.flames.length;
    const candles = this._tween(
      2.2,
      (p) => {
        for (let i = 0; i < n; i++) {
          const local = clamp((p * (n + 1.4) - i) / 1.4, 0, 1);
          const f = this.flames[i];
          if (local > 0 && !f.alive) {
            f.alive = true;
            f.smokeSpawned = false;
          }
          f.ext = 1 - EASE.outCubic(local);
          f.lean = 0;
        }
        this.candleGlow = clamp((p * (n + 1.4) - 0.4) / 2.4, 0, 1);
      },
      EASE.linear,
      0.5
    );
    const warm = this._tween(1.9, (p) => (this.warmGlow = EASE.inOutSine(p)), EASE.linear, 1.0);
    const portrait = this._layout === 'portrait';
    const cam = this._cinematicDolly(portrait ? -0.28 : -0.45, 0.035, 2.6, EASE.inOutCubic);

    await Promise.all([rise, fade, candles, warm, cam]);
    if (!this._seqAlive(seq)) return;

    this.cloche.visible = false;
    this.candleGlow = 1;
    this.warmGlow = 1;
    this.candlesLit = true;
    this.revealed = true;
    this._dustTarget = 0.42;
    this.phase = 'lit';
    bus.emit('scene:revealed');
  }

  blow() {
    if (this.disposed) return Promise.resolve();
    if (!this.candlesLit) return Promise.resolve();
    if (this._promises.blow) return this._promises.blow;
    const seq = this._newSequence();
    this._beginCinematic();
    let p;
    p = this._doBlow(seq)
      .catch((err) => console.error('[scene] blow failed', err))
      .finally(() => {
        if (this._promises.blow === p) this._promises.blow = null;
        this._endCinematic();
      });
    this._promises.blow = p;
    return p;
  }

  async _doBlow(seq) {
    if (!this.candlesLit) return;
    this.phase = 'blowing';

    const n = this.flames.length;
    const cam = this._cinematicDolly(-0.3, 0.02, 1.6, EASE.outCubic);
    const blowTween = this._tween(
      1.9,
      (p) => {
        for (let i = 0; i < n; i++) {
          const local = clamp((p * (n + 1.2) - i) / 1.2, 0, 1);
          const f = this.flames[i];
          if (!f.alive) continue;
          f.ext = EASE.inOutCubic(local);
          f.lean = Math.sin(Math.min(1, local) * Math.PI) * 0.9 + (local > 0 && local < 1 ? 0.25 : 0);
          if (local >= 1) {
            f.alive = false;
            f.ext = 1;
            f.lean = 0;
            if (!f.smokeSpawned) this._spawnSmoke(f);
          }
        }
        this.candleGlow = clamp(1 - EASE.inOutCubic(p) * 1.05, 0, 1);
      },
      EASE.linear
    );
    const dim = this._tween(
      1.5,
      (p) => (this.dim = Math.sin(Math.PI * Math.min(1, p)) * 0.55),
      EASE.linear,
      1.5
    );

    await Promise.all([cam, blowTween, dim]);
    if (!this._seqAlive(seq)) return;

    for (const f of this.flames) {
      f.alive = false;
      f.ext = 1;
      f.lean = 0;
    }
    this.candleGlow = 0;
    this.dim = 0;
    this.candlesLit = false;
    this.phase = 'blowing';
    this._dustTarget = 0.2;
    bus.emit('scene:blown');
  }

  celebrate() {
    if (this.disposed) return Promise.resolve();
    if (this.signUp) return Promise.resolve();
    if (this._promises.celebrate) return this._promises.celebrate;
    const seq = this._newSequence();
    this._beginCinematic();
    let p;
    p = this._doCelebrate(seq)
      .catch((err) => console.error('[scene] celebrate failed', err))
      .finally(() => {
        if (this._promises.celebrate === p) this._promises.celebrate = null;
        this._endCinematic();
      });
    this._promises.celebrate = p;
    return p;
  }

  async _doCelebrate(seq) {
    if (this.signUp) return;
    this.phase = 'celebrate';
    this.sign.visible = true;
    const signFrom = this.sign.position.y;
    const targetY = this._signTargetY || 2.44;
    const portrait = this._layout === 'portrait';

    const signRise = this._tween(
      2.4,
      (p) => {
        this.sign.position.y = lerp(signFrom, targetY, p);
        this.sign.rotation.z = Math.sin(p * Math.PI) * 0.012;
      },
      EASE.outBack
    );
    const boost = this._tween(2.2, (p) => (this._celebrateBoost = EASE.outCubic(p)), EASE.linear);
    const glow = this._tween(2.3, (p) => (this.signGlowMat.opacity = p * 0.2), EASE.outCubic, 0.5);
    const cam = this._cinematicDolly(portrait ? 0.22 : 0.45, portrait ? 0.05 : 0.14, 2.6, EASE.inOutCubic);
    this._dustTarget = 0.8;

    await Promise.all([signRise, boost, glow, cam]);
    if (!this._seqAlive(seq)) return;

    this.sign.position.y = targetY;
    this.signUp = true;
    this.phase = 'celebrate';
    bus.emit('scene:celebrated');
  }

  relight() {
    if (this.disposed) return Promise.resolve();
    if (this.candlesLit && !this.signUp) return Promise.resolve();
    if (this._promises.relight) return this._promises.relight;
    const seq = this._newSequence();
    this._beginCinematic();
    let p;
    p = this._doRelight(seq)
      .catch((err) => console.error('[scene] relight failed', err))
      .finally(() => {
        if (this._promises.relight === p) this._promises.relight = null;
        this._endCinematic();
      });
    this._promises.relight = p;
    return p;
  }

  async _doRelight(seq) {
    const jobs = [];
    if (this.signUp) {
      const from = this.sign.position.y;
      jobs.push(
        this._tween(
          1.1,
          (p) => {
            this.sign.position.y = lerp(from, 0.2, p);
            this.signGlowMat.opacity = (1 - p) * 0.2;
          },
          EASE.inOutCubic
        )
      );
      this.signUp = false;
    }
    if (!this.candlesLit) {
      const n = this.flames.length;
      jobs.push(
        this._tween(
          1.2,
          (p) => {
            for (let i = 0; i < n; i++) {
              const local = clamp((p * (n + 0.8) - i) / 0.8, 0, 1);
              const f = this.flames[i];
              f.alive = local > 0;
              f.ext = 1 - EASE.outCubic(local);
              f.lean = 0;
              f.smokeSpawned = true;
            }
            this.candleGlow = clamp(p * 1.15, 0, 1);
          },
          EASE.linear
        )
      );
    }
    jobs.push(this._tween(1.3, (p) => (this.warmGlow = lerp(this.warmGlow, 1, p)), EASE.linear));

    await Promise.all(jobs);
    if (!this._seqAlive(seq)) return;

    this._celebrateBoost = 0;
    this.sign.position.y = Math.min(this.sign.position.y, 0.2);
    this.sign.visible = false;
    this.candlesLit = true;
    this.candleGlow = 1;
    this.warmGlow = 1;
    this.dim = 0;
    this.phase = 'lit';
    this._dustTarget = 0.42;
    this._clearSmoke();
  }

  reset() {
    if (this.disposed) return Promise.resolve();
    if (this._promises.reset) return this._promises.reset;
    this._newSequence();
    const seq = this._seq;
    this._beginCinematic();
    let p;
    p = this._doReset(seq)
      .catch((err) => console.error('[scene] reset failed', err))
      .finally(() => {
        if (this._promises.reset === p) this._promises.reset = null;
        this._endCinematic();
      });
    this._promises.reset = p;
    return p;
  }

  async _doReset(seq) {
    this.cloche.visible = true;
    const clocheStartY = this.cloche.position.y;
    const clocheStartRot = this.cloche.rotation.y;
    const clocheStartScale = this.cloche.scale.x;
    const alphaStart = this._clocheAlpha;
    const signStartY = this.sign.position.y;
    const glowStart = this.signGlowMat.opacity;
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const targetPos = this._presetCameraPosition(this.preset);
    const targetTarget = new THREE.Vector3(...this.preset.target);
    const warmStart = this.warmGlow;
    const candleStart = this.candleGlow;

    const jobs = [
      this._tween(
        1.7,
        (p) => {
          this.cloche.position.y = lerp(clocheStartY, 0, p);
          this.cloche.rotation.y = lerp(clocheStartRot, 0, p);
          this.cloche.scale.setScalar(lerp(clocheStartScale, 1, p));
          this._setClocheOpacity(lerp(alphaStart, 1, p));
        },
        EASE.inOutCubic
      ),
      this._tween(
        1.1,
        (p) => {
          this.sign.position.y = lerp(signStartY, 0.2, p);
          this.signGlowMat.opacity = lerp(glowStart, 0, p);
        },
        EASE.inOutCubic
      ),
      this._tween(
        1.4,
        (p) => {
          for (const f of this.flames) {
            f.ext = Math.max(f.ext, p);
            if (p >= 1) f.alive = false;
            f.lean = 0;
          }
          this.candleGlow = candleStart * (1 - p);
          this.warmGlow = warmStart * (1 - p);
        },
        EASE.inOutCubic
      ),
      this._tween(
        1.9,
        (p) => {
          this.camera.position.lerpVectors(startPos, targetPos, p);
          this.controls.target.lerpVectors(startTarget, targetTarget, p);
        },
        EASE.inOutCubic
      ),
      this._tween(
        1.2,
        (p) => {
          this.dim = (1 - p) * this.dim;
          this._celebrateBoost = (1 - p) * (this._celebrateBoost || 0);
        },
        EASE.linear
      ),
    ];

    await Promise.all(jobs);
    if (this.disposed) return;

    // 硬归位，保证重复 reset 不漂移
    this.cloche.visible = true;
    this.cloche.position.set(0, 0, 0);
    this.cloche.rotation.set(0, 0, 0);
    this.cloche.scale.setScalar(1);
    this._setClocheOpacity(1);
    this.sign.position.set(0, 0.2, this._signZ || -1.32);
    this.sign.visible = false;
    this.signGlowMat.opacity = 0;
    for (const f of this.flames) {
      f.alive = false;
      f.ext = 1;
      f.lean = 0;
      f.smokeSpawned = false;
    }
    this._clearSmoke();
    this.candleGlow = 0;
    this.warmGlow = 0;
    this.dim = 0;
    this._celebrateBoost = 0;
    this._dustTarget = 0.05;
    this._wishTarget = 0;
    this.candlesLit = false;
    this.signUp = false;
    this.revealed = false;
    this.phase = 'intro';
    this.camera.position.copy(targetPos);
    this.controls.target.copy(targetTarget);
    this.controls.update();
  }

  wishMode(on) {
    if (this.disposed) return;
    this._wishTarget = on ? 1 : 0;
    if (on) {
      this.phase = 'wish';
    } else {
      this.phase = this.signUp ? 'celebrate' : this.candlesLit ? 'lit' : 'intro';
    }
  }

  setReducedMotion(value) {
    this.reducedMotion = !!value;
    this._motionScale = this.reducedMotion ? 0.4 : 1;
    if (this.reducedMotion) this.controls.autoRotate = false;
  }

  debug() {
    return {
      fps: Math.round(this.fps * 10) / 10,
      phase: this.phase,
      calls: this.lastInfo.calls,
      triangles: this.lastInfo.triangles,
      dpr: this.renderer.getPixelRatio(),
    };
  }

  /* ---------------- 5.21 销毁 ---------------- */

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._clearTasks();

    try {
      this.controls.removeEventListener('start', this._handlers.controlStart);
    } catch (err) {
      /* noop */
    }
    window.removeEventListener('resize', this._handlers.resize);
    document.removeEventListener('visibilitychange', this._handlers.visibility);
    if (this._resizeObserver) this._resizeObserver.disconnect();

    try {
      this.controls.dispose();
    } catch (err) {
      /* noop */
    }

    const geos = new Set();
    const mats = new Set();
    const texs = new Set();
    this.scene.traverse((obj) => {
      if (obj.geometry) geos.add(obj.geometry);
      if (!obj.material) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of list) {
        if (!m) continue;
        mats.add(m);
        for (const key of Object.keys(m)) {
          const value = m[key];
          if (value && value.isTexture) texs.add(value);
        }
        if (m.uniforms) {
          for (const uk of Object.keys(m.uniforms)) {
            const val = m.uniforms[uk] && m.uniforms[uk].value;
            if (val && val.isTexture) texs.add(val);
          }
        }
      }
    });

    geos.forEach((g) => {
      try {
        g.dispose();
      } catch (err) {
        /* noop */
      }
    });
    texs.forEach((t) => {
      try {
        t.dispose();
      } catch (err) {
        /* noop */
      }
    });
    mats.forEach((m) => {
      try {
        m.dispose();
      } catch (err) {
        /* noop */
      }
    });

    if (this.envRT) {
      try {
        this.envRT.dispose();
      } catch (err) {
        /* noop */
      }
      this.envRT = null;
    }
    this.scene.environment = null;

    if (this.composer) {
      try {
        if (Array.isArray(this.composer.passes)) {
          for (const pass of this.composer.passes) {
            if (pass && typeof pass.dispose === 'function') pass.dispose();
          }
        }
        this.composer.dispose();
      } catch (err) {
        /* noop */
      }
    }
    try {
      this.renderer.dispose();
    } catch (err) {
      /* noop */
    }
    try {
      if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
    } catch (err) {
      /* noop */
    }

    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);

    if (typeof window !== 'undefined') {
      if (window.__ZR_DEBUG__) delete window.__ZR_DEBUG__;
      if (window.__ZR_SCENE_CAMERA__) delete window.__ZR_SCENE_CAMERA__;
      if (window.__BD_SCENE_HANDLE__) delete window.__BD_SCENE_HANDLE__;
      window.__BD_SCENE_READY__ = false;
    }
  }

  /* ---------------- 5.22 对外 API ---------------- */

  getApi() {
    const app = this;
    const api = {
      reveal: () => app.reveal(),
      blow: () => app.blow(),
      celebrate: () => app.celebrate(),
      wishMode: (on) => app.wishMode(!!on),
      relight: () => app.relight(),
      reset: () => app.reset(),
      setReducedMotion: (v) => app.setReducedMotion(!!v),
      dispose: () => app.dispose(),
      debug: () => app.debug(),
    };
    app._api = api;

    app.cameraDebug = {
      lock() {
        app._camLock = true;
        app.controls.autoRotate = false;
      },
      unlock() {
        app._camLock = false;
      },
      set(px, py, pz, tx, ty, tz) {
        app._camLock = true;
        app.controls.autoRotate = false;
        app.camera.position.set(px, py, pz);
        app.controls.target.set(tx, ty, tz);
        app.controls.update();
      },
      project(x, y, z) {
        const v = new THREE.Vector3(x, y, z).project(app.camera);
        return {
          x: Math.round((v.x * 0.5 + 0.5) * 1000) / 10,
          y: Math.round((-v.y * 0.5 + 0.5) * 1000) / 10,
        };
      },
      get() {
        return {
          position: app.camera.position.toArray(),
          target: app.controls.target.toArray(),
        };
      },
    };

    return api;
  }
}

/* ============================================================
 * 6. 工厂函数
 * ========================================================== */

/**
 * createBirthdayScene — 建 3D 场景并返回 SceneHandle。
 * WebGL 不可用 / 初始化异常时返回 null 并标记 window.__BD_SCENE_FAILED__。
 */
export function createBirthdayScene(container) {
  if (typeof window === 'undefined') return null;
  if (!container || typeof container.appendChild !== 'function') {
    console.warn('[scene] createBirthdayScene: container 无效');
    window.__BD_SCENE_FAILED__ = true;
    return null;
  }

  let canvas = null;
  let renderer = null;
  try {
    canvas = document.createElement('canvas');
    canvas.className = 'zr-scene-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;';
    container.appendChild(canvas);

    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(PALETTE.ink, 1);

    const app = new BirthdayScene(container, canvas, renderer);
    app.start();

    const api = app.getApi();
    window.__BD_SCENE_READY__ = true;
    window.__BD_SCENE_FAILED__ = false;
    window.__BD_SCENE_HANDLE__ = api;
    window.__ZR_DEBUG__ = () => api.debug();
    window.__ZR_SCENE_CAMERA__ = app.cameraDebug;
    bus.emit('scene:ready');
    return api;
  } catch (err) {
    console.error('[scene] 3D 场景初始化失败:', err);
    try {
      if (renderer) renderer.dispose();
    } catch (e) {
      /* noop */
    }
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    window.__BD_SCENE_FAILED__ = true;
    window.__BD_SCENE_READY__ = false;
    return null;
  }
}
