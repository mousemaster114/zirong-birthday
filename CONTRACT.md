# 模块契约 · CONTRACT

> 本文件是并行开发的唯一接口约定。**不要擅改函数签名、事件名、DOM id**。
> 所有模块只通过 `js/bus.js` 通信。改动契约需先在 Team 任务里说明。

## 0. 目录与写入范围

| 角色 | 拥有文件（只能写这些） |
| --- | --- |
| Lead | `index.html`、`styles.css`、`js/bus.js`、`js/ui.js`、`js/main.js`、`assets/**`、`README.md`、`DESIGN.md`、`.nojekyll`、`.gitignore` |
| scene-artisan | `js/scene.js` |
| sound-fx | `js/audio.js`、`js/fx.js` |

本地测试页、截图、脚本统一放 `qa/`（已 gitignore），不算交付文件。

## 1. 全局状态（bus.js）

```js
state = {
  phase: 'intro' | 'reveal' | 'lit' | 'blowing' | 'celebrate' | 'wish',
  muted: false,
  started: false,
  celebrated: false,
  reducedMotion: false,
  quality: 'high' | 'low'
}

setPhase(phase)   // 更新 state.phase 并 emit('phase', phase)
setMuted(bool)    // 更新 state.muted 并 emit('muted', bool)
bus.on(event, fn) // 返回取消函数
bus.emit(event, payload)
```

阶段流转（main.js 负责）：

```
intro --ui:enter--> reveal --scene:revealed--> lit
lit --ui:blow--> blowing --scene:blown--> celebrate
celebrate --ui:wish--> wish --ui:wish-close--> celebrate
any --ui:replay--> intro   (scene.reset / fx.reset / audio.reset)
```

## 2. scene.js

```js
export function createBirthdayScene(container: HTMLElement): SceneHandle | null
```

- `container` 是 `#scene-root`，尺寸为整个视口，scene 内部自己建 `<canvas>` 并处理 resize / DPR。
- WebGL 不可用时返回 `null`，并设置 `window.__BD_SCENE_FAILED__ = true`；main 显示静态兜底。
- 就绪时设置 `window.__BD_SCENE_READY__ = true` 并 `bus.emit('scene:ready')`。

```ts
interface SceneHandle {
  reveal(): Promise<void>;      // 掀盖 + 依次点灯；完成后 emit('scene:revealed') 并 resolve
  blow(): Promise<void>;        // 火焰熄灭 + 烛烟 + 镜头轻推；完成后 emit('scene:blown') 并 resolve
  celebrate(): Promise<void>;   // 黄铜 HAPPY BIRTHDAY 字牌升起 + 3D 光尘；完成后 emit('scene:celebrated')
  wishMode(on: boolean): void;  // 许愿卡打开时场景轻微压暗/减速（可选实现）
  relight(): Promise<void>;     // 蜡烛重新点亮、字牌落下（“再看一次”的中间态可用）
  reset(): Promise<void>;       // 回到 intro：餐盖合上、蜡烛灭、灯牌隐藏、镜头回位
  setReducedMotion(v: boolean): void;
  dispose(): void;
  debug(): { fps: number, phase: string, calls: number, triangles: number, dpr: number };
}
```

实现要求：

- 导入 `import * as THREE from 'three'`，本地 importmap 已配置；不得新增 CDN 依赖。
- 渲染循环自己维护；`reveal/blow/celebrate/reset` 幂等，重复调用不报错。
- 音频由 main 调用，scene 不碰 audio。
- 相机 / OrbitControls：拖拽旋转、滚轮缩放；触屏单指旋转、双指缩放。intro 时慢速自转；交互后暂停，静止 5s 再恢复。
- 允许场景用 `container.clientWidth/clientHeight` 决定移动端构图（竖屏时相机拉远、蛋糕下移一点）。
- 性能降级：`renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))`，移动端 1.5；若 4 秒平均 fps < 40，则降 DPR 至 1、关闭阴影，只降一次。
- `debug()` 返回实时数据供 QA 读取。

## 3. fx.js

```js
export function createFx(canvas: HTMLCanvasElement): FxHandle
```

```ts
interface FxHandle {
  start(): void;            // 进入主场景后启动环境金尘
  revealPuff(): void;       // 掀盖雾气（屏幕中部偏上）
  candleSmoke(): void;      // 吹灭后的烛烟（屏幕中心）
  celebrate(): void;        // 金箔雨 + 烟花 + 星芒，约 6s
  wishBurst(): void;        // 打开许愿卡时的细小星尘
  reset(): void;            // 清空所有粒子
  setReducedMotion(v: boolean): void;
  dispose(): void;
}
```

- canvas 由 index.html 提供（`#fx`，fixed inset 0，`pointer-events:none`，z-index 高于 3D、低于 HUD）。
- 自己处理 DPR（上限 2）与 resize；使用 Canvas2D。
- 粒子配色只用：`#F2DCA8 / #D8B678 / #F6EFE3 / #FFB45C / #8FA28C`，少量 `#6B2430`；禁止彩虹色。
- 烟花要「暖金细线 + 拖尾」，不是粗圆点；金箔是有厚度的矩形片，带翻转高光。
- `prefers-reduced-motion` 时 `celebrate()` 只保留少量飘落，不得有高频闪烁。

## 4. audio.js

```js
export function createAudio(): AudioHandle
```

```ts
interface AudioHandle {
  start(): void;          // 用户手势内调用：创建/resume AudioContext，开始压低的环境垫音
  reveal(): void;         // 掀盖 whoosh + sparkle；开始音乐盒《生日快乐》
  blow(): void;           // 吹气声；音乐短暂 duck
  celebrate(): void;      // 庆祝层加入（弦乐 pad / 琶音 / 风铃），音乐继续
  wish(): void;           // 纸页 + 风铃
  click(): void;          // UI 轻响
  toggleMute(): boolean;  // 返回新 muted 值；同步 localStorage('zr_muted')
  isMuted(): boolean;
  reset(): void;          // 停止音乐与庆祝层，回到初始（保留 AudioContext）
  dispose(): void;
  debug(): { ctxState: string, muted: boolean, started: boolean };
}
```

- 所有声音 WebAudio 合成，**不得**请求任何音频文件 / 外部 CDN。
- 无用户手势前不得 `new AudioContext()` 或 resume（允许在 start() 里做）；自动播放限制下必须静默失败，不能报错。
- 关键：`start()` 和 `reveal()` 可能在同一手势栈里背靠背调用；要保证只初始化一次。
- 音量克制（master ≈ 0.18–0.24），听感是「隔壁房间传来的音乐盒」，不是游戏 BGM。
- 明确暴露 `window.__ZR_AUDIO__ = { ctxState, started, muted }` 供 QA 读取（每次状态变化更新）。

## 5. UI（Lead 实现，供 main/scene 参考的 DOM）

稳定 id / class（不要依赖不存在节点）：

```
#scene-root        3D 容器（fixed, inset:0, z-index:0）
#fx                2D 特效 canvas（fixed, inset:0, z-index:3, pointer-events:none）
#intro             入场页（含 #btn-enter）
#hud-top           顶部栏（含 #btn-sound、#today-date）
#hud-main          主标题块（.hero__name == 黄子荣, .hero__sub）
#hud-bottom        底部操作（#btn-blow、#btn-wish、#btn-replay、.hint）
#wish              许愿卡弹层（.wish__card，关闭 #btn-wish-close / [data-wish-close]）
#toast             轻提示
#boot-fallback     兜底页（WebGL 失败/加载超时）
```

UI 发出的意图事件：

| 事件 | 触发 |
| --- | --- |
| `ui:enter` | 点「掀开餐盖」 |
| `ui:blow` | 点「吹灭蜡烛」/ 空格 |
| `ui:wish` | 点「许个愿」 |
| `ui:wish-close` | 关闭许愿卡 |
| `ui:replay` | 点「再看一次」 |
| `ui:sound-toggle` | 点音乐按钮 |
| `ui:first-interaction` | 首次任意点击（用于解锁音频） |

UI 监听 `phase` 变化来切换可见性 / disabled / aria。main.js 不直接操作 UI DOM。

## 6. 3D 视觉常量（与 DESIGN.md 对齐）

```
背景 / 墙      #04100B / #0C241A / #153B2C
奶油           #F6EFE3 / #FFFBF2
香槟金         #D8B678 / #F2DCA8 / #9A7038
烛光           #FFB45C
浆果           #6B2430
开心果奶油     #8FA28C
冷月光         #9FC3D9
```

## 7. 本地运行 / 自测

在项目根目录（`zirong-birthday/`）：

```powershell
python -m http.server 8090
# 打开 http://127.0.0.1:8090/
```

如果 index.html 还没写好，可以在 `qa/` 下自建测试页（已 gitignore），importmap 指向 `../vendor/three/...`。

截图 / 控制台采集：

```powershell
# Chrome 路径
C:\Program Files\Google\Chrome\Application\chrome.exe
# puppeteer-core 在 ../../qa-tools/node_modules；建议在 qa/ 下建 junction：
#   New-Item -ItemType Junction -Path "qa\node_modules" -Target "..\..\qa-tools\node_modules"
node qa\shot.mjs http://127.0.0.1:8090/ qa\out.png 1440 900 4000
```

截图必须用 `read_image` 亲眼看过再判断，不要只看日志。

## 8. 完成定义（Definition of Done）

- [ ] 自己负责的文件里没有 `TODO` / 占位假数据；所有公开方法有实现。
- [ ] 本地通过 HTTP 打开无 console error / pageerror；直接 `file://` 不作为验收环境。
- [ ] 桌面 + 移动尺寸截图各至少 1 张，亲眼确认构图与可读性。
- [ ] 把实现要点、已知问题、验收结果写进 Team 任务完成说明。
