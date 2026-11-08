/**
 * fx.js — Canvas 2D 特效层
 * ---------------------------------------------------------------
 * 契约：export function createFx(canvas: HTMLCanvasElement): FxHandle
 *
 * 全部为程序化绘制，不加载任何外部资源。
 * canvas 由 index.html 提供（#fx，fixed inset:0，pointer-events:none），
 * z-index / 尺寸由 CSS 控制，本模块只负责把像素画好。
 *
 * 视觉气质：深夜法式甜品店，暖金 / 奶油 / 琥珀 / 鼠尾草，少量酒红。
 *   - start()      常驻环境金尘（很淡）
 *   - revealPuff() 掀盖雾气（画面中部偏上，柔白）
 *   - candleSmoke()吹灭后的几缕烛烟
 *   - celebrate()  金箔雨 + 暖金细线烟花 + 星芒，约 6s 后自然回落
 *   - wishBurst()  许愿卡开启时的细小星尘
 *
 * 性能：
 *   - DPR 上限 2；sprite 预渲染；粒子总量有上限
 *   - reduced-motion 时显著减少粒子、取消爆闪、无高频闪烁
 */

const TAU = Math.PI * 2;

/** 唯一允许的配色（与 DESIGN.md 对齐） */
const C = {
  goldHi: '#F2DCA8',
  gold: '#D8B678',
  cream: '#F6EFE3',
  amber: '#FFB45C',
  sage: '#8FA28C',
  oxblood: '#6B2430',
};

/** 金箔以香槟金 / 琥珀为主，避免大片奶油白看起来像纸片 */
const FOIL_BASES = [C.gold, C.goldHi, C.gold, C.amber, C.goldHi];
const STREAK_COLORS = [C.goldHi, C.gold, C.amber, C.goldHi, C.cream];
const DUST_COLORS = [C.goldHi, C.cream, C.gold, C.goldHi];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 两端淡入淡出的包络（0→1→0） */
const envelope = (t) => Math.sin(Math.PI * clamp(t, 0, 1));

// ---------------------------------------------------------------------------
// sprite 预渲染（避免每帧创建渐变）
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function makeSprite(w, h, draw) {
  const cv = makeCanvas(w, h);
  const g = cv.getContext('2d');
  draw(g, w, h);
  return cv;
}

/** 圆形柔光 */
function radialSprite(size, stops) {
  return makeSprite(size, size, (g) => {
    const c = size / 2;
    const grd = g.createRadialGradient(c, c, 0, c, c, c);
    for (const [pos, color] of stops) grd.addColorStop(pos, color);
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  });
}

function buildSprites() {
  const goldGlow = radialSprite(64, [
    [0, 'rgba(255,244,214,0.95)'],
    [0.18, 'rgba(242,220,168,0.55)'],
    [0.55, 'rgba(216,182,120,0.14)'],
    [1, 'rgba(216,182,120,0)'],
  ]);

  const dustSprite = radialSprite(32, [
    [0, 'rgba(255,248,228,1)'],
    [0.22, 'rgba(242,220,168,0.75)'],
    [0.6, 'rgba(216,182,120,0.18)'],
    [1, 'rgba(216,182,120,0)'],
  ]);

  const mistSprite = radialSprite(256, [
    [0, 'rgba(246,239,227,0.5)'],
    [0.3, 'rgba(246,239,227,0.28)'],
    [0.62, 'rgba(242,220,168,0.1)'],
    [1, 'rgba(242,220,168,0)'],
  ]);

  const flashSprite = radialSprite(128, [
    [0, 'rgba(255,246,222,0.9)'],
    [0.3, 'rgba(255,180,92,0.42)'],
    [0.7, 'rgba(216,182,120,0.1)'],
    [1, 'rgba(216,182,120,0)'],
  ]);

  // 星芒：中心光点 + 十字渐细光条
  const starSprite = makeSprite(96, 96, (g, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.26);
    glow.addColorStop(0, 'rgba(255,251,242,0.95)');
    glow.addColorStop(0.45, 'rgba(242,220,168,0.4)');
    glow.addColorStop(1, 'rgba(242,220,168,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    for (const rot of [0, Math.PI / 2]) {
      g.save();
      g.translate(cx, cy);
      g.rotate(rot);
      const grd = g.createLinearGradient(-w / 2, 0, w / 2, 0);
      grd.addColorStop(0, 'rgba(255,251,242,0)');
      grd.addColorStop(0.5, 'rgba(255,251,242,0.92)');
      grd.addColorStop(1, 'rgba(255,251,242,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(-w / 2, 0);
      g.lineTo(0, w * 0.024);
      g.lineTo(w / 2, 0);
      g.lineTo(0, -w * 0.024);
      g.closePath();
      g.fill();
      g.restore();
    }
  });

  // 烛烟：竖向拉长的柔雾，横向用径向遮罩收边
  const wispSprite = makeSprite(64, 256, (g, w, h) => {
    const lin = g.createLinearGradient(0, 0, 0, h);
    lin.addColorStop(0, 'rgba(246,239,227,0)');
    lin.addColorStop(0.22, 'rgba(246,239,227,0.22)');
    lin.addColorStop(0.5, 'rgba(246,239,227,0.4)');
    lin.addColorStop(0.78, 'rgba(232,226,208,0.18)');
    lin.addColorStop(1, 'rgba(232,226,208,0)');
    g.fillStyle = lin;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, h / 2);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(0.35, 'rgba(0,0,0,0.55)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = mask;
    // 横向收窄的椭圆遮罩
    g.save();
    g.translate(w / 2, h / 2);
    g.scale(0.5, 1);
    g.translate(-w / 2, -h / 2);
    g.fillRect(0, 0, w, h);
    g.restore();
  });

  // 金箔：预渲染的小矩形，带暖金高光与两侧暗边（制造厚度感）
  const foilSprites = FOIL_BASES.map((color) =>
    makeSprite(32, 64, (g, w, h) => {
      g.fillStyle = color;
      g.fillRect(0, 0, w, h);
      // 纵向：中段被灯打亮的暖金高光
      const hl = g.createLinearGradient(0, 0, 0, h);
      hl.addColorStop(0, 'rgba(255,240,200,0)');
      hl.addColorStop(0.32, 'rgba(255,240,200,0.22)');
      hl.addColorStop(0.48, 'rgba(255,246,220,0.5)');
      hl.addColorStop(0.62, 'rgba(255,240,200,0.16)');
      hl.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = hl;
      g.fillRect(0, 0, w, h);
      // 横向：暗边 + 一道细亮线，翻转时像金属反光
      const sh = g.createLinearGradient(0, 0, w, 0);
      sh.addColorStop(0, 'rgba(84,52,16,0.42)');
      sh.addColorStop(0.4, 'rgba(84,52,16,0.06)');
      sh.addColorStop(0.56, 'rgba(255,246,220,0.22)');
      sh.addColorStop(0.8, 'rgba(84,52,16,0.18)');
      sh.addColorStop(1, 'rgba(60,36,10,0.4)');
      g.fillStyle = sh;
      g.fillRect(0, 0, w, h);
    })
  );

  return { goldGlow, dustSprite, mistSprite, flashSprite, starSprite, wispSprite, foilSprites };
}

// ---------------------------------------------------------------------------
// createFx
// ---------------------------------------------------------------------------

export function createFx(canvas) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d', { alpha: true }) : null;

  const noopHandle = {
    start() {},
    revealPuff() {},
    candleSmoke() {},
    celebrate() {},
    wishBurst() {},
    reset() {},
    setReducedMotion() {},
    dispose() {},
  };
  if (!ctx) {
    if (typeof window !== 'undefined') {
      window.__ZR_FX_DEBUG__ = () => ({ particles: 0, dust: false, reduced: false, running: false, time: 0 });
    }
    return noopHandle;
  }

  const sprites = buildSprites();

  let W = 0;
  let H = 0;
  let dpr = 1;
  let scale = 1;

  let reduced = false;
  try {
    reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    reduced = false;
  }

  let dustEnabled = false;
  let disposed = false;
  let running = false;
  let rafId = 0;
  let lastNow = 0;
  let time = 0;
  /** 庆祝开始时刻（内部时间），用于 6s 后整体自然回落 */
  let celebrationStart = -1;

  /** @type {Array<object>} 混合类型粒子池 */
  const particles = [];
  /** @type {Array<{t:number, fn:Function}>} 延时 spawn（庆祝编排用） */
  const pending = [];

  // ---- 尺寸 / DPR ---------------------------------------------------------

  function resize() {
    const cw = canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || 1;
    const ch = canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || 1;
    dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    W = Math.max(1, cw);
    H = Math.max(1, ch);
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    scale = clamp(Math.min(W, H) / 900, 0.55, 1.6);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 主场景是「左文字 / 右蛋糕」构图：宽屏特效应从 x≈60% 处发生，
   * 窄屏或竖屏回到 50%（与 Lead 的构图约定同步）。
   */
  function anchorX() {
    const portrait = H > W;
    return W > 820 && !portrait ? W * 0.6 : W * 0.5;
  }

  /** 庆祝开始的整体回落系数：5s 后开始淡出，7.2s 基本消失（不长期遮挡） */
  function celebrateFade() {
    if (celebrationStart < 0) return 1;
    const d = time - celebrationStart;
    if (d <= 5.0) return 1;
    return Math.max(0, 1 - smoothstep(5.0, 7.2, d));
  }

  /**
   * 烟花爆点的安全区：桌面端避开左上品牌、左下主按钮、右上日期/音乐按钮；
   * 窄屏/竖屏避开通栏 HUD，落在画面中上部。
   */
  function burstRect() {
    if (W > 820 && W >= H) {
      return { x0: W * 0.28, x1: W * 0.82, y0: H * 0.08, y1: H * 0.48 };
    }
    return { x0: W * 0.12, x1: W * 0.88, y0: H * 0.32, y1: H * 0.52 };
  }

  function onResize() {
    resize();
    // 让出界的旧粒子自然消失即可，dust 交给 update 的环绕逻辑
  }

  // ---- 粒子工具 -----------------------------------------------------------

  function spawn(p) {
    if (particles.length > 1400) return;
    particles.push(p);
  }

  function after(t, fn) {
    pending.push({ t: time + t, fn });
    pending.sort((a, b) => a.t - b.t);
  }

  function runPending() {
    while (pending.length && pending[0].t <= time) {
      const item = pending.shift();
      try {
        item.fn();
      } catch (_) {
        /* 粒子 spawn 失败不应中断渲染 */
      }
    }
  }

  // ---- 环境金尘 -----------------------------------------------------------

  function dustTargetCount() {
    const base = W < 620 ? 46 : W < 1100 ? 74 : 96;
    return reduced ? Math.max(14, Math.round(base * 0.26)) : base;
  }

  function makeDust(seedRandomY) {
    const z = rand(0.35, 1); // 景深权重
    return {
      type: 'dust',
      x: rand(0, W),
      y: seedRandomY ? rand(0, H) : rand(-H * 0.1, H),
      vx: rand(-7, 7) * z,
      vy: -rand(2.5, 9) * z,
      z,
      size: rand(1.1, 3.2) * z * scale,
      alpha: rand(0.1, 0.4) * z,
      phase: rand(0, TAU),
      tw: rand(0.25, 0.8),
      color: pick(DUST_COLORS),
      sprite: Math.random() < 0.14 ? 'glow' : 'dust',
      age: 0,
      life: Infinity,
    };
  }

  function spawnDust() {
    const target = dustTargetCount();
    let have = 0;
    for (const p of particles) if (p.type === 'dust') have++;
    for (let i = have; i < target; i++) spawn(makeDust(true));
  }

  // ---- 掀盖雾气 -----------------------------------------------------------

  function spawnMistBlob(cx, cy, spread, strength) {
    const a = rand(0, TAU);
    const d = Math.pow(Math.random(), 0.65) * spread;
    spawn({
      type: 'mist',
      x: cx + Math.cos(a) * d * 1.65,
      y: cy + Math.sin(a) * d * 0.55,
      vx: Math.cos(a) * rand(12, 52) * scale,
      vy: -rand(2, 26) * scale,
      r: rand(58, 152) * scale * strength,
      grow: rand(52, 118) * scale,
      aspect: rand(0.55, 1.5),
      rot: rand(-0.5, 0.5),
      rotSpeed: rand(-0.12, 0.12),
      // 大部分用加色做「被灯照亮的雾」，少量普通混合补一点体量；避免灰云感
      blend: Math.random() < 0.86 ? 'add' : 'over',
      alpha: rand(0.014, 0.036),
      life: rand(2.8, 5.2),
      age: 0,
    });
  }

  function revealPuff() {
    if (disposed) return;
    ensureRunning();
    const cx = anchorX();
    const cy = H * 0.36;
    const spread = Math.min(W, H) * 0.085;
    const waves = reduced ? [[0, 8, 1]] : [[0, 16, 1], [0.2, 13, 1.6], [0.5, 12, 2.2]];
    for (const [delay, n, strength] of waves) {
      after(delay, () => {
        for (let i = 0; i < n; i++) spawnMistBlob(cx, cy, spread * strength, strength);
      });
    }
    // 雾气里若隐若现的金尘
    const sparks = reduced ? 4 : 16;
    for (let i = 0; i < sparks; i++) {
      const a = rand(0, TAU);
      const d = rand(0, spread * 2.2);
      spawn({
        type: 'wish',
        x: cx + Math.cos(a) * d * 1.3,
        y: cy + Math.sin(a) * d * 0.6,
        vx: Math.cos(a) * rand(10, 48) * scale,
        vy: -rand(6, 38) * scale,
        size: rand(1.3, 3.2) * scale,
        life: rand(1.5, 2.8),
        age: 0,
        color: pick(DUST_COLORS),
      });
    }
    if (!reduced) {
      spawn({ type: 'flash', x: cx, y: cy, maxR: Math.min(W, H) * 0.22, alpha: 0.07, life: 0.8, age: 0 });
    }
  }

  // ---- 烛烟 ---------------------------------------------------------------

  function candleSmoke() {
    if (disposed) return;
    ensureRunning();
    const n = reduced ? 3 : 8;
    const cx = anchorX();
    const cy = H * 0.48;
    for (let i = 0; i < n; i++) {
      const baseX = cx + rand(-W * 0.045, W * 0.045);
      spawn({
        type: 'wisp',
        x: baseX,
        baseX,
        y: cy + rand(-H * 0.015, H * 0.03),
        vy: -rand(26, 58) * scale,
        rise: 0,
        swayAmp: rand(14, 46) * scale,
        swayFreq: rand(0.55, 1.25),
        swayPhase: rand(0, TAU),
        h: rand(88, 172) * scale,
        w0: rand(7, 17) * scale,
        rot: rand(-0.08, 0.08),
        alpha: rand(0.042, 0.078) * (reduced ? 0.85 : 1),
        life: rand(2.2, 3.6),
        age: 0,
      });
    }
    // 几粒暗红余烬，短促上升
    const embers = reduced ? 0 : 7;
    for (let i = 0; i < embers; i++) {
      spawn({
        type: 'wish',
        x: cx + rand(-W * 0.05, W * 0.05),
        y: cy + rand(-4, 22) * scale,
        vx: rand(-14, 14) * scale,
        vy: -rand(30, 90) * scale,
        size: rand(0.9, 2.0) * scale,
        life: rand(0.6, 1.4),
        age: 0,
        color: Math.random() < 0.6 ? C.amber : C.oxblood,
        tw: rand(2, 4),
      });
    }
  }

  // ---- 金箔 ---------------------------------------------------------------

  function makeFoil(opts = {}) {
    const initial = !!opts.initial;
    const p = {
      type: 'foil',
      x: opts.x != null ? opts.x : rand(-W * 0.06, W * 1.06),
      // 金箔密度集中在上半屏：从画面上部/顶部外落下
      y: opts.y != null ? opts.y : initial ? rand(-H * 0.32, H * 0.42) : rand(-H * 0.2, -8),
      vx: opts.vx != null ? opts.vx : rand(-26, 26) * scale,
      vy: opts.vy != null ? opts.vy : rand(8, 52) * scale,
      w: rand(4.8, 12) * scale,
      l: rand(10, 23) * scale,
      tilt: rand(0, TAU),
      tiltSpeed: rand(1.1, 3.6) * (Math.random() < 0.5 ? -1 : 1),
      roll: rand(0, TAU),
      rollSpeed: rand(-1.3, 1.3),
      sway: rand(8, 28) * scale,
      swayFreq: rand(0.7, 2.1),
      swayPhase: rand(0, TAU),
      alpha: rand(0.55, 0.92),
      sprite: pick(sprites.foilSprites),
      age: initial ? rand(0, 1.7) : 0,
      life: rand(4.4, 7.0),
    };
    return p;
  }

  function spawnFoilWave(n) {
    for (let i = 0; i < n; i++) spawn(makeFoil({ initial: true }));
  }

  // ---- 烟花 ---------------------------------------------------------------

  function spawnStreak(x, y, angle, speed, color, life, width) {
    spawn({
      type: 'streak',
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      life,
      width,
      age: 0,
    });
  }

  function spawnBurst(cx, cy) {
    const density = W < 620 ? 0.72 : 1;
    const n = reduced ? 24 : Math.round(rand(80, 108) * density);
    const baseSpeed = rand(255, 405) * scale * (reduced ? 0.72 : 1);
    const a0 = rand(0, TAU);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU + rand(-0.12, 0.12);
      const sp = baseSpeed * rand(0.48, 1.18);
      // 暖金核心（#FFB45C）+ 香槟金尾（#F2DCA8）
      const color =
        Math.random() < 0.52 ? C.amber : Math.random() < 0.62 ? C.goldHi : Math.random() < 0.7 ? C.gold : C.cream;
      spawnStreak(cx, cy, a, sp, color, rand(1.25, 2.25), rand(0.95, 1.85) * Math.max(0.8, scale));
    }
    // 内芯：更短更快更暖，让爆心亮起来
    const coreN = reduced ? 6 : Math.round(32 * density);
    for (let i = 0; i < coreN; i++) {
      const a = rand(0, TAU);
      spawnStreak(cx, cy, a, baseSpeed * rand(0.18, 0.45), C.amber, rand(0.5, 0.95), rand(0.7, 1.2) * scale);
    }

    // 星芒
    const stars = reduced ? 2 : 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < stars; i++) {
      spawn({
        type: 'star',
        celebrate: true,
        x: cx + rand(-16, 16) * scale,
        y: cy + rand(-16, 16) * scale,
        size: rand(22, 62) * scale,
        rot: rand(0, TAU),
        spin: rand(-0.35, 0.35),
        life: rand(1.1, 2.0),
        age: 0,
      });
    }

    // 金箔从爆心飞出
    if (!reduced) {
      const foils = Math.round(rand(9, 17));
      for (let i = 0; i < foils; i++) {
        const a = rand(0, TAU);
        const sp = rand(40, 170) * scale;
        spawn(
          makeFoil({
            x: cx,
            y: cy,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 30 * scale,
          })
        );
      }
    } else {
      // 降低动效时也留几片，让「庆祝发生过」看得出来
      for (let i = 0; i < 5; i++) {
        const a = rand(0, TAU);
        const sp = rand(30, 90) * scale;
        spawn(makeFoil({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 20 * scale }));
      }
    }

    if (!reduced) {
      spawn({ type: 'flash', celebrate: true, x: cx, y: cy, maxR: Math.min(W, H) * 0.15, alpha: 0.46, life: 0.42, age: 0 });
    }
  }

  function spawnRocket() {
    const rect = burstRect();
    // 升空轨迹也限制在安全区内，避免细线划过品牌字/按钮
    const x0 = rand(rect.x0, rect.x1);
    const tx = clamp(x0 + rand(-W * 0.06, W * 0.06), rect.x0, rect.x1);
    const ty = rand(rect.y0, rect.y1);
    spawn({
      type: 'rocket',
      x: x0,
      y: H + 24,
      x0,
      y0: H + 24,
      tx,
      ty,
      travel: rand(0.5, 0.85),
      age: 0,
      trail: [],
      color: pick(STREAK_COLORS),
    });
  }

  // ---- 庆祝编排 -----------------------------------------------------------

  function celebrate() {
    if (disposed) return;
    ensureRunning();
    celebrationStart = time;
    const density = W < 620 ? 0.75 : 1;

    // 金箔雨：先来一阵大的，再分几波补上，2–3s 内能看清「金雨」
    spawnFoilWave(Math.round((reduced ? 34 : 112) * density));
    if (reduced) {
      after(0.4, () => spawnFoilWave(14));
    } else {
      after(0.4, () => spawnFoilWave(Math.round(34 * density)));
      after(0.95, () => spawnFoilWave(Math.round(30 * density)));
      after(1.5, () => spawnFoilWave(Math.round(26 * density)));
      after(2.05, () => spawnFoilWave(Math.round(22 * density)));
    }

    // 细线烟花：至少 4–6 束错峰升空炸开
    const rocketTimes = reduced ? [0.05, 1.1, 2.1] : [0.02, 0.3, 0.62, 0.96, 1.34, 1.76, 2.2, 2.7];
    for (const t of rocketTimes) after(t, spawnRocket);

    // 全屏零星星芒
    const glints = reduced ? 4 : 16;
    for (let i = 0; i < glints; i++) {
      after(rand(0, 2.8), () => {
        spawn({
          type: 'star',
          celebrate: true,
          x: rand(W * 0.08, W * 0.92),
          y: rand(H * 0.08, H * 0.62),
          size: rand(16, 46) * scale,
          rot: rand(0, TAU),
          spin: rand(-0.2, 0.2),
          life: rand(1.2, 2.2),
          age: 0,
        });
      });
    }

    // 暖金散景（庆祝段的空间感）
    if (!reduced) {
      for (let i = 0; i < 10; i++) {
        after(rand(0, 1.4), () => {
          spawn({
            type: 'bokeh',
            x: rand(0, W),
            y: rand(H * 0.15, H * 0.85),
            r: rand(14, 52) * scale,
            vx: rand(-12, 12) * scale,
            vy: rand(-14, -2) * scale,
            alpha: rand(0.025, 0.06),
            life: rand(2.6, 4.2),
            age: 0,
          });
        });
      }
    }
  }

  // ---- 许愿星尘 -----------------------------------------------------------

  function wishBurst() {
    if (disposed) return;
    ensureRunning();
    const cx = W * 0.5;
    const cy = H * 0.42;
    const n = reduced ? 16 : 56;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(18, 110) * scale;
      spawn({
        type: 'wish',
        x: cx + rand(-W * 0.045, W * 0.045),
        y: cy + rand(-H * 0.035, H * 0.035),
        vx: Math.cos(a) * sp * 0.7,
        vy: Math.sin(a) * sp * 0.35 - rand(10, 55) * scale,
        size: rand(1.3, 3.6) * scale,
        life: rand(1.5, 2.9),
        age: 0,
        color: pick(DUST_COLORS),
        tw: rand(1.5, 4),
      });
    }
    const stars = reduced ? 2 : 5;
    for (let i = 0; i < stars; i++) {
      spawn({
        type: 'star',
        x: cx + rand(-W * 0.12, W * 0.12),
        y: cy + rand(-H * 0.1, H * 0.06),
        size: rand(18, 42) * scale,
        rot: rand(0, TAU),
        spin: rand(-0.25, 0.25),
        life: rand(1.3, 2.2),
        age: 0,
      });
    }
  }

  // ---- 更新 ---------------------------------------------------------------

  function update(dt) {
    // 延时编排
    runPending();

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      let alive = true;

      switch (p.type) {
        case 'dust': {
          p.x += (p.vx + Math.sin(time * 0.32 + p.phase) * 5) * dt;
          p.y += p.vy * dt;
          const m = 24;
          if (p.y < -m) {
            p.y = H + m;
            p.x = rand(0, W);
          } else if (p.y > H + m) {
            p.y = -m;
          }
          if (p.x < -m) p.x = W + m;
          else if (p.x > W + m) p.x = -m;
          break;
        }
        case 'mist': {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= Math.exp(-0.35 * dt);
          p.r += p.grow * dt;
          p.rot += p.rotSpeed * dt;
          alive = p.age < p.life;
          break;
        }
        case 'wisp': {
          p.y += p.vy * dt;
          p.vy *= Math.exp(-0.16 * dt);
          p.swayPhase += p.swayFreq * dt;
          alive = p.age < p.life;
          break;
        }
        case 'foil': {
          p.vy += 58 * scale * dt; // 轻微重力
          p.vx *= Math.exp(-0.4 * dt); // 空气阻力
          p.vy *= Math.exp(-0.16 * dt);
          p.x += (p.vx + Math.sin(time * p.swayFreq + p.swayPhase) * p.sway) * dt;
          p.y += p.vy * dt;
          p.tilt += p.tiltSpeed * dt;
          p.roll += p.rollSpeed * dt;
          alive = p.age < p.life && p.y < H + 60;
          break;
        }
        case 'streak': {
          p.vx *= Math.exp(-1.55 * dt);
          p.vy *= Math.exp(-1.55 * dt);
          p.vy += 48 * scale * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          alive = p.age < p.life;
          break;
        }
        case 'rocket': {
          const t = clamp(p.age / p.travel, 0, 1);
          const e = 1 - Math.pow(1 - t, 3); // ease-out
          p.x = p.x0 + (p.tx - p.x0) * e;
          p.y = p.y0 + (p.ty - p.y0) * e;
          p.trail.push({ x: p.x, y: p.y });
          if (p.trail.length > 5) p.trail.shift();
          if (t >= 1) {
            spawnBurst(p.tx, p.ty);
            alive = false;
          }
          break;
        }
        case 'star': {
          p.rot += p.spin * dt;
          alive = p.age < p.life;
          break;
        }
        case 'wish': {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= Math.exp(-0.7 * dt);
          p.vy *= Math.exp(-0.5 * dt);
          alive = p.age < p.life;
          break;
        }
        case 'flash': {
          alive = p.age < p.life;
          break;
        }
        case 'bokeh': {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          alive = p.age < p.life;
          break;
        }
        default:
          alive = false;
          break;
      }

      if (!alive) {
        // 交换删除，避免数组搬移
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
  }

  // ---- 绘制 ---------------------------------------------------------------

  function drawMist(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * p.alpha;
    if (a <= 0.002) return;
    const w = p.r * 2.2 * (p.aspect || 1);
    const h = p.r * 1.32;
    ctx.globalAlpha = a;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot || 0);
    ctx.drawImage(sprites.mistSprite, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /** 烛烟：由一串沿曲线上升的柔雾点连成，越往上越细越淡 */
  function drawWisp(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * p.alpha * (1 - smoothstep(0.65, 1, t) * 0.55);
    if (a <= 0.002) return;
    const N = 11;
    for (let k = 0; k < N; k++) {
      const f = k / (N - 1); // 0 根部 → 1 顶部
      const yy = p.y - f * p.h * (1 + t * 0.35);
      const sway = Math.sin(p.swayPhase + f * 2.7) * p.swayAmp * (0.3 + f * 1.1);
      const xx = p.baseX + sway;
      const rr = p.w0 * (0.8 + f * 2.4) * (1 + t * 0.6) * 2.2;
      let aa = a * (1 - f * 0.62) * (0.6 + 0.4 * Math.sin(f * 5.2 + p.swayPhase * 0.6));
      if (aa <= 0.002) continue;
      ctx.globalAlpha = aa;
      ctx.save();
      ctx.translate(xx, yy);
      ctx.rotate(p.rot + Math.sin(p.swayPhase + f * 2.2) * 0.22);
      ctx.drawImage(sprites.mistSprite, -rr, -rr, rr * 2, rr * 1.25);
      ctx.restore();
    }
  }

  function drawFoil(p) {
    const cf = celebrateFade();
    if (cf <= 0.02) return;
    const t = p.age / p.life;
    const env = smoothstep(0, 0.1, t) * (1 - smoothstep(0.72, 1, t));
    if (env <= 0.004) return;
    const ac = Math.abs(Math.cos(p.tilt));
    const ws = Math.max(0.12, ac);
    const bright = 0.5 + 0.5 * ac;
    ctx.globalAlpha = clamp(p.alpha * env * (0.42 + 0.58 * bright) * cf, 0, 1);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.roll);
    ctx.scale(ws, 1);
    ctx.drawImage(p.sprite, -p.w / 2, -p.l / 2, p.w, p.l);
    ctx.restore();
    // 正面朝光时给一颗小闪光，金箔的「翻转高光」
    if (ac > 0.86 && env > 0.18) {
      ctx.globalCompositeOperation = 'lighter';
      const g = 13 * scale * (0.6 + ac);
      ctx.globalAlpha = env * 0.3 * cf;
      ctx.drawImage(sprites.goldGlow, p.x - g / 2, p.y - g / 2, g, g);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawStreak(p) {
    const cf = celebrateFade();
    if (cf <= 0.02) return;
    const t = clamp(p.age / p.life, 0, 1);
    const fade = Math.pow(1 - t, 1.4) * cf;
    if (fade <= 0.01) return;
    const speed = Math.hypot(p.vx, p.vy);
    ctx.strokeStyle = p.color;
    const tail = clamp(speed * 0.12, 6, 64);
    let nx = 0;
    let ny = 0;
    if (speed > 1) {
      nx = p.vx / speed;
      ny = p.vy / speed;
    }
    ctx.globalAlpha = fade * 0.95;
    ctx.lineWidth = Math.max(0.55, p.width * (0.35 + 0.65 * fade));
    ctx.beginPath();
    ctx.moveTo(p.x - nx * tail, p.y - ny * tail);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (speed > 1) {
      // 头部用最亮的香槟金再叠一小段，形成「暖金核心 + 亮尾」
      ctx.strokeStyle = C.goldHi;
      ctx.globalAlpha = fade * 0.75;
      ctx.lineWidth = Math.max(0.45, p.width * 0.62);
      ctx.beginPath();
      ctx.moveTo(p.x - nx * tail * 0.34, p.y - ny * tail * 0.34);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = fade * 0.55;
      const g = 11 * scale;
      ctx.drawImage(sprites.goldGlow, p.x - g / 2, p.y - g / 2, g, g);
    }
  }

  function drawRocket(p) {
    const cf = celebrateFade();
    if (cf <= 0.02) return;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.1 * Math.max(0.8, scale);
    const trail = p.trail;
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const dx = trail[i].x - trail[i - 1].x;
        const dy = trail[i].y - trail[i - 1].y;
        // 低帧率下 dt 变大，单段会拉成长长的「划痕」；超过阈值就不画
        if (Math.hypot(dx, dy) > 30 * scale) continue;
        const t = i / trail.length;
        ctx.globalAlpha = 0.28 * t * cf;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.9 * cf;
    const g = 10 * scale;
    ctx.drawImage(sprites.goldGlow, p.x - g / 2, p.y - g / 2, g, g);
  }

  function drawStar(p) {
    const cf = p.celebrate ? celebrateFade() : 1;
    if (cf <= 0.02) return;
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * cf;
    if (a <= 0.01) return;
    const s = p.size * (0.7 + 0.35 * Math.sin(Math.PI * t));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = a * 0.9;
    ctx.drawImage(sprites.starSprite, -s / 2, -s / 2, s, s);
    ctx.restore();
  }

  function drawWish(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * (0.55 + 0.45 * Math.sin(time * (p.tw || 2) + p.x));
    if (a <= 0.01) return;
    const s = p.size * 5.5;
    ctx.globalAlpha = clamp(a, 0, 1) * 0.7;
    ctx.drawImage(sprites.goldGlow, p.x - s / 2, p.y - s / 2, s, s);
  }

  function drawFlash(p) {
    const cf = p.celebrate ? celebrateFade() : 1;
    if (cf <= 0.02) return;
    const t = clamp(p.age / p.life, 0, 1);
    const a = Math.pow(1 - t, 2) * p.alpha * cf;
    if (a <= 0.008) return;
    const r = p.maxR * (0.5 + 1.4 * (1 - Math.pow(1 - t, 3)));
    ctx.globalAlpha = a;
    ctx.drawImage(sprites.flashSprite, p.x - r, p.y - r, r * 2, r * 2);
  }

  function drawBokeh(p) {
    const cf = celebrateFade();
    if (cf <= 0.02) return;
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * p.alpha * cf;
    if (a <= 0.004) return;
    ctx.globalAlpha = a;
    ctx.drawImage(sprites.mistSprite, p.x - p.r, p.y - p.r * 0.9, p.r * 2, p.r * 1.8);
  }

  function drawDust(p) {
    const tw = 0.55 + 0.45 * Math.sin(time * p.tw + p.phase);
    const a = p.alpha * tw;
    if (a <= 0.005) return;
    const s = p.size * (p.sprite === 'glow' ? 9 : 6);
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.drawImage(p.sprite === 'glow' ? sprites.goldGlow : sprites.dustSprite, p.x - s / 2, p.y - s / 2, s, s);
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 1) 加色层：被灯照亮的雾 / 散景 / 爆闪（最底）
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'mist') {
        if (p.blend !== 'over') drawMist(p);
      } else if (p.type === 'bokeh') {
        drawBokeh(p);
      } else if (p.type === 'flash') {
        drawFlash(p);
      }
    }

    // 2) 普通混合的雾体：柔白、很淡，不要灰云
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'mist' && p.blend === 'over') drawMist(p);
    }

    // 3) 烛烟：加色，像被暖灯照亮的烟；再叠金箔
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'wisp') drawWisp(p);
    }

    // 4) 金箔（实体片，翻转高光来自 sprite）
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'foil') drawFoil(p);
    }

    // 5) 加色层：金尘 / 烟花 / 星芒 / 愿望尘
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      switch (p.type) {
        case 'dust':
          drawDust(p);
          break;
        case 'streak':
          drawStreak(p);
          break;
        case 'rocket':
          drawRocket(p);
          break;
        case 'star':
          drawStar(p);
          break;
        case 'wish':
          drawWish(p);
          break;
        default:
          break;
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ---- 主循环 -------------------------------------------------------------

  function frame(now) {
    if (disposed) return;
    if (!running) return;
    if (!lastNow) lastNow = now;
    let dt = (now - lastNow) / 1000;
    lastNow = now;
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.05) dt = 0.05; // 后台/卡顿后不追帧
    time += dt;
    update(dt);
    render();

    // 空闲时停掉 rAF（intro 阶段不空转）
    if (!dustEnabled && particles.length === 0 && pending.length === 0) {
      running = false;
      rafId = 0;
      lastNow = 0;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function ensureRunning() {
    if (disposed) return;
    if (running && rafId) return;
    running = true;
    lastNow = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopRunning() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    running = false;
    lastNow = 0;
  }

  // ---- 公共接口 -----------------------------------------------------------

  function start() {
    if (disposed) return;
    dustEnabled = true;
    spawnDust();
    ensureRunning();
  }

  function reset() {
    if (disposed) return;
    particles.length = 0;
    pending.length = 0;
    dustEnabled = false;
    celebrationStart = -1;
    stopRunning();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
  }

  function setReducedMotion(v) {
    reduced = !!v;
    if (!reduced) return;
    // 开关切换时削减现有粒子，并取消尚未触发的编排
    pending.length = 0;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      let keep = true;
      if (p.type === 'dust') keep = Math.random() < 0.3;
      else if (p.type === 'foil') keep = Math.random() < 0.45;
      else if (p.type === 'streak') keep = Math.random() < 0.3;
      else if (p.type === 'flash') keep = false;
      else keep = Math.random() < 0.75;
      if (!keep) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
    if (dustEnabled) spawnDust();
  }

  function dispose() {
    disposed = true;
    stopRunning();
    particles.length = 0;
    pending.length = 0;
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
  }

  // ---- 初始化 -------------------------------------------------------------

  resize();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    window.__ZR_FX_DEBUG__ = () => ({
      particles: particles.length,
      pending: pending.length,
      dust: dustEnabled,
      reduced,
      running,
      time: +time.toFixed(2),
    });
  }

  return {
    start,
    revealPuff,
    candleSmoke,
    celebrate,
    wishBurst,
    reset,
    setReducedMotion,
    dispose,
  };
}
