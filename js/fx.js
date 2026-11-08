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
      r: rand(38, 108) * scale * strength,
      grow: rand(34, 88) * scale,
      aspect: rand(0.55, 1.5),
      rot: rand(-0.5, 0.5),
      rotSpeed: rand(-0.12, 0.12),
      // 大部分用普通混合做「雾体」，少量用加色做「被灯照亮的边」
      blend: Math.random() < 0.62 ? 'over' : 'add',
      alpha: rand(0.028, 0.075),
      life: rand(2.6, 4.8),
      age: 0,
    });
  }

  function revealPuff() {
    if (disposed) return;
    ensureRunning();
    const cx = W * 0.5;
    const cy = H * 0.36;
    const spread = Math.min(W, H) * 0.07;
    const waves = reduced ? [[0, 8, 1]] : [[0, 17, 1], [0.2, 13, 1.45], [0.48, 11, 1.9]];
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
      spawn({ type: 'flash', x: cx, y: cy, maxR: Math.min(W, H) * 0.2, alpha: 0.1, life: 0.7, age: 0 });
    }
  }

  // ---- 烛烟 ---------------------------------------------------------------

  function candleSmoke() {
    if (disposed) return;
    ensureRunning();
    const n = reduced ? 3 : 8;
    const cx = W * 0.5;
    const cy = H * 0.5;
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
        h: rand(70, 150) * scale,
        w0: rand(8, 19) * scale,
        rot: rand(-0.08, 0.08),
        alpha: rand(0.032, 0.062) * (reduced ? 0.85 : 1),
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
    const fromBurst = !!opts.fromBurst;
    const p = {
      type: 'foil',
      x: opts.x != null ? opts.x : rand(-W * 0.06, W * 1.06),
      y: opts.y != null ? opts.y : initial ? rand(-H * 0.3, H * 0.55) : rand(-H * 0.22, -8),
      vx: opts.vx != null ? opts.vx : rand(-28, 28) * scale,
      vy: opts.vy != null ? opts.vy : rand(8, 58) * scale,
      w: rand(3.2, 8.4) * scale,
      l: rand(7, 17) * scale,
      tilt: rand(0, TAU),
      tiltSpeed: rand(1.1, 3.6) * (Math.random() < 0.5 ? -1 : 1),
      roll: rand(0, TAU),
      rollSpeed: rand(-1.3, 1.3),
      sway: rand(8, 28) * scale,
      swayFreq: rand(0.7, 2.1),
      swayPhase: rand(0, TAU),
      alpha: rand(0.62, 0.98),
      sprite: pick(sprites.foilSprites),
      age: initial ? rand(0, 1.6) : 0,
      life: rand(4.2, 7.0),
      fromBurst,
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
    const n = reduced ? 20 : Math.round(rand(48, 72));
    const baseSpeed = rand(170, 300) * scale * (reduced ? 0.7 : 1);
    const a0 = rand(0, TAU);
    const colorA = pick(STREAK_COLORS);
    const colorB = pick(STREAK_COLORS);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU + rand(-0.12, 0.12);
      const sp = baseSpeed * rand(0.5, 1.18);
      spawnStreak(
        cx,
        cy,
        a,
        sp,
        Math.random() < 0.55 ? colorA : colorB,
        rand(1.15, 2.1),
        rand(0.7, 1.5) * Math.max(0.8, scale)
      );
    }

    // 星芒
    const stars = reduced ? 1 : 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < stars; i++) {
      spawn({
        type: 'star',
        x: cx + rand(-16, 16) * scale,
        y: cy + rand(-16, 16) * scale,
        size: rand(20, 58) * scale,
        rot: rand(0, TAU),
        spin: rand(-0.35, 0.35),
        life: rand(1.1, 2.0),
        age: 0,
      });
    }

    // 金箔从爆心飞出
    if (!reduced) {
      const foils = Math.round(rand(8, 16));
      for (let i = 0; i < foils; i++) {
        const a = rand(0, TAU);
        const sp = rand(40, 170) * scale;
        spawn(
          makeFoil({
            x: cx,
            y: cy,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 30 * scale,
            fromBurst: true,
          })
        );
      }
    }

    if (!reduced) {
      spawn({ type: 'flash', x: cx, y: cy, maxR: Math.min(W, H) * 0.11, alpha: 0.34, life: 0.42, age: 0 });
    }
  }

  function spawnRocket() {
    const x0 = rand(W * 0.14, W * 0.86);
    const tx = clamp(x0 + rand(-W * 0.16, W * 0.16), W * 0.1, W * 0.9);
    const ty = rand(H * 0.12, H * 0.46);
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

    // 金箔雨：先来一阵，再分几波补上
    spawnFoilWave(reduced ? 24 : 74);
    if (reduced) {
      after(0.3, () => spawnFoilWave(10));
    } else {
      after(0.45, () => spawnFoilWave(26));
      after(1.0, () => spawnFoilWave(24));
      after(1.6, () => spawnFoilWave(20));
      after(2.2, () => spawnFoilWave(16));
    }

    // 细线烟花：火箭升空后炸开
    const rocketTimes = reduced ? [0.05, 1.0, 2.0] : [0.02, 0.32, 0.66, 1.02, 1.44, 1.92, 2.45];
    for (const t of rocketTimes) after(t, spawnRocket);

    // 全屏零星星芒
    const glints = reduced ? 3 : 12;
    for (let i = 0; i < glints; i++) {
      after(rand(0, 2.8), () => {
        spawn({
          type: 'star',
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
          p.age += 0;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= Math.exp(-0.35 * dt);
          p.r += p.grow * dt;
          alive = p.age < p.life;
          break;
        }
        case 'wisp': {
          p.y += p.vy * dt;
          p.vy *= Math.exp(-0.18 * dt);
          p.swayPhase += p.swayFreq * dt;
          p.x = p.baseX + Math.sin(p.swayPhase) * p.swayAmp * clamp(p.age / p.life, 0, 1);
          p.rot = Math.sin(p.swayPhase * 1.3) * 0.1;
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
          p.vx *= Math.exp(-1.9 * dt);
          p.vy *= Math.exp(-1.9 * dt);
          p.vy += 52 * scale * dt;
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
          if (p.trail.length > 12) p.trail.shift();
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
    const t = p.age / p.life;
    const a = envelope(t) * p.alpha;
    if (a <= 0.002) return;
    const w = p.r * 2.15;
    const h = p.r * 1.3;
    ctx.globalAlpha = a;
    ctx.drawImage(sprites.mistSprite, p.x - w / 2, p.y - h / 2, w, h);
  }

  function drawWisp(p) {
    const t = p.age / p.life;
    const a = envelope(t) * p.alpha * (1 - smoothstep(0.7, 1, t) * 0.6);
    if (a <= 0.002) return;
    const h = p.h * (1 + p.grow * t * 0.5);
    const w = p.w * (1 + t * 0.9);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = a;
    ctx.drawImage(sprites.wispSprite, -w / 2, -h * 0.72, w, h);
    ctx.restore();
  }

  function drawFoil(p) {
    const t = p.age / p.life;
    const env = smoothstep(0, 0.1, t) * (1 - smoothstep(0.72, 1, t));
    if (env <= 0.004) return;
    const c = Math.cos(p.tilt);
    const ws = Math.max(0.14, Math.abs(c));
    const bright = 0.52 + 0.48 * Math.abs(c);
    ctx.globalAlpha = clamp(p.alpha * env * bright, 0, 1);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.roll);
    ctx.scale(ws, 1);
    ctx.drawImage(p.sprite, -p.w / 2, -p.l / 2, p.w, p.l);
    ctx.restore();
  }

  function drawStreak(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const fade = Math.pow(1 - t, 1.5);
    if (fade <= 0.01) return;
    const speed = Math.hypot(p.vx, p.vy);
    ctx.strokeStyle = p.color;
    const tail = clamp(speed * 0.085, 3, 46);
    let nx = 0;
    let ny = 0;
    if (speed > 1) {
      nx = p.vx / speed;
      ny = p.vy / speed;
    }
    ctx.globalAlpha = fade * 0.82;
    ctx.lineWidth = Math.max(0.5, p.width * (0.35 + 0.65 * fade));
    ctx.beginPath();
    ctx.moveTo(p.x - nx * tail, p.y - ny * tail);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (speed > 1) {
      ctx.globalAlpha = fade * 0.45;
      const g = 7 * scale;
      ctx.drawImage(sprites.goldGlow, p.x - g / 2, p.y - g / 2, g, g);
    }
  }

  function drawRocket(p) {
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.1 * Math.max(0.8, scale);
    const trail = p.trail;
    if (trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const t = i / trail.length;
        ctx.globalAlpha = 0.5 * t;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.9;
    const g = 10 * scale;
    ctx.drawImage(sprites.goldGlow, p.x - g / 2, p.y - g / 2, g, g);
  }

  function drawStar(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t);
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
    const t = clamp(p.age / p.life, 0, 1);
    const a = Math.pow(1 - t, 2) * p.alpha;
    if (a <= 0.008) return;
    const r = p.maxR * (0.5 + 1.4 * (1 - Math.pow(1 - t, 3)));
    ctx.globalAlpha = a;
    ctx.drawImage(sprites.flashSprite, p.x - r, p.y - r, r * 2, r * 2);
  }

  function drawBokeh(p) {
    const t = clamp(p.age / p.life, 0, 1);
    const a = envelope(t) * p.alpha;
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

    // 1) 底层柔雾 / 散景 / 爆闪（加色）
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'mist') drawMist(p);
      else if (p.type === 'bokeh') drawBokeh(p);
      else if (p.type === 'flash') drawFlash(p);
    }

    // 2) 烛烟（加色、低透明度，像一缕被灯照亮的烟）
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'wisp') drawWisp(p);
    }

    // 3) 金箔（正片叠底色的实体片，翻转高光来自 sprite）
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.type === 'foil') drawFoil(p);
    }

    // 4) 金尘 / 烟花 / 星芒 / 愿望尘（加色）
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
