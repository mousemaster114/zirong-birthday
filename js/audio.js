/**
 * audio.js — 「深夜甜品店」纯 WebAudio 程序化配乐
 * ---------------------------------------------------------------
 * 契约：export function createAudio(): AudioHandle
 *
 * 设计目标：
 *   - 零音频文件、零 CDN 请求，全部实时合成。
 *   - 主旋律：F 大调、3/4 拍、92 BPM 的音乐盒版《生日快乐》（旋律为公版民谣）。
 *   - 伴奏：暖 pad、拨弦贝斯、2/3 拍轻刷、黑胶底噪与随机爆点。
 *   - 听感：像「隔壁房间传来的音乐盒」——克制、温暖、有空间感。
 *   - 音量：master ≈ 0.21（契约要求 0.18–0.24），经 limiter 防爆音。
 *
 * 自动播放策略：
 *   - 创建 AudioContext 只发生在 start()（必须由用户手势触发）。
 *   - 任何失败都静默处理，不抛错。
 *   - muted 偏好持久化到 localStorage('zr_muted')。
 *
 * QA：
 *   - window.__ZR_AUDIO__ = { ctxState, started, muted } 随状态更新。
 *   - debug() 额外返回 notes / music / level（analyser 峰值），便于验证真的出声。
 */

const STORAGE_KEY = 'zr_muted';

// ---------------------------------------------------------------------------
// 乐理与编曲常量
// ---------------------------------------------------------------------------

const BPM = 92;
const SPB = 60 / BPM; // 每拍秒数 ≈ 0.652
const LOOP_BEATS = 36; // 12 小节 × 3 拍
const LOOP_SECONDS = LOOP_BEATS * SPB; // ≈ 23.5s

const MASTER_LEVEL = 0.21;
const MUSIC_LEVEL = 0.9;

const NOTE_INDEX = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

/** "F#4" / "Bb5" -> Hz */
function freqOf(name) {
  const m = /^([A-G][b#]?)(-?\d)$/.exec(name);
  if (!m) return 440;
  const midi = (parseInt(m[2], 10) + 1) * 12 + NOTE_INDEX[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * 音乐盒声部 —— F 大调《生日快乐》，3/4 拍。
 * 起拍为弱起（第 3 拍），所以第一句从 beat 2 开始。
 * 音高：sol sol la sol do ti / sol sol la sol re do /
 *       sol sol sol' mi do ti la / fa fa mi do re do
 */
const MELODY = [
  // 第 1 句：Happy birthday to you
  { beat: 2.0, note: 'C5', dur: 0.5, vel: 0.8 },
  { beat: 2.5, note: 'C5', dur: 0.5, vel: 0.68 },
  { beat: 3.0, note: 'D5', dur: 1.0, vel: 0.92 },
  { beat: 4.0, note: 'C5', dur: 1.0, vel: 0.85 },
  { beat: 5.0, note: 'F5', dur: 1.0, vel: 1.0 },
  { beat: 6.0, note: 'E5', dur: 2.8, vel: 0.82 },
  // 第 2 句
  { beat: 9.0, note: 'C5', dur: 0.5, vel: 0.8 },
  { beat: 9.5, note: 'C5', dur: 0.5, vel: 0.68 },
  { beat: 10.0, note: 'D5', dur: 1.0, vel: 0.92 },
  { beat: 11.0, note: 'C5', dur: 1.0, vel: 0.85 },
  { beat: 12.0, note: 'G5', dur: 1.0, vel: 1.0 },
  { beat: 13.0, note: 'F5', dur: 2.8, vel: 0.8 },
  // 第 3 句：Happy birthday dear 子荣
  { beat: 16.0, note: 'C5', dur: 0.5, vel: 0.8 },
  { beat: 16.5, note: 'C5', dur: 0.5, vel: 0.68 },
  { beat: 17.0, note: 'C6', dur: 1.0, vel: 1.02 },
  { beat: 18.0, note: 'A5', dur: 1.0, vel: 0.9 },
  { beat: 19.0, note: 'F5', dur: 1.0, vel: 0.86 },
  { beat: 20.0, note: 'E5', dur: 1.0, vel: 0.8 },
  { beat: 21.0, note: 'D5', dur: 1.7, vel: 0.78 },
  // 第 4 句
  { beat: 23.0, note: 'Bb5', dur: 0.5, vel: 0.82 },
  { beat: 23.5, note: 'Bb5', dur: 0.5, vel: 0.7 },
  { beat: 24.0, note: 'A5', dur: 1.0, vel: 0.88 },
  { beat: 25.0, note: 'F5', dur: 1.0, vel: 0.84 },
  { beat: 26.0, note: 'G5', dur: 1.0, vel: 0.84 },
  { beat: 27.0, note: 'F5', dur: 2.8, vel: 0.76 },
  // 尾奏：音乐盒慢慢停下，留一点呼吸再循环
  { beat: 30.5, note: 'F5', dur: 1.2, vel: 0.34 },
  { beat: 32.5, note: 'A5', dur: 1.2, vel: 0.3 },
  { beat: 34.5, note: 'C6', dur: 1.6, vel: 0.28 },
];

/** 每小节（3 拍）的和弦：根音 + pad 三音 */
const CHORDS = [
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 0  F
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 1  F
  { root: 'C3', notes: ['G3', 'C4', 'E4'] }, //  bar 2  C
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 3  F
  { root: 'C3', notes: ['G3', 'C4', 'E4'] }, //  bar 4  C
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 5  F
  { root: 'D3', notes: ['F3', 'A3', 'D4'] }, //  bar 6  Dm
  { root: 'Bb2', notes: ['F3', 'Bb3', 'D4'] }, // bar 7  Bb
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 8  F(add9)
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 9  F
  { root: 'C3', notes: ['G3', 'C4', 'E4'] }, //  bar 10 C
  { root: 'F2', notes: ['F3', 'A3', 'C4'] }, //  bar 11 F
];

const EVENT_ORDER = { pad: 0, bass: 1, brush: 2, melody: 3 };

/** 单次循环的全部演奏事件，按拍排序 */
const EVENTS = (() => {
  const list = [];
  for (const n of MELODY) {
    list.push({ beat: n.beat, type: 'melody', note: n.note, dur: n.dur, vel: n.vel });
  }
  CHORDS.forEach((chord, bar) => {
    const b = bar * 3;
    list.push({ beat: b, type: 'pad', chord: chord.notes, dur: 3, vel: 1 });
    list.push({ beat: b, type: 'bass', note: chord.root, vel: 0.9 });
    list.push({ beat: b + 1, type: 'brush', vel: 0.5 });
    list.push({ beat: b + 2, type: 'brush', vel: 0.8 });
  });
  list.sort((a, b) => a.beat - b.beat || EVENT_ORDER[a.type] - EVENT_ORDER[b.type]);
  return list;
})();

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 程序化 impulse response：指数衰减噪声，略低通，暖一点的尾音。
 * @param {BaseAudioContext} context
 * @param {number} seconds
 * @param {number} decay
 */
function makeImpulse(context, seconds = 2.4, decay = 3.0) {
  const rate = context.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = context.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const n = Math.random() * 2 - 1;
      lp = lp * 0.72 + n * 0.28; // 低通，尾音更暖
      data[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

/** 2 秒白噪声缓冲（各音效/黑胶共用） */
function makeNoiseBuffer(context) {
  const rate = context.sampleRate;
  const len = Math.floor(rate * 2);
  const buf = context.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** 黑胶声：低频呼呼 + 稀疏爆点，循环 8 秒 */
function makeVinylBuffer(context) {
  const rate = context.sampleRate;
  const seconds = 8;
  const len = Math.floor(rate * seconds);
  const buf = context.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  let brown = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    brown = brown * 0.965 + w * 0.035;
    data[i] = brown * 0.22;
  }
  // 随机爆点（把 pop 直接写进循环缓冲，听起来更自然）
  const pops = Math.floor(seconds * 9);
  for (let p = 0; p < pops; p++) {
    const pos = Math.floor(rand(0, len - 2000));
    const amp = rand(0.02, 0.075);
    const decay = rand(18, 60);
    for (let i = 0; i < 600; i++) {
      data[pos + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / decay);
    }
  }
  return buf;
}

/** 黑胶底噪 + 随机爆点 + 一点磁带嘶声，循环播放，作为「旧唱片」底色 */
function makeVinylLoop(context, noiseBuffer) {
  const vinyl = context.createBufferSource();
  vinyl.buffer = makeVinylBuffer(context);
  vinyl.loop = true;
  vinyl.playbackRate.value = 0.99;

  const lp = context.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2600;
  lp.Q.value = 0.5;

  const gain = context.createGain();
  gain.gain.value = 0.34;

  vinyl.connect(lp);
  lp.connect(gain);
  gain.connect(context.__zrAmbBus);

  // 高频嘶声
  const hiss = context.createBufferSource();
  hiss.buffer = noiseBuffer;
  hiss.loop = true;
  const hp = context.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4200;
  const hissGain = context.createGain();
  hissGain.gain.value = 0.006;
  hiss.connect(hp);
  hp.connect(hissGain);
  hissGain.connect(context.__zrAmbBus);

  return { vinyl, hiss };
}

// ---------------------------------------------------------------------------
// createAudio
// ---------------------------------------------------------------------------

export function createAudio() {
  let ctx = null;
  let disposed = false;
  let started = false;
  let failed = false;

  let muted = false;
  try {
    muted = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
  } catch (_) {
    muted = false;
  }

  // 图节点
  let master = null;
  let limiter = null;
  let analyser = null;
  let levelData = null;
  let reverb = null;
  let musicBus = null;
  let padBus = null;
  let celebBus = null;
  let sfxBus = null;
  let ambBus = null;
  let melodySend = null;
  let padSend = null;
  let chimeSend = null;
  let sfxSend = null;
  let noiseBuffer = null;
  let vinylNodes = null;
  let ambience = null;

  let musicOn = false;
  let musicStarted = false;
  let schedulerTimer = 0;
  let eventIndex = 0;
  let loopStart = 0;
  let nextEventTime = 0;
  let notesScheduled = 0;
  let musicGainTarget = MUSIC_LEVEL;
  let celebrateOn = false;
  let celebrationSources = [];
  let celebrationCleanup = 0;

  // QA 调试对象（保持同一引用，随状态更新）
  const debugObj = {
    ctxState: 'none',
    started: false,
    muted,
  };
  if (typeof window !== 'undefined') window.__ZR_AUDIO__ = debugObj;

  function publish() {
    debugObj.ctxState = ctx ? ctx.state : 'none';
    debugObj.started = started;
    debugObj.muted = muted;
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function updateLevel() {
    if (!analyser || !levelData) return 0;
    analyser.getByteTimeDomainData(levelData);
    let peak = 0;
    for (let i = 0; i < levelData.length; i++) {
      const v = Math.abs(levelData[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  function safeResume() {
    if (!ctx || disposed) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) {
      /* 自动播放限制：静默失败 */
    }
  }

  // -------------------------------------------------------------------------
  // 音频图
  // -------------------------------------------------------------------------

  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER_LEVEL;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.25;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    levelData = new Uint8Array(analyser.fftSize);

    master.connect(limiter);
    limiter.connect(analyser);
    analyser.connect(ctx.destination);

    // 混响：程序化 impulse，空间感来自这里
    reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 2.6, 3.1);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.85;
    reverb.connect(reverbOut);
    reverbOut.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;
    musicBus.connect(master);

    padBus = ctx.createGain();
    padBus.gain.value = 0.9;
    padBus.connect(master);

    celebBus = ctx.createGain();
    celebBus.gain.value = 0;
    celebBus.connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);

    ambBus = ctx.createGain();
    ambBus.gain.value = 1;
    ambBus.connect(master);
    ctx.__zrAmbBus = ambBus;

    melodySend = ctx.createGain();
    melodySend.gain.value = 0.32;
    melodySend.connect(reverb);

    padSend = ctx.createGain();
    padSend.gain.value = 0.22;
    padSend.connect(reverb);

    chimeSend = ctx.createGain();
    chimeSend.gain.value = 0.62;
    chimeSend.connect(reverb);

    sfxSend = ctx.createGain();
    sfxSend.gain.value = 0.3;
    sfxSend.connect(reverb);

    noiseBuffer = makeNoiseBuffer(ctx);

    // 黑胶底噪
    try {
      vinylNodes = makeVinylLoop(ctx, noiseBuffer);
      vinylNodes.vinyl.start(0);
      vinylNodes.hiss.start(0);
    } catch (_) {
      vinylNodes = null;
    }

    ctx.onstatechange = publish;
    publish();
  }

  /** 低音量环境垫音（F + C 的开放五度），压得很低，作为「房间」的呼吸 */
  function startAmbience() {
    if (!ctx || ambience) return;
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 460;
      filter.Q.value = 0.4;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now());
      gain.gain.linearRampToValueAtTime(0.055, now() + 1.8);

      filter.connect(gain);
      gain.connect(ambBus);

      const oscs = [];
      for (const [note, amp, type] of [
        ['F2', 0.5, 'triangle'],
        ['C3', 0.32, 'sine'],
        ['A3', 0.14, 'sine'],
      ]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freqOf(note);
        osc.detune.value = rand(-4, 4);
        const g = ctx.createGain();
        g.gain.value = amp;
        osc.connect(g);
        g.connect(filter);
        osc.start();
        oscs.push(osc);
      }

      // 极慢的音量呼吸
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      lfo.start();
      oscs.push(lfo);

      ambience = { gain, oscs, filter };
    } catch (_) {
      ambience = null;
    }
  }

  // -------------------------------------------------------------------------
  // 乐器
  // -------------------------------------------------------------------------

  /** 音乐盒音色：正弦基频 + 2/3 次谐波 + 少量失谐泛音，快速指数衰减 */
  const MUSIC_BOX_PARTIALS = [
    { ratio: 1, amp: 1.0, decay: 1.0 },
    { ratio: 2.0, amp: 0.27, decay: 0.52 },
    { ratio: 3.01, amp: 0.1, decay: 0.3 },
    { ratio: 4.08, amp: 0.045, decay: 0.19 },
    { ratio: 5.9, amp: 0.022, decay: 0.13 },
  ];

  function makePanner(pan) {
    if (typeof ctx.createStereoPanner !== 'function') return null;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }

  /**
   * 音乐盒单音
   * @param {number} freq Hz
   * @param {number} when ctx 时间
   * @param {number} ring 余音（秒）
   * @param {number} vel 力度
   * @param {{gain?:number, pan?:number, bus?:AudioNode, send?:AudioNode}} opts
   */
  function playMusicBox(freq, when, ring, vel, opts = {}) {
    if (!ctx || disposed) return;
    const t = Math.max(when, now() + 0.002);
    const bus = opts.bus || musicBus;
    const send = opts.send || melodySend;
    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = makePanner(opts.pan != null ? opts.pan : rand(-0.12, 0.12));
    if (panner) {
      out.connect(panner);
      panner.connect(bus);
      panner.connect(send);
    } else {
      out.connect(bus);
      out.connect(send);
    }

    const peak = (opts.gain != null ? opts.gain : 0.4) * vel;
    const detune = rand(-5, 5);
    const ringTime = clamp(ring, 0.7, 2.6);

    for (const partial of MUSIC_BOX_PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * partial.ratio;
      osc.detune.value = detune + (partial.ratio > 1 ? rand(-4, 4) : 0);
      const g = ctx.createGain();
      const p = peak * partial.amp;
      const dur = Math.min(ringTime * partial.decay, 2.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(p, t + 0.004);
      g.gain.exponentialRampToValueAtTime(Math.max(0.00008, p * 0.01), t + 0.06 + dur);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 0.1 + dur);
    }

    // 击弦瞬态：极短的高频噪声，让音头更「叮」
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.playbackRate.value = rand(0.9, 1.15);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = clamp(freq * 3.2, 2600, 9000);
      const g = ctx.createGain();
      const p = Math.max(0.0001, peak * 0.16);
      g.gain.setValueAtTime(p, t);
      g.gain.exponentialRampToValueAtTime(0.00005, t + 0.035);
      src.connect(hp);
      hp.connect(g);
      g.connect(out);
      src.start(t, rand(0, 1.6), 0.05);
      src.stop(t + 0.06);
    } catch (_) {
      /* ignore transient failure */
    }

    notesScheduled++;
  }

  /** 暖 pad：低通三角波，慢起慢收 */
  function playPad(chordNotes, when, durBeats, vel = 1) {
    if (!ctx || disposed) return;
    const t = Math.max(when, now() + 0.002);
    const durSec = durBeats * SPB;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 760;
    filter.Q.value = 0.35;

    const env = ctx.createGain();
    const peak = 0.052 * vel;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + Math.min(0.9, durSec * 0.5));
    env.gain.setValueAtTime(peak, t + Math.max(Math.min(0.9, durSec * 0.5), durSec - 0.5));
    env.gain.linearRampToValueAtTime(0.0001, t + durSec + 0.6);

    filter.connect(env);
    env.connect(padBus);
    env.connect(padSend);

    // 微弱的滤波扫动，像房间里的空气在动
    try {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = rand(0.13, 0.22);
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = 90;
      lfo.connect(lfoAmt);
      lfoAmt.connect(filter.frequency);
      lfo.start(t);
      lfo.stop(t + durSec + 0.8);
    } catch (_) {
      /* ignore */
    }

    for (const name of chordNotes) {
      for (const det of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freqOf(name);
        osc.detune.value = det + rand(-2, 2);
        const g = ctx.createGain();
        g.gain.value = 0.34;
        osc.connect(g);
        g.connect(filter);
        osc.start(t);
        osc.stop(t + durSec + 0.9);
      }
    }
  }

  /** 拨弦贝斯：短促、低通、带一点下滑音 */
  function playBass(note, when, vel = 1) {
    if (!ctx || disposed) return;
    const t = Math.max(when, now() + 0.002);
    const f = freqOf(note);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    filter.Q.value = 1.1;

    const env = ctx.createGain();
    const peak = 0.28 * vel;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);

    filter.connect(env);
    env.connect(padBus);
    env.connect(padSend);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f * 1.03, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + 0.62);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.35;
    sub.connect(subGain);
    subGain.connect(filter);
    sub.start(t);
    sub.stop(t + 0.5);
  }

  /** 轻刷：2、3 拍上的噪声沙沙，很轻 */
  function playBrush(when, vel = 1) {
    if (!ctx || disposed) return;
    const t = Math.max(when, now() + 0.002);
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.playbackRate.value = rand(0.85, 1.15);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(3600, 6800);
      bp.Q.value = 0.8;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;

      const g = ctx.createGain();
      const peak = 0.045 * vel;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + rand(0.09, 0.16));

      src.connect(bp);
      bp.connect(hp);
      hp.connect(g);
      g.connect(padBus);
      g.connect(padSend);
      src.start(t, rand(0, 1.4), 0.2);
      src.stop(t + 0.24);
    } catch (_) {
      /* ignore */
    }
  }

  /** 风铃：清亮的高音铃铛，长混响 */
  function playChime(freq, when, vel = 1, pan = 0, opts = {}) {
    if (!ctx || disposed) return;
    const t = Math.max(when, now() + 0.002);
    const bus = opts.bus || musicBus;
    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = makePanner(pan);
    if (panner) {
      out.connect(panner);
      panner.connect(bus);
      panner.connect(chimeSend);
    } else {
      out.connect(bus);
      out.connect(chimeSend);
    }

    const peak = (opts.gain != null ? opts.gain : 0.085) * vel;
    const ring = opts.ring != null ? opts.ring : 2.4;
    const partials = [
      { ratio: 1, amp: 1, decay: 1 },
      { ratio: 2.76, amp: 0.36, decay: 0.5 },
      { ratio: 5.4, amp: 0.12, decay: 0.28 },
    ];
    for (const partial of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * partial.ratio;
      osc.detune.value = rand(-4, 4);
      const g = ctx.createGain();
      const p = Math.max(0.0001, peak * partial.amp);
      const dur = ring * partial.decay;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(p, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.00005, t + dur);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      if (opts.track) celebrationSources.push(osc);
    }
    notesScheduled++;
  }

  // -------------------------------------------------------------------------
  // 音乐调度
  // -------------------------------------------------------------------------

  function scheduleEvent(ev, when) {
    try {
      switch (ev.type) {
        case 'melody': {
          const freq = freqOf(ev.note);
          const ring = clamp(0.45 + ev.dur * 0.55, 0.6, 2.4);
          playMusicBox(freq, when, ring, ev.vel);
          break;
        }
        case 'pad':
          playPad(ev.chord, when, ev.dur, ev.vel);
          break;
        case 'bass':
          playBass(ev.note, when, ev.vel);
          break;
        case 'brush':
          playBrush(when, ev.vel);
          break;
        default:
          break;
      }
    } catch (_) {
      /* 单个音符失败不应中断调度 */
    }
  }

  function tick() {
    if (!ctx || !musicOn || disposed) return;
    const horizon = now() + 0.5;
    let guard = 0;
    while (nextEventTime <= horizon && guard++ < 160) {
      const ev = EVENTS[eventIndex];
      scheduleEvent(ev, nextEventTime);
      eventIndex++;
      if (eventIndex >= EVENTS.length) {
        eventIndex = 0;
        loopStart += LOOP_SECONDS;
      }
      nextEventTime = loopStart + EVENTS[eventIndex].beat * SPB;
    }
  }

  function startMusic(delay = 0.3) {
    if (!ctx || musicOn || disposed) return;
    musicOn = true;
    if (!musicStarted) {
      musicStarted = true;
      // 音乐响起时把音乐总线从 0 淡入（reset 后重新开始也适用）
      const t = now();
      try {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(musicBus.gain.value, t);
        musicBus.gain.linearRampToValueAtTime(MUSIC_LEVEL, t + 0.8);
      } catch (_) {
        /* ignore */
      }
    }
    loopStart = now() + Math.max(0.08, delay);
    eventIndex = 0;
    nextEventTime = loopStart + EVENTS[0].beat * SPB;
    tick();
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(tick, 90);
    publish();
  }

  function stopMusic() {
    musicOn = false;
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = 0;
    }
    publish();
  }

  /** 吹蜡烛时，音乐「暂停半拍」+ 短暂 duck */
  function duckMusic() {
    if (!ctx || !musicBus) return;
    const t = now();
    try {
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(musicBus.gain.value, t);
      musicBus.gain.linearRampToValueAtTime(MUSIC_LEVEL * 0.22, t + 0.07);
      musicBus.gain.linearRampToValueAtTime(musicGainTarget, t + 1.5);
    } catch (_) {
      /* ignore */
    }
    // 音乐整体后移半拍（0.33s），造成呼吸上的停顿
    const shift = SPB * 0.5;
    loopStart += shift;
    nextEventTime += shift;
  }

  function setMusicGain(target, ramp = 1.2) {
    if (!ctx || !musicBus) return;
    musicGainTarget = target;
    const t = now();
    try {
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(musicBus.gain.value, t);
      musicBus.gain.linearRampToValueAtTime(target, t + ramp);
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 音效
  // -------------------------------------------------------------------------

  /** 滤波噪声 whoosh 的通用实现 */
  function noiseWhoosh(opts) {
    if (!ctx || disposed) return;
    const {
      when = now() + 0.01,
      dur = 0.9,
      from = 180,
      mid = 900,
      to = 260,
      gain = 0.22,
      q = 0.9,
      type = 'lowpass',
      playbackRate = 1,
      pan = 0,
    } = opts || {};
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      src.playbackRate.value = playbackRate;

      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.Q.value = q;
      filter.frequency.setValueAtTime(from, when);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, mid), when + dur * 0.45);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), when + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(gain, when + dur * 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

      const panner = makePanner(pan);
      src.connect(filter);
      filter.connect(g);
      if (panner) {
        g.connect(panner);
        panner.connect(sfxBus);
        panner.connect(sfxSend);
      } else {
        g.connect(sfxBus);
        g.connect(sfxSend);
      }
      src.start(when, rand(0, 1.2));
      src.stop(when + dur + 0.05);
    } catch (_) {
      /* ignore */
    }
  }

  /** 低频扫频（气流/揭盖的重量感） */
  function lowSweep(when, dur, from, to, gain) {
    if (!ctx || disposed) return;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(from, when);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), when + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(gain, when + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g);
      g.connect(sfxBus);
      g.connect(sfxSend);
      osc.start(when);
      osc.stop(when + dur + 0.05);
    } catch (_) {
      /* ignore */
    }
  }

  function sfxReveal() {
    const t = now() + 0.01;
    noiseWhoosh({ when: t, dur: 1.15, from: 160, mid: 1100, to: 220, gain: 0.2, q: 0.7 });
    lowSweep(t, 1.0, 120, 46, 0.1);
    // 光尘 sparkle：一串上行铃音
    const notes = ['C6', 'D6', 'F6', 'G6', 'A6', 'C7'];
    notes.forEach((n, i) => {
      playChime(freqOf(n), t + 0.42 + i * 0.055, 0.6, i % 2 === 0 ? -0.35 : 0.35, {
        gain: 0.055,
        ring: 1.6,
      });
    });
  }

  function sfxBlow() {
    const t = now() + 0.01;
    noiseWhoosh({ when: t, dur: 0.75, from: 260, mid: 2600, to: 320, gain: 0.3, q: 0.8 });
    noiseWhoosh({ when: t + 0.06, dur: 0.5, from: 900, mid: 3200, to: 500, gain: 0.12, q: 1.2, type: 'bandpass' });
    lowSweep(t, 0.5, 90, 42, 0.07);
    duckMusic();
  }

  function sfxWish() {
    const t = now() + 0.01;
    // 纸页摩擦：带通噪声 + 三次轻响
    try {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.playbackRate.value = rand(0.7, 0.95);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(1600, 2600);
      bp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.05);
      g.gain.linearRampToValueAtTime(0.03, t + 0.12);
      g.gain.linearRampToValueAtTime(0.09, t + 0.2);
      g.gain.linearRampToValueAtTime(0.02, t + 0.3);
      g.gain.linearRampToValueAtTime(0.055, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
      src.connect(bp);
      bp.connect(g);
      g.connect(sfxBus);
      g.connect(sfxSend);
      src.start(t, rand(0, 1.2), 0.8);
      src.stop(t + 0.8);
      // 翻页的低频气流
      noiseWhoosh({ when: t + 0.05, dur: 0.55, from: 500, mid: 1800, to: 300, gain: 0.05, q: 0.6 });
    } catch (_) {
      /* ignore */
    }
    // 风铃
    const notes = ['F5', 'A5', 'C6', 'D6', 'F6'];
    notes.forEach((n, i) => {
      playChime(freqOf(n), t + 0.18 + i * 0.12, rand(0.5, 0.9), rand(-0.6, 0.6), {
        gain: 0.07,
        ring: 2.6,
      });
    });
  }

  function sfxClick() {
    if (!ctx || disposed) return;
    const t = now() + 0.005;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1040, t);
      osc.frequency.exponentialRampToValueAtTime(700, t + 0.04);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
      osc.connect(g);
      g.connect(sfxBus);
      g.connect(sfxSend);
      osc.start(t);
      osc.stop(t + 0.07);
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 庆祝层：弦乐式铺底 + 上行琶音 + 风铃
  // -------------------------------------------------------------------------

  function stopCelebration(immediate = false) {
    const t = now() + (immediate ? 0.01 : 0.4);
    for (const node of celebrationSources) {
      try {
        node.stop(t);
      } catch (_) {
        /* already stopped */
      }
    }
    celebrationSources = [];
    if (celebrationCleanup) {
      clearTimeout(celebrationCleanup);
      celebrationCleanup = 0;
    }
  }

  function sfxCelebrate() {
    if (!ctx || disposed || celebrateOn) return;
    celebrateOn = true;
    const t = now() + 0.01;

    // 音乐整体略微上扬
    setMusicGain(MUSIC_LEVEL * 1.1, 1.6);
    try {
      celebBus.gain.cancelScheduledValues(t);
      celebBus.gain.setValueAtTime(celebBus.gain.value, t);
      celebBus.gain.linearRampToValueAtTime(0.85, t + 1.5);
    } catch (_) {
      /* ignore */
    }

    // 弦乐式 pad：sawtooth + 低通 + 慢起音
    try {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = clamp(1200, 400, 3000);
      filter.Q.value = 0.5;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.05, t + 2.2);
      env.gain.setValueAtTime(0.05, t + 8.5);
      env.gain.linearRampToValueAtTime(0.0001, t + 11.5);
      filter.connect(env);
      env.connect(celebBus);
      env.connect(chimeSend);

      for (const note of ['F3', 'A3', 'C4', 'G4']) {
        for (const det of [-8, 8]) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = freqOf(note);
          osc.detune.value = det + rand(-3, 3);
          const g = ctx.createGain();
          g.gain.value = 0.09;
          osc.connect(g);
          g.connect(filter);
          osc.start(t);
          osc.stop(t + 12);
          celebrationSources.push(osc);
        }
      }

      // 缓慢的音量起伏
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.012;
      lfo.connect(lfoGain);
      lfoGain.connect(env.gain);
      lfo.start(t);
      lfo.stop(t + 12);
      celebrationSources.push(lfo);
    } catch (_) {
      /* ignore */
    }

    // 上行琶音（音乐盒音色）
    const arpA = ['F4', 'A4', 'C5', 'F5', 'A5', 'C6'];
    arpA.forEach((n, i) => {
      playMusicBox(freqOf(n), t + 0.15 + i * 0.105, 1.1, 0.6, {
        gain: 0.2,
        pan: i % 2 === 0 ? -0.28 : 0.28,
        bus: celebBus,
      });
    });
    const arpB = ['F5', 'A5', 'C6', 'F6'];
    arpB.forEach((n, i) => {
      playMusicBox(freqOf(n), t + 1.35 + i * 0.09, 1.2, 0.42, {
        gain: 0.14,
        pan: i % 2 === 0 ? 0.32 : -0.32,
        bus: celebBus,
      });
    });

    // 风铃：散落在 6 秒内，带一点随机
    const chimeNotes = ['F5', 'G5', 'A5', 'C6', 'D6', 'F6', 'A6'];
    const strikes = 11;
    for (let i = 0; i < strikes; i++) {
      const n = chimeNotes[(Math.random() * chimeNotes.length) | 0];
      playChime(freqOf(n), t + rand(0.5, 5.8), rand(0.3, 0.75), rand(-0.7, 0.7), {
        gain: 0.06,
        ring: rand(2.0, 3.2),
        bus: celebBus,
        track: true,
      });
    }

    // 6 秒后自然回落：弦乐在 8.5s 后开始收，11.5s 结束
    celebrationCleanup = setTimeout(() => {
      celebrateOn = false;
      try {
        celebBus.gain.cancelScheduledValues(now());
        celebBus.gain.setValueAtTime(celebBus.gain.value, now());
        celebBus.gain.linearRampToValueAtTime(0, now() + 1.5);
      } catch (_) {
        /* ignore */
      }
      setMusicGain(MUSIC_LEVEL, 2.0);
      celebrationCleanup = 0;
      celebrationSources = [];
    }, 9000);
  }

  // -------------------------------------------------------------------------
  // 公共接口
  // -------------------------------------------------------------------------

  function start() {
    if (disposed || failed) return;
    started = true;
    try {
      if (!ctx) {
        const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (!AC) {
          failed = true;
          publish();
          return;
        }
        ctx = new AC();
        buildGraph();
        startAmbience();
      }
      safeResume();
      startAmbience();
    } catch (_) {
      // 自动播放/设备异常：静默失败，不报错
      failed = true;
      ctx = null;
    }
    publish();
  }

  function reveal() {
    if (disposed || failed) return;
    if (!ctx) return; // 必须在 start()（用户手势）之后
    safeResume();
    if (!musicOn) startMusic(0.55);
    sfxReveal();
  }

  function blow() {
    if (disposed || !ctx) return;
    safeResume();
    sfxBlow();
  }

  function celebrate() {
    if (disposed || !ctx) return;
    safeResume();
    sfxCelebrate();
  }

  function wish() {
    if (disposed || !ctx) return;
    safeResume();
    sfxWish();
  }

  function click() {
    if (disposed || !ctx) return;
    sfxClick();
  }

  function toggleMute() {
    muted = !muted;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
    if (ctx && master) {
      const t = now();
      try {
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(muted ? 0 : MASTER_LEVEL, t + 0.18);
      } catch (_) {
        master.gain.value = muted ? 0 : MASTER_LEVEL;
      }
    }
    publish();
    return muted;
  }

  function isMuted() {
    return muted;
  }

  function reset() {
    if (disposed) return;
    stopMusic();
    if (ctx) {
      const t = now();
      try {
        musicBus.gain.cancelScheduledValues(t);
        musicBus.gain.setValueAtTime(musicBus.gain.value, t);
        musicBus.gain.linearRampToValueAtTime(0, t + 0.45);
        celebBus.gain.cancelScheduledValues(t);
        celebBus.gain.setValueAtTime(celebBus.gain.value, t);
        celebBus.gain.linearRampToValueAtTime(0, t + 0.45);
      } catch (_) {
        /* ignore */
      }
      stopCelebration(false);
      celebrateOn = false;
      musicStarted = false;
      musicGainTarget = MUSIC_LEVEL;
      if (celebrationCleanup) {
        clearTimeout(celebrationCleanup);
        celebrationCleanup = 0;
      }
    }
    publish();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopMusic();
    stopCelebration(true);
    if (celebrationCleanup) {
      clearTimeout(celebrationCleanup);
      celebrationCleanup = 0;
    }
    try {
      if (vinylNodes) {
        vinylNodes.vinyl.stop();
        vinylNodes.hiss.stop();
      }
    } catch (_) {
      /* ignore */
    }
    if (ambience) {
      for (const osc of ambience.oscs) {
        try {
          osc.stop();
        } catch (_) {
          /* ignore */
        }
      }
      ambience = null;
    }
    if (ctx) {
      try {
        const c = ctx;
        ctx = null;
        if (c.state !== 'closed' && typeof c.close === 'function') {
          const p = c.close();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (_) {
        ctx = null;
      }
    }
    publish();
  }

  function debug() {
    return {
      ctxState: ctx ? ctx.state : 'none',
      muted,
      started,
      notes: notesScheduled,
      music: musicOn,
      level: +updateLevel().toFixed(4),
      celeb: celebrateOn,
    };
  }

  publish();
  return {
    start,
    reveal,
    blow,
    celebrate,
    wish,
    click,
    toggleMute,
    isMuted,
    reset,
    dispose,
    debug,
  };
}
