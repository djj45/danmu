/**
 * danmaku.js — 高性能 Canvas 弹幕引擎（对标 B 站的丝滑手感）
 *
 * 丝滑的关键设计：
 *  1. Canvas 渲染而非 DOM：上千条弹幕也没有 layout/style/paint 开销
 *  2. 位置由时钟推导 x(t) = W - v·(t - t0)，不做逐帧增量积分
 *     → 暂停、seek、切后台再回来，位置永远和时间轴精确一致，零漂移
 *  3. 单一 requestAnimationFrame 渲染循环，速度与帧率无关；暂停且无事可做时循环停掉，事件再唤醒
 *  4. 画布按 devicePixelRatio 放大，Retina 屏上文字锐利不发虚
 *  5. 轨道(lane)分配 + "追尾"碰撞判定：长弹幕速度更快，不允许在途中追上前车
 *  6. 每条弹幕预渲染成离屏 sprite（描边+填充只画一次），主循环里只 drawImage；
 *     文字+颜色+字号相同的弹幕共用一张 sprite（引用计数），刷屏的"哈哈哈"只画一次
 *  7. 空闲时间里提前光栅化即将上屏的弹幕，派发时直接命中缓存，不挤占渲染帧
 *  8. sprite 画布复用 + 弹幕对象池：热路径零对象分配，避免 GC 造成的掉帧卡顿
 *  9. 画布外的弹幕直接剔除不绘制；先量宽度、确定有空轨道才光栅化，丢弃的弹幕不浪费渲染
 * 10. 实时推送先进队列再匀速放出：论坛轮询一次来一批，也不会排成一竖排同时上屏
 */
export const DanmakuMode = { SCROLL: 1, BOTTOM: 4, TOP: 5 };

const DEFAULT_FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';
/** sprite 离屏画布最多 2x 缩放：清晰度足够，内存省一半以上 */
const SPRITE_DPR_CAP = 2;
/** B 站弹幕数据里的"标准"字号；item.fontsize 按它的比例跟随用户设置的字号缩放 */
const BASE_FONT_SIZE = 25;

/* 推送队列：令牌桶匀速放出，积压越多放得越快，但不会快过轨道的接纳能力 */
const PENDING_SPREAD = 3;    // 秒：把当前积压大致摊到这么长时间里放完
const PENDING_MIN_RATE = 6;  // 条/秒：积压很少时的最低放出速率
const PENDING_TTL = 8;       // 秒：排队超过这么久的已经不"实时"了，直接丢弃
const PENDING_MAX = 300;     // 队列上限，超出丢最旧的

/** 没人用的 sprite 最多留这么多张（LRU），给之后同样内容的弹幕和预渲染用 */
const IDLE_SPRITES_MAX = 128;
/* 空闲时预渲染的范围 */
const PRERENDER_AHEAD = 2;   // 秒：时间轴往后看多远
const PRERENDER_MAX = 48;    // 时间轴预渲染最多领先派发游标多少条
const PRERENDER_QUEUE = 8;   // 推送队列最多预热前多少条（轨道一秒也就收十来条，再多是白画）

/** Safari 没有 requestIdleCallback：退化成定时器 + 固定 4ms 预算 */
const requestIdle = globalThis.requestIdleCallback?.bind(globalThis)
  ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 4 }), 50));

/** 这些 video 事件会唤醒停掉的渲染循环 */
const MEDIA_WAKE_EVENTS = ['play', 'playing', 'seeked'];

class SpritePool {
  constructor() { this.free = []; }

  /** 取一个至少 pw×ph 的画布；有可复用的就不重新分配 */
  acquire(cw, ch, dpr) {
    const pw = Math.ceil(cw * dpr), ph = Math.ceil(ch * dpr);
    let best = -1;
    for (let k = 0; k < this.free.length; k++) {
      const c = this.free[k];
      if (c.width >= pw && c.height >= ph && (best < 0 || c.width < this.free[best].width)) best = k;
    }
    if (best >= 0) return this.free.splice(best, 1)[0];
    const c = document.createElement('canvas');
    c.width = pw; c.height = ph;
    return c;
  }

  release(canvas) {
    this.free.push(canvas);
    if (this.free.length > 48) {
      // 池子满了优先留小的，丢弃最大的空闲画布
      this.free.sort((a, b) => a.width * a.height - b.width * b.height);
      this.free.length = 48;
    }
  }
}

export class DanmakuEngine {
  /**
   * @param container 播放器容器（canvas 会插入其中并铺满）
   * @param video    关联的 video 元素，时间轴模式用它取 currentTime
   */
  constructor(container, video, opts = {}) {
    this.container = container;
    this.video = video;
    this.fontSize = opts.fontSize ?? 25;
    this.lineHeight = Math.ceil(this.fontSize * 1.3);
    this.opacity = opts.opacity ?? 1;
    this.speedRate = opts.speedRate ?? 1;
    this.baseDuration = opts.baseDuration ?? 8.5; // 1x 速度下滚过整个画面所需秒数
    this.area = opts.area ?? 1;                   // 显示区域占画面高度的比例
    this.maxActive = opts.maxActive ?? 3000;
    this.fontFamily = opts.fontFamily ?? DEFAULT_FONT;
    /** 满屏时允许重叠：放不下的弹幕叠到最快腾出来的轨道上，而不是丢弃/排队 */
    this.overlap = opts.overlap ?? false;
    this.visible = true;

    /** 'timeline' 跟随视频时间轴（点播）；'live' 跟随可暂停的墙上时钟（直播/外部推送） */
    this.mode = 'timeline';
    /** 是否派发时间轴弹幕（B站样本等预置数据）；关闭后 push 的实时弹幕不受影响 */
    this.timelineEnabled = true;
    this.list = [];
    this.idx = 0;
    this.active = [];
    this.stats = { fps: 0, active: 0, pending: 0, displayed: 0, dropped: 0 };
    /** 引擎会以 ~4Hz 回调统计数据（FPS、屏上数量等） */
    this.onStats = null;

    this._pool = [];
    this._scrollLanes = [];
    this._topLanes = [];
    this._bottomLanes = [];
    this._liveShift = 0;
    this._liveFrozenAt = null;
    this._lastT = 0;
    this._lastFrameTs = 0;
    this._fpsEma = 60;
    this._statsTick = 0;
    this._dirty = true;
    this._blank = true;          // 画布当前是否已是空白（空屏时不再每帧 clearRect）
    this._measureFont = null;    // this.ctx 上一次设置的 font，避免重复解析字体串
    this._pending = [];          // push 进来、等待上屏的弹幕（已量好宽度）
    this._tokens = 1;
    this._drainAt = performance.now() / 1000;
    this._queueDropAt = -Infinity;  // 队列上次因溢出/过期丢弃的时间（秒）
    this._spriteCache = new Map();  // key → sprite，正在用的和空闲的都在
    this._idleSprites = new Map();  // 引用数为 0 的 sprite，按释放先后排列（LRU）
    this._preIdx = 0;               // 时间轴预渲染游标
    this._preScheduled = false;
    this._rafId = 0;
    this._destroyed = false;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'danmaku-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._sprites = new SpritePool();

    this._loop = (ts) => this._frame(ts);
    this._onMediaEvent = () => this._wake();
    if (video) for (const ev of MEDIA_WAKE_EVENTS) video.addEventListener(ev, this._onMediaEvent);
    this._onResize = () => this.resize();
    this._ro = new ResizeObserver(this._onResize);
    this._ro.observe(container);
    this.resize();
  }

  /* ------------------------------------------------------------ 时钟 */

  /** 弹幕位置的唯一时间来源 */
  clock() {
    if (this.mode === 'live') {
      return this._liveFrozenAt ?? performance.now() / 1000 - this._liveShift;
    }
    return this.video ? this.video.currentTime : 0;
  }

  /** 直播模式下暂停时也要冻结弹幕（配合 video 的 pause 事件调用） */
  freezeLiveClock() {
    if (this._liveFrozenAt == null) this._liveFrozenAt = this.clock();
  }

  unfreezeLiveClock() {
    if (this._liveFrozenAt != null) {
      this._liveShift += performance.now() / 1000 - this._liveFrozenAt;
      this._liveFrozenAt = null;
      this._markDirty();
    }
  }

  /* ------------------------------------------------------------ 数据 */

  /** 载入点播弹幕列表（按 time 升序），会自动定位到视频当前时间 */
  loadTimeline(items) {
    this.list = items.slice().sort((a, b) => a.time - b.time);
    this.seek(this.video ? this.video.currentTime : 0);
  }

  setMode(mode) {
    this.mode = mode;
    this.clear();
    if (mode === 'timeline') this.seek(this.video ? this.video.currentTime : 0);
  }

  /**
   * 实时推送一条弹幕（直播/论坛回复接入口）。
   * 不直接上屏而是先排队：空闲时第一条立即上屏，一批同时到达的按令牌桶匀速放出，
   * 有空轨道才上屏，排队超过 PENDING_TTL 秒的丢弃。返回是否被接收（已上屏或在排队）。
   */
  push(item) {
    if (!this.visible) { this.stats.dropped++; return false; }
    const p = this._prepare(item);
    if (!p) return false;
    p.at = performance.now() / 1000;
    const q = this._pending;
    q.push(p);
    if (q.length > PENDING_MAX) { q.shift(); this.stats.dropped++; this._queueDropAt = p.at; }
    this._drainPending(this._playing());
    this._wake(); // 暂停时循环是停着的：跑一帧把排队数报上去
    return true;
  }

  /** 每帧调用：按令牌桶从队头放出弹幕；没空轨道时保持先后顺序，下一帧再试 */
  _drainPending(playing) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.25, now - this._drainAt);
    this._drainAt = now;
    const q = this._pending;
    // 桶容量 1：空闲后的第一条立即上屏；积压时速率 = 积压量 / 摊开时长
    const rate = Math.max(PENDING_MIN_RATE, q.length / PENDING_SPREAD);
    this._tokens = Math.min(1, this._tokens + dt * rate);
    while (q.length) {
      const p = q[0];
      if (now - p.at > PENDING_TTL) { q.shift(); this.stats.dropped++; this._queueDropAt = now; continue; }
      if (!playing || this._tokens < 1 || !this._place(p, 'push')) break;
      q.shift();
      this._tokens -= 1;
    }
  }

  /** 内部：时间轴派发入口，标记来源便于按来源开关 */
  _dispatchTimeline(item) {
    this.dispatch(item, 'timeline');
  }

  /** seek 后调用：清屏并把游标二分定位到新时间 */
  seek(t) {
    this.clear();
    const list = this.list;
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time < t - 0.001) lo = mid + 1; else hi = mid;
    }
    this.idx = this._preIdx = lo;
    this._lastT = t;
    this._markDirty();
  }

  clear() {
    for (let k = this.active.length - 1; k >= 0; k--) this._recycle(k);
    this._markDirty();
  }

  /* ------------------------------------------------------------ 设置 */

  setOpacity(v) { this.opacity = Math.min(1, Math.max(0, v)); this._markDirty(); }
  setVisible(b) {
    this.visible = b;
    if (!b) { this.clear(); this._pending.length = 0; }
    this._markDirty();
  }

  /** 满屏时是否允许重叠（B 站的"防挡弹幕"反过来）；只影响之后上屏的弹幕 */
  setOverlap(b) { this.overlap = !!b; }

  /** 开关时间轴（预置样本）弹幕：关闭时把屏上的时间轴弹幕一并清掉，push 的实时弹幕保留 */
  setTimelineEnabled(b) {
    this.timelineEnabled = b;
    if (!b) {
      for (let k = this.active.length - 1; k >= 0; k--) {
        if (this.active[k].origin === 'timeline') this._recycle(k);
      }
    } else {
      // 重新开启时游标可能落后很多，seek 一次跳到当前时间，避免补发
      if (this.mode === 'timeline') this.seek(this.video ? this.video.currentTime : 0);
    }
    this._markDirty();
  }

  /** 速度倍率改变时按当前画面位置无损换算，不跳变 */
  setSpeedRate(rate) {
    if (!(rate > 0) || rate === this.speedRate) return;
    const ratio = rate / this.speedRate;
    const t = this.clock(), W = this.width;
    for (const it of this.active) {
      if (it.mode !== DanmakuMode.SCROLL) continue;
      const x = W - it.v * (t - it.t0);
      it.v *= ratio;
      it.t0 = t - (W - x) / it.v;
    }
    this.speedRate = rate;
    this._markDirty();
  }

  setFontSize(v) {
    this.fontSize = v;
    this.lineHeight = Math.ceil(v * 1.3);
    this._rebuildLanes();
  }

  setArea(a) {
    this.area = Math.min(1, Math.max(0.1, a));
    this._rebuildLanes();
  }

  /* ------------------------------------------------------------ 布局 */

  resize() {
    const rect = this.container.getBoundingClientRect();
    const W = Math.max(50, Math.round(rect.width));
    const H = Math.max(50, Math.round(rect.height));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (W === this.width && H === this.height && dpr === this.dpr) return; // 尺寸没变就不重建画布
    const oldW = this.width;
    this.width = W; this.height = H; this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 改画布尺寸会重置 context 状态
    this._measureFont = null;
    this._blank = true;
    this._rebuildLanes();
    if (oldW) {
      // 屏上已有的弹幕跟着新尺寸重新布局：否则进出全屏时滚动弹幕整体跳 ΔW、底部弹幕悬在半空
      const dW = W - oldW;
      for (const it of this.active) {
        if (it.mode === DanmakuMode.SCROLL) it.t0 -= dW / it.v; // x = W - v(t-t0) 保持不变
        else it.x = Math.max(0, (W - it.w) / 2);
        it.y = this._laneY(it.mode, it.lane, it.sprite.ch);
      }
    }
    this._markDirty();
  }

  _rebuildLanes() {
    const n = Math.max(1, Math.floor((this.height * this.area) / this.lineHeight));
    for (const lanes of [this._scrollLanes, this._topLanes, this._bottomLanes]) {
      if (lanes.length > n) lanes.length = n;
      while (lanes.length < n) lanes.push(null);
    }
    // 被删掉的轨道上的弹幕失去了碰撞跟踪，留着会和之后的新弹幕叠在一起，直接回收
    for (let k = this.active.length - 1; k >= 0; k--) {
      if (this.active[k].lane >= n) this._recycle(k);
    }
    this._markDirty();
  }

  /** sprite 在轨道内垂直居中（sprite 高度已含行距，文字在 sprite 内居中） */
  _laneY(mode, lane, ch) {
    const off = (this.lineHeight - ch) >> 1;
    return mode === DanmakuMode.BOTTOM
      ? this.height - (lane + 1) * this.lineHeight + off
      : lane * this.lineHeight + off;
  }

  /* ------------------------------------------------------------ 渲染循环 */

  _markDirty() {
    this._dirty = true;
    this._wake();
  }

  /** 循环停着就重新挂上；已经在跑则什么都不做 */
  _wake() {
    if (this._rafId || this._destroyed) return;
    this._rafId = requestAnimationFrame(this._loop);
  }

  _frame(ts) {
    this._rafId = 0;
    if (this._lastFrameTs) {
      const dt = ts - this._lastFrameTs;
      if (dt > 0 && dt < 500) this._fpsEma += (1000 / dt - this._fpsEma) * 0.08;
    }
    this._lastFrameTs = ts;

    const t = this.clock();
    const playing = this._playing();

    if (this.mode === 'timeline' && playing && this.timelineEnabled) {
      if (Math.abs(t - this._lastT) > 2) {
        this.seek(t); // 兜底：没监听到的跳变（HLS 换档等）按 seek 处理
      } else {
        const list = this.list;
        while (this.idx < list.length && list[this.idx].time <= t) {
          const item = list[this.idx++];
          // 落后太多的直接跳过，避免补发风暴；和 B 站行为一致
          if (t - item.time < 0.3) this._dispatchTimeline(item);
        }
      }
    }
    this._lastT = t;
    this._drainPending(playing);

    if (playing || this._dirty) {
      this._draw(t);
      this._dirty = false;
    }
    if (playing) this._schedulePrerender();

    // 暂停/冻结且没有要重画的东西：不再挂下一帧，等事件或 API 调用唤醒
    const running = playing || this._dirty;
    if (running) this._wake();
    else this._lastFrameTs = 0; // 下次唤醒时别把停住的时长算进 FPS

    this.stats.fps = Math.round(this._fpsEma);
    this.stats.active = this.active.length;
    this.stats.pending = this._pending.length;
    if (this.onStats && (!running || ts - this._statsTick > 250)) {
      this._statsTick = ts;
      this.onStats({ ...this.stats });
    }
  }

  /** 弹幕是否在走：直播看可冻结的墙上时钟，点播看视频播放状态 */
  _playing() {
    return this.mode === 'live'
      ? this._liveFrozenAt == null
      : !!this.video && !this.video.paused && !this.video.ended;
  }

  _draw(t) {
    const ctx = this.ctx, W = this.width, act = this.active;
    if (!act.length) {
      // 空屏只清一次：之后不再碰画布，画布层不被标脏，合成器就不用每帧重新提交它
      if (!this._blank) { ctx.clearRect(0, 0, W, this.height); this._blank = true; }
      return;
    }
    ctx.clearRect(0, 0, W, this.height);
    this._blank = false;
    if (!this.visible) return;
    ctx.globalAlpha = this.opacity;
    for (let k = act.length - 1; k >= 0; k--) {
      const it = act[k];
      if (it.mode === DanmakuMode.SCROLL) {
        const x = W - it.v * (t - it.t0);
        if (x + it.w < 0) { this._recycle(k); continue; } // 完全出场，回收
        it.x = x;
        if (x >= W) continue; // 还没进场，不用画
      } else if (t > it.expire) {
        this._recycle(k);
        continue;
      }
      const s = it.sprite;
      ctx.drawImage(s.canvas, 0, 0, s.cw * s.dpr, s.ch * s.dpr, it.x - s.pad, it.y, s.cw, s.ch);
    }
  }

  _recycle(k) {
    const act = this.active, it = act[k];
    act[k] = act[act.length - 1];
    act.pop();
    const lanes = it.mode === DanmakuMode.SCROLL ? this._scrollLanes
      : it.mode === DanmakuMode.TOP ? this._topLanes : this._bottomLanes;
    if (lanes[it.lane] === it) lanes[it.lane] = null;
    this._releaseSprite(it.sprite);
    it.sprite = null;
    this._pool.push(it);
  }

  /* ------------------------------------------------------------ 弹幕分配 */

  /** 立即上屏一条弹幕（不排队），放不下就丢弃 */
  dispatch(item, origin = 'push') {
    const p = this._prepare(item);
    if (p && !this._place(p, origin)) this.stats.dropped++;
  }

  /**
   * 规范化 + 量宽度（还不光栅化）；空文本或宽得离谱的返回 null。
   * quiet：预渲染时调用，不计入丢弃统计（真正派发时会再算一次）
   */
  _prepare(item, quiet = false) {
    let text = (item.text ?? '').trim();
    if (!text) return null;
    if (text.length > 80) text = text.slice(0, 80);
    const m = item.mode;
    // B 站的 2/3（旧滚动）、6（逆向）等都按普通滚动处理
    const mode = m === DanmakuMode.TOP || m === DanmakuMode.BOTTOM ? m : DanmakuMode.SCROLL;
    // 数据自带的字号按 25 为基准跟随用户设置缩放；上限是轨道字号，否则会压到相邻轨道
    const scaled = Math.round(this.fontSize * (item.fontsize ?? BASE_FONT_SIZE) / BASE_FONT_SIZE);
    const fontSize = Math.min(this.fontSize, Math.max(12, scaled));
    const color = item.color ?? '#ffffff';
    const key = `${Math.min(SPRITE_DPR_CAP, this.dpr)}|${fontSize}|${color}|${text}`;
    const font = `600 ${fontSize}px ${this.fontFamily}`;
    let w = this._spriteCache.get(key)?.textW; // 画过同样的就连 measureText 都省了
    if (w === undefined) {
      if (this._measureFont !== font) { this.ctx.font = font; this._measureFont = font; }
      w = Math.ceil(this.ctx.measureText(text).width);
    }
    if (!(w > 0) || w > this.width * 2) { if (!quiet) this.stats.dropped++; return null; }
    return { text, mode, fontSize, font, w, color, key, at: 0 };
  }

  /** 找轨道，找到了才取 sprite 上屏；没有空轨道返回 false（不允许重叠时 sprite 一次都不画） */
  _place(p, origin) {
    if (!this.visible || this.active.length >= this.maxActive) return false;
    const t = this.clock(), W = this.width, mode = p.mode;
    const lanes = mode === DanmakuMode.SCROLL ? this._scrollLanes
      : mode === DanmakuMode.TOP ? this._topLanes : this._bottomLanes;
    let lane, v = 0;
    if (mode === DanmakuMode.SCROLL) {
      // 走完整个画面用时固定 baseDuration/speedRate → 文字越长速度越快，同一轨道不会追尾
      v = (W + p.w) / (this.baseDuration / this.speedRate);
      lane = this._pickScrollLane(p.w, v, t);
      if (lane < 0 && this.overlap) lane = this._leastBusyScrollLane(t);
    } else {
      lane = this._pickFixedLane(lanes, t);
      if (lane < 0 && this.overlap) lane = this._leastBusyFixedLane(lanes);
    }
    if (lane < 0) return false;

    const sprite = this._acquireSprite(p);
    const it = this._pool.pop() ?? {};
    it.mode = mode; it.sprite = sprite; it.w = p.w; it.fontSize = p.fontSize;
    it.origin = origin; it.v = v; it.t0 = t; it.lane = lane;
    it.y = this._laneY(mode, lane, sprite.ch);
    if (mode === DanmakuMode.SCROLL) {
      it.x = W;
    } else {
      it.expire = t + 5;
      it.x = Math.max(0, (W - p.w) / 2);
    }
    lanes[lane] = it;
    this.active.push(it);
    this.stats.displayed++;
    this._markDirty();
    return true;
  }

  _pickFixedLane(lanes, t) {
    for (let k = 0; k < lanes.length; k++) {
      if (!lanes[k] || t >= lanes[k].expire) return k;
    }
    return -1;
  }

  /**
   * 选一条不会和前车重叠的滚动轨道。
   * 两条弹幕都是匀速运动，追尾只可能发生在"新车更快"时：
   *   追上时刻 = 初始间距 / 速度差，只要追上时任意一方已完全出场即可安全入轨。
   */
  _pickScrollLane(w, v, t) {
    const W = this.width, lanes = this._scrollLanes;
    for (let i = 0; i < lanes.length; i++) {
      const prev = lanes[i];
      if (!prev) return i;
      const prevX = W - prev.v * (t - prev.t0);
      const gap = W - (prevX + prev.w);
      if (gap < 4) continue; // 前车还没完全进场
      if (v <= prev.v) return i;
      const catchUpAt = gap / (v - prev.v);
      if (catchUpAt > (W + w) / v) return i;          // 我先出场
      if (catchUpAt > (prevX + prev.w) / prev.v) return i; // 前车先出场
    }
    return -1; // 全满：不允许重叠时，时间轴弹幕丢弃（B 站同样如此），推送弹幕留在队列里等下一帧
  }

  /** 允许重叠时：叠到车尾最靠左（最快腾出来）的那条滚动轨道上 */
  _leastBusyScrollLane(t) {
    const W = this.width, lanes = this._scrollLanes;
    let best = 0, bestRight = Infinity;
    for (let i = 0; i < lanes.length; i++) {
      const prev = lanes[i];
      if (!prev) return i;
      const right = W - prev.v * (t - prev.t0) + prev.w;
      if (right < bestRight) { bestRight = right; best = i; }
    }
    return best;
  }

  /** 允许重叠时：叠到最早消失的那条顶部/底部轨道上 */
  _leastBusyFixedLane(lanes) {
    let best = 0;
    for (let k = 0; k < lanes.length; k++) {
      if (!lanes[k]) return k;
      if (lanes[k].expire < lanes[best].expire) best = k;
    }
    return best;
  }

  /* ------------------------------------------------------------ sprite 缓存 */

  /** 取 p 对应的 sprite：缓存里有就引用数 +1 直接用，没有才光栅化 */
  _acquireSprite(p) {
    let s = this._spriteCache.get(p.key);
    if (s) {
      if (s.refs++ === 0) this._idleSprites.delete(p.key);
      return s;
    }
    s = this._rasterize(p);
    s.refs = 1;
    this._spriteCache.set(p.key, s);
    return s;
  }

  /** 引用数归零时不立刻回收画布，先进空闲 LRU，同样内容的弹幕再来还能直接用 */
  _releaseSprite(s) {
    if (--s.refs > 0) return;
    this._idleSprites.set(s.key, s);
    this._trimIdleSprites();
  }

  _trimIdleSprites() {
    const idle = this._idleSprites;
    while (idle.size > IDLE_SPRITES_MAX) {
      const key = idle.keys().next().value; // 最早进来的那张
      const s = idle.get(key);
      idle.delete(key);
      this._spriteCache.delete(key);
      this._sprites.release(s.canvas); // 只有引用数为 0 的画布才会还给池子，不会被别人覆盖
    }
  }

  /** 提前画好一张空闲 sprite（引用数 0），派发时直接命中 */
  _warm(p) {
    if (this._spriteCache.has(p.key)) return;
    const s = this._rasterize(p);
    s.refs = 0;
    this._spriteCache.set(p.key, s);
    this._idleSprites.set(p.key, s);
    this._trimIdleSprites();
  }

  _schedulePrerender() {
    if (this._preScheduled) return;
    this._preScheduled = true;
    requestIdle((deadline) => {
      this._preScheduled = false;
      if (!this._destroyed) this._prerender(deadline);
    });
  }

  /** 在浏览器空闲时间里，把排队中的推送和时间轴上接下来几秒的弹幕先画好 */
  _prerender(deadline) {
    const q = this._pending;
    // 最近一秒队列还在丢（溢出或过期）说明处于超载，队头多半等不到上屏，预热了也是白画
    const overloaded = performance.now() / 1000 - this._queueDropAt < 1;
    for (let k = 0; !overloaded && k < q.length && k < PRERENDER_QUEUE; k++) {
      if (deadline.timeRemaining() < 1) return;
      this._warm(q[k]);
    }
    if (this.mode !== 'timeline' || !this.timelineEnabled) return;
    const list = this.list, until = this.clock() + PRERENDER_AHEAD;
    if (this._preIdx < this.idx) this._preIdx = this.idx;
    while (this._preIdx < list.length && list[this._preIdx].time <= until
        && this._preIdx - this.idx < PRERENDER_MAX && deadline.timeRemaining() >= 1) {
      const p = this._prepare(list[this._preIdx++], true);
      if (p) this._warm(p);
    }
  }

  /** 把文字预渲染成带描边的 sprite，之后每帧只需一次 drawImage */
  _rasterize(p) {
    const { text, font, fontSize, w: textW, color } = p;
    const pad = Math.max(2, Math.ceil(fontSize / 6));
    const cw = textW + pad * 2;
    const ch = Math.ceil(fontSize * 1.3);
    const dpr = Math.min(SPRITE_DPR_CAP, this.dpr);
    const canvas = this._sprites.acquire(cw, ch, dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.font = font;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = Math.max(1, fontSize / 9);
    const y = ch / 2 + fontSize * 0.04;
    g.strokeText(text, pad, y);
    g.fillStyle = color;
    g.fillText(text, pad, y);
    return { key: p.key, refs: 0, canvas, cw, ch, dpr, pad, textW };
  }

  destroy() {
    this._destroyed = true;
    cancelAnimationFrame(this._rafId);
    this._ro.disconnect();
    if (this.video) for (const ev of MEDIA_WAKE_EVENTS) this.video.removeEventListener(ev, this._onMediaEvent);
    this.canvas.remove();
  }
}
