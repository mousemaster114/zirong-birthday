/**
 * ui.js — HUD / 入场菜单卡 / 许愿卡 / 键盘 / 按钮状态
 * ---------------------------------------------------------------
 * 只做两件事：
 *   1) 把用户意图通过 bus.emit('ui:*') 抛出去；
 *   2) 监听 phase / muted / reduced-motion，把页面切到对应状态。
 * 不直接调用 scene / audio / fx。
 */

import { bus, state, setReducedMotion } from './bus.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const $ = (sel) => document.querySelector(sel);

export function createUI() {
  document.body.classList.remove('no-js');

  const dom = {
    intro: $('#intro'),
    btnEnter: $('#btn-enter'),
    btnSound: $('#btn-sound'),
    btnBlow: $('#btn-blow'),
    btnWish: $('#btn-wish'),
    btnReplay: $('#btn-replay'),
    btnWishClose: $('#btn-wish-close'),
    btnWishAccept: $('#btn-wish-accept'),
    wish: $('#wish'),
    wishCard: $('.wish__card'),
    fallback: $('#boot-fallback'),
    toast: $('#toast'),
    todayDate: $('#today-date'),
    hero: $('#hud-main'),
    topbar: $('#hud-top'),
  };

  let toastTimer = 0;
  let introHideTimer = 0;
  let wishHideTimer = 0;
  let lastFocus = null;
  let firstInteraction = false;

  /* ---------------- 日期 ---------------- */
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (dom.todayDate) {
      dom.todayDate.textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
    }
  } catch (_) {}

  /* ---------------- 小工具 ---------------- */
  function toast(message, duration = 2400) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => dom.toast.classList.remove('is-visible'), duration);
  }

  function showFallback() {
    if (!dom.fallback) return;
    dom.fallback.hidden = false;
    if (dom.intro) dom.intro.hidden = true;
    document.body.classList.add('has-fallback');
  }

  function setInert(el, inert) {
    if (!el) return;
    try { el.inert = !!inert; } catch (_) {}
    if (inert) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  }

  function openWish() {
    if (!dom.wish) return;
    window.clearTimeout(wishHideTimer);
    lastFocus = document.activeElement;
    dom.wish.hidden = false;
    dom.wish.classList.add('is-open');
    dom.wish.removeAttribute('aria-hidden');
    window.requestAnimationFrame(() => {
      dom.btnWishClose?.focus({ preventScroll: true });
    });
  }

  function closeWish() {
    if (!dom.wish || dom.wish.hidden) return;
    dom.wish.classList.remove('is-open');
    dom.wish.setAttribute('aria-hidden', 'true');
    window.clearTimeout(wishHideTimer);
    wishHideTimer = window.setTimeout(() => {
      dom.wish.hidden = true;
    }, 620);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  function closeIntro() {
    if (!dom.intro || dom.intro.hidden) return;
    setInert(dom.intro, true);
    dom.intro.classList.add('is-closing');
    window.clearTimeout(introHideTimer);
    introHideTimer = window.setTimeout(() => {
      dom.intro.hidden = true;
      dom.intro.classList.remove('is-closing');
    }, 720);
  }

  function openIntro() {
    if (!dom.intro) return;
    window.clearTimeout(introHideTimer);
    dom.intro.hidden = false;
    dom.intro.classList.remove('is-closing');
    setInert(dom.intro, false);
  }

  function syncButtons() {
    const phase = state.phase;
    const canBlow = phase === 'lit';
    const canWish = phase === 'celebrate' || phase === 'wish';
    const canReplay = phase === 'celebrate' || phase === 'wish' || phase === 'lit';
    if (dom.btnBlow) dom.btnBlow.disabled = !canBlow;
    if (dom.btnWish) dom.btnWish.disabled = !canWish;
    if (dom.btnReplay) dom.btnReplay.disabled = !canReplay;
    if (dom.btnBlow) dom.btnBlow.setAttribute('aria-disabled', String(!canBlow));
    if (dom.btnWish) dom.btnWish.setAttribute('aria-disabled', String(!canWish));
    if (dom.btnReplay) dom.btnReplay.setAttribute('aria-disabled', String(!canReplay));
  }

  function applyPhase(phase) {
    const body = document.body;
    body.classList.toggle('is-intro', phase === 'intro');
    body.classList.toggle('is-started', phase !== 'intro');
    body.classList.toggle('is-reveal', phase === 'reveal');
    body.classList.toggle('is-lit', phase === 'lit');
    body.classList.toggle('is-blowing', phase === 'blowing');
    body.classList.toggle('is-celebrating', phase === 'celebrate' || phase === 'wish');
    body.classList.toggle('is-celebrated', !!state.celebrated);

    if (phase === 'intro') {
      openIntro();
      closeWish();
      body.classList.remove('is-celebrated', 'is-celebrating');
    } else {
      closeIntro();
    }

    if (phase === 'wish') openWish();
    else closeWish();

    syncButtons();
  }

  /* ---------------- 事件绑定 ---------------- */
  function onFirstInteraction() {
    if (firstInteraction) return;
    firstInteraction = true;
    bus.emit('ui:first-interaction');
  }

  document.addEventListener('pointerdown', onFirstInteraction, { capture: true, once: true, passive: true });
  document.addEventListener('keydown', onFirstInteraction, { capture: true, once: true });

  dom.btnEnter?.addEventListener('click', () => {
    if (state.phase !== 'intro') return;
    bus.emit('ui:enter');
  });

  dom.btnBlow?.addEventListener('click', () => {
    if (state.phase !== 'lit') return;
    bus.emit('ui:blow');
  });

  dom.btnWish?.addEventListener('click', () => {
    if (state.phase !== 'celebrate') return;
    bus.emit('ui:wish');
  });

  dom.btnReplay?.addEventListener('click', () => {
    if (!state.started) return;
    bus.emit('ui:replay');
  });

  dom.btnSound?.addEventListener('click', () => {
    bus.emit('ui:sound-toggle');
  });

  function requestCloseWish() {
    if (state.phase !== 'wish') {
      closeWish();
      return;
    }
    bus.emit('ui:wish-close');
  }
  dom.btnWishClose?.addEventListener('click', requestCloseWish);
  dom.wish?.querySelector('[data-wish-close]')?.addEventListener('click', requestCloseWish);
  dom.btnWishAccept?.addEventListener('click', requestCloseWish);

  /* ---------------- 键盘 ---------------- */
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    const isTyping = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (ev.target && ev.target.isContentEditable);

    if (ev.key === 'Escape') {
      if (state.phase === 'wish' && dom.wish && !dom.wish.hidden) {
        ev.preventDefault();
        requestCloseWish();
      }
      return;
    }

    if (isTyping) return;

    // 空格吹蜡烛（避免按钮聚焦时重复触发）
    if (ev.code === 'Space' || ev.key === ' ') {
      const onButton = ev.target && ev.target.closest && ev.target.closest('button, a, [role="button"]');
      if (!onButton) {
        if (state.phase === 'lit') {
          ev.preventDefault();
          bus.emit('ui:blow');
        } else if (state.phase === 'intro' && !dom.intro?.hidden) {
          ev.preventDefault();
          bus.emit('ui:enter');
        }
      }
      return;
    }

    if (ev.key === 'Enter' && state.phase === 'intro' && !dom.intro?.hidden) {
      const onButton = ev.target && ev.target.closest && ev.target.closest('button, a');
      if (!onButton) {
        ev.preventDefault();
        bus.emit('ui:enter');
      }
    }

    // 简单焦点陷阱：入场卡 / 许愿卡
    const scope = state.phase === 'wish' ? dom.wish : state.phase === 'intro' ? dom.intro : null;
    if (ev.key === 'Tab' && scope && !scope.hidden) {
      const nodes = Array.from(scope.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });

  /* ---------------- 总线监听 ---------------- */
  bus.on('phase', applyPhase);
  bus.on('scene:failed', showFallback);

  bus.on('muted', (muted) => {
    document.body.classList.toggle('sound-off', muted);
    if (dom.btnSound) {
      dom.btnSound.setAttribute('aria-pressed', String(!muted));
      dom.btnSound.setAttribute('aria-label', muted ? '开启音乐' : '关闭音乐');
      const label = dom.btnSound.querySelector('.sound__label');
      if (label) label.textContent = muted ? '静音' : '音乐';
    }
    if (state.started) toast(muted ? '音乐已静音' : '音乐已开启', 1600);
  });

  bus.on('reduced-motion', (value) => {
    document.documentElement.classList.toggle('reduced-motion', !!value);
  });

  // 媒体查询变化同步到全局
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReducedMotion(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    document.documentElement.classList.toggle('reduced-motion', mq.matches);
  }

  // 初始化
  applyPhase(state.phase);
  if (state.muted) {
    document.body.classList.add('sound-off');
    dom.btnSound?.setAttribute('aria-pressed', 'false');
    const label = dom.btnSound?.querySelector('.sound__label');
    if (label) label.textContent = '静音';
  }

  return {
    toast,
    showFallback,
    refresh: syncButtons,
  };
}
