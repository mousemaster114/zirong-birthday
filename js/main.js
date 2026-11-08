/**
 * main.js — 总编排
 * ---------------------------------------------------------------
 * 把 UI 意图（ui:*）、3D 场景（scene:*）、声音、特效接成一条时间线。
 * 状态机：intro → reveal → lit → blowing → celebrate ⇄ wish
 *         任意阶段 → reset → intro
 */

import { bus, state, setPhase, setMuted, setReducedMotion } from './bus.js';
import { createUI } from './ui.js';
import { createFx } from './fx.js';
import { createAudio } from './audio.js';
import { createBirthdayScene } from './scene.js';

/* ---------------- 创建各层（任何一层失败都不拖垮整页） ---------------- */
const ui = createUI();

const fx = safeCreate('fx', () => createFx(document.getElementById('fx')), noopFx());
const audio = safeCreate('audio', () => createAudio(), noopAudio());
const scene = safeCreate('scene', () => createBirthdayScene(document.getElementById('scene-root')), null);

if (!scene) {
  bus.emit('scene:failed');
  console.warn('[main] 3D 场景不可用，显示静态祝福页');
}

setMuted(audio.isMuted());
applyReducedMotion(state.reducedMotion);

let busy = false;
let celebrateToastTimer = 0;

/* ---------------- 工具 ---------------- */
function safeCreate(label, factory, fallback) {
  try {
    return factory();
  } catch (err) {
    console.error(`[main] ${label} 初始化失败`, err);
    return fallback;
  }
}

function noopFx() {
  const noop = () => {};
  return {
    start: noop, revealPuff: noop, candleSmoke: noop, celebrate: noop,
    wishBurst: noop, reset: noop, setReducedMotion: noop, dispose: noop,
  };
}

function noopAudio() {
  const noop = () => {};
  let muted = false;
  return {
    start: noop, reveal: noop, blow: noop, celebrate: noop, wish: noop, click: noop,
    toggleMute() { muted = !muted; return muted; },
    isMuted: () => muted,
    reset: noop, dispose: noop,
    debug: () => ({ ctxState: 'unavailable', muted, started: false }),
  };
}

function call(name, ...args) {
  try {
    if (scene && typeof scene[name] === 'function') return scene[name](...args);
  } catch (err) {
    console.error(`[main] scene.${name} 出错`, err);
  }
  return undefined;
}

async function callAsync(name) {
  try {
    if (scene && typeof scene[name] === 'function') await scene[name]();
  } catch (err) {
    console.error(`[main] scene.${name} 出错`, err);
  }
}

function applyReducedMotion(value) {
  if (scene && typeof scene.setReducedMotion === 'function') scene.setReducedMotion(value);
  if (fx && typeof fx.setReducedMotion === 'function') fx.setReducedMotion(value);
  document.documentElement.classList.toggle('reduced-motion', value);
}

async function run(label, fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (err) {
    console.error(`[main] ${label} 失败`, err);
    ui.toast('刚刚走神了一下，再来一次？', 2600);
  } finally {
    busy = false;
  }
}

/* ---------------- 首次交互：解锁音频（必须在手势内） ---------------- */
bus.on('ui:first-interaction', () => {
  try { audio.start(); } catch (err) { console.error('[main] audio.start 失败', err); }
});

/* ---------------- 入场：掀开餐盖 ---------------- */
bus.on('ui:enter', () => {
  if (state.phase !== 'intro') return;
  run('enter', async () => {
    try { audio.start(); } catch (err) { console.error(err); }
    setPhase('reveal');
    window.setTimeout(() => {
      try { fx.revealPuff(); } catch (err) { console.error(err); }
    }, 380);
    try { audio.reveal(); } catch (err) { console.error(err); }
    try { fx.start(); } catch (err) { console.error(err); }
    await callAsync('reveal');
    setPhase('lit');
    window.setTimeout(() => {
      if (state.phase === 'lit') ui.toast('蜡烛点亮了 · 拖动看看蛋糕的侧面', 3000);
    }, 800);
  });
});

/* ---------------- 吹蜡烛 ---------------- */
bus.on('ui:blow', () => {
  if (state.phase !== 'lit') return;
  run('blow', async () => {
    setPhase('blowing');
    try { audio.blow(); } catch (err) { console.error(err); }
    try { fx.candleSmoke(); } catch (err) { console.error(err); }
    call('wishMode', false);
    await callAsync('blow');
    setPhase('celebrate');
    try { audio.celebrate(); } catch (err) { console.error(err); }
    try { fx.celebrate(); } catch (err) { console.error(err); }
    call('celebrate');
    window.clearTimeout(celebrateToastTimer);
    celebrateToastTimer = window.setTimeout(() => {
      if (state.phase === 'celebrate' || state.phase === 'wish') {
        ui.toast('记得许个愿 · 今晚的星星都在听', 3200);
      }
    }, 2400);
  });
});

/* ---------------- 许愿卡 ---------------- */
bus.on('ui:wish', () => {
  if (state.phase !== 'celebrate') return;
  setPhase('wish');
  call('wishMode', true);
  try { audio.wish(); } catch (err) { console.error(err); }
  try { fx.wishBurst(); } catch (err) { console.error(err); }
});

bus.on('ui:wish-close', () => {
  if (state.phase !== 'wish') return;
  call('wishMode', false);
  setPhase('celebrate');
});

/* ---------------- 再看一次 ---------------- */
bus.on('ui:replay', () => {
  if (busy || state.phase === 'intro') return;
  run('replay', async () => {
    window.clearTimeout(celebrateToastTimer);
    try { audio.reset(); } catch (err) { console.error(err); }
    try { fx.reset(); } catch (err) { console.error(err); }
    call('wishMode', false);
    state.celebrated = false;
    setPhase('intro');
    await callAsync('reset');
    ui.refresh();
    ui.toast('一切归位 · 随时可以再点一次', 2000);
  });
});

/* ---------------- 声音开关 ---------------- */
bus.on('ui:sound-toggle', () => {
  try { audio.start(); } catch (err) { console.error(err); }
  setMuted(audio.toggleMute());
});

/* ---------------- 降低动态效果 ---------------- */
bus.on('reduced-motion', applyReducedMotion);

/* ---------------- UI 轻响（在真实动作之后执行，确保 ctx 已解锁） ---------------- */
bus.on('ui:enter', () => { try { audio.click(); } catch (err) { console.error(err); } });
bus.on('ui:replay', () => { try { audio.click(); } catch (err) { console.error(err); } });
bus.on('ui:sound-toggle', () => { try { audio.click(); } catch (err) { console.error(err); } });

/* ---------------- 场景就绪 / 失败 ---------------- */
bus.on('scene:ready', () => {
  document.body.classList.add('scene-ready');
  applyReducedMotion(state.reducedMotion);
});

if (scene) {
  const raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (fn) => window.setTimeout(fn, 16);
  raf(() => {
    document.body.classList.add('scene-mounted');
    applyReducedMotion(state.reducedMotion);
  });
}

/* 调试句柄 */
window.__ZR_APP__ = {
  bus,
  state,
  ui,
  get scene() { return scene; },
  audio,
  fx,
  phases: () => state.phase,
};
