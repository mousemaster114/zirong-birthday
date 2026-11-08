/**
 * bus.js — 轻量事件总线 + 全局状态
 * ---------------------------------------------------------------
 * 所有模块只通过这里通信，避免相互 import 造成循环依赖。
 * 事件命名约定：
 *   ui:*        用户界面发出的意图（由 ui.js 发出，main.js 消费）
 *   scene:*     3D 场景的生命周期通知（由 scene.js 发出，ui.js/main.js 消费）
 *   audio:*     音频状态（由 audio.js 发出）
 *   phase       全局阶段变化（setPhase 触发）
 */

const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => bus.off(event, fn);
  },
  off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  },
  emit(event, payload) {
    const set = listeners.get(event);
    if (!set || set.size === 0) return;
    // 复制一份，允许监听器在回调里增删监听
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] listener error on "${event}"`, err);
      }
    }
  },
};

/** 全局状态（只读约定：通过 setPhase / setMuted 等函数修改） */
export const state = {
  /** intro | reveal | lit | blowing | celebrate | wish */
  phase: 'intro',
  muted: false,
  /** 是否已进入过主场景（掀开餐盖之后） */
  started: false,
  /** 是否已经完成一次庆祝 */
  celebrated: false,
  reducedMotion:
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  quality: 'high',
};

/** 可被 QA 脚本读取的调试句柄 */
if (typeof window !== 'undefined') {
  window.__ZR_STATE__ = state;
}

export function setPhase(phase) {
  if (state.phase === phase) return;
  state.phase = phase;
  if (phase !== 'intro') state.started = true;
  if (phase === 'celebrate' || phase === 'wish') state.celebrated = true;
  bus.emit('phase', phase);
}

export function setMuted(muted) {
  state.muted = !!muted;
  bus.emit('muted', state.muted);
}

export function setReducedMotion(value) {
  state.reducedMotion = !!value;
  bus.emit('reduced-motion', state.reducedMotion);
}
