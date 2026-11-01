import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, beforeEach, afterEach } from 'node:test';

// 模拟时间和 Canvas，仅检查状态、几何和资源预算，不把它当浏览器性能测试。
let now = 100000, nextId = 1, rasterCost = 0;
const idle = new Map(), raf = new Map(), engines = [];
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
globalThis.window = { devicePixelRatio: 1 };
globalThis.document = {
  hidden: false,
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ width: 0, height: 0, style: {}, remove() {}, getContext() {
    return { font: '', setTransform() {}, clearRect() {}, drawImage() {}, strokeText() {},
      fillText() { now += rasterCost; },
      measureText(text) { return { width: text.length * (parseFloat(this.font.split(' ')[1]) || 25) }; } };
  } }),
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => { const id = nextId++; raf.set(id, cb); return id; };
globalThis.cancelAnimationFrame = (id) => raf.delete(id);
globalThis.requestIdleCallback = (cb) => { const id = nextId++; idle.set(id, cb); return id; };
globalThis.cancelIdleCallback = (id) => idle.delete(id);
const source = await readFile(new URL('../src/danmaku.js', import.meta.url), 'utf8');
const moduleURL = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const { DanmakuEngine, DanmakuMode: M } = await import(moduleURL);

function make(opts = {}, size = { width: 800, height: 396 }) {
  const video = { currentTime: 0, paused: false, ended: false, addEventListener() {}, removeEventListener() {} };
  const e = new DanmakuEngine({ appendChild() {}, getBoundingClientRect: () => size }, video, opts);
  engines.push(e);
  return e;
}
beforeEach(() => { now = 100000; rasterCost = 0; window.devicePixelRatio = 1; document.hidden = false; });
afterEach(() => { for (const e of engines.splice(0)) e.destroy(); idle.clear(); raf.clear(); });

test('repeated live pauses preserve the clock and positions', () => {
  const e = make(); e.setMode('live'); e.dispatch({ text: 'hello' });
  for (let i = 0; i < 3; i++) {
    now += 1000;
    const before = e.clock(); e._draw(before); const x = e.active[0].x;
    e.freezeLiveClock(); now += 10000;
    assert.equal(e.clock(), before);
    e.unfreezeLiveClock(); assert.equal(e.clock(), before);
    e._draw(e.clock()); assert.equal(e.active[0].x, x);
  }
});

test('new live sessions inherit video pause state and discard previous timing', () => {
  const e = make(); e.video.paused = true; e.setMode('live');
  assert.equal(e._playing(), false);
  now += 1000; e.video.paused = false; e.unfreezeLiveClock();
  e.setMode('timeline'); e.setMode('live');
  assert.equal(e.clock(), now / 1000);
  assert.equal(e._playing(), true);
});

test('font changes clear obsolete geometry and remeasure queued items without extending TTL', () => {
  const e = make(); e.dispatch({ text: 'visible' });
  e.video.paused = true; e.push({ text: 'pending' });
  const at = e._pending[0].at; now += 2000;
  e.setFontSize(14);
  assert.equal(e.active.length, 0);
  assert.equal(e._pending[0].fontSize, 14);
  assert.equal(e._pending[0].w, 7 * 14);
  assert.equal(e._pending[0].at, at);
  e.video.paused = false; e._drainPending(true);
  assert.equal(e.active[0].fontSize, 14);
});

test('mixed modes do not overlap vertically in either arrival order', () => {
  for (const modes of [[M.SCROLL, M.TOP, M.BOTTOM], [M.TOP, M.BOTTOM, M.SCROLL], [M.BOTTOM, M.SCROLL, M.TOP]]) {
    const e = make({}, { width: 800, height: 200 });
    for (const mode of modes) e.dispatch({ text: 'test', mode });
    assert.equal(e.active.length, 3);
    for (let i = 0; i < e.active.length; i++) for (let j = i + 1; j < e.active.length; j++) {
      const a = e.active[i], b = e.active[j];
      assert.ok(a.y + a.sprite.ch <= b.y || b.y + b.sprite.ch <= a.y);
    }
  }
});

test('mixed modes block when full, then expired occupants release their rows', () => {
  const e = make({}, { width: 800, height: 66 });
  e.dispatch({ text: 'top', mode: M.TOP }); e.dispatch({ text: 'bottom', mode: M.BOTTOM });
  e.dispatch({ text: 'blocked' });
  assert.equal(e.stats.dropReasons.noLane, 1);
  e.video.currentTime = 6; e.dispatch({ text: 'available' }); e._draw(6);
  assert.equal(e.active.length, 1);
  assert.equal(e.active[0].mode, M.SCROLL);
});

test('overlap setting permits dense mixed-mode traffic', () => {
  const e = make({ overlap: true }, { width: 800, height: 66 });
  for (let i = 0; i < 20; i++) e.dispatch({ text: String(i), mode: i % 2 ? M.TOP : M.SCROLL });
  assert.equal(e.active.length, 20);
});

test('session reset clears pending and timeline, sample toggles preserve real-time comments', () => {
  const e = make(); e.dispatch({ text: 'live' });
  e.dispatch({ text: 'sample' }, 'timeline');
  e.setTimelineEnabled(false); e.setTimelineEnabled(true);
  e.loadTimeline([{ text: 'future', time: 10 }]);
  assert.equal(e.active.length, 1); assert.equal(e.active[0].origin, 'push');
  e.video.paused = true; e.push({ text: 'queued' });
  e.resetSession();
  assert.equal(e.active.length, 0); assert.equal(e._pending.length, 0); assert.equal(e.list.length, 0);
  assert.equal(e.stats.dropReasons.reset, 1);
});

test('queue overflow and TTL are separately counted', () => {
  const e = make(); e.video.paused = true;
  for (let i = 0; i < 305; i++) e.push({ text: `queued ${i}` });
  assert.equal(e._pending.length, 300); assert.equal(e.stats.dropReasons.queueFull, 5);
  now += 9000; e._drainPending(true);
  assert.equal(e._pending.length, 0); assert.equal(e.stats.dropReasons.expired, 300);
  assert.equal(e.stats.dropped, 305);
});

test('resize refreshes queued DPR and dimensions', () => {
  const size = { width: 800, height: 396 }, e = make({}, size);
  e.video.paused = true; e.push({ text: 'queued' });
  window.devicePixelRatio = 2; size.width = 1000; e.resize();
  assert.ok(e._pending[0].key.startsWith('2|'));
  e.video.paused = false; e._drainPending(true);
  assert.equal(e.active[0].sprite.dpr, 2);
});

test('sprite sharing, memory ceilings, eviction, and destroy release backing storage', () => {
  window.devicePixelRatio = 2;
  const e = make({ overlap: true, fontSize: 72 }, { width: 3000, height: 396 });
  e.dispatch({ text: 'same' }); e.dispatch({ text: 'same' });
  assert.equal(e.active[0].sprite, e.active[1].sprite);
  const shared = e.active[0].sprite; assert.equal(shared.refs, 2);
  for (let i = 0; i < 80; i++) e.dispatch({ text: String(i).padEnd(80, 'x') });
  assert.ok(e.stats.dropReasons.memory > 0);
  assert.ok(e._spriteBytes <= 28 * 1024 * 1024);
  e.clear(); assert.equal(shared.refs, 0);
  for (let i = 80; i < 160; i++) e._warm(e._prepare({ text: String(i).padEnd(80, 'x') }));
  assert.ok(e._spriteBytes + e._sprites.bytes <= 32 * 1024 * 1024);
  assert.ok(e._spriteCache.size <= 128);
  const canvases = [...e._spriteCache.values()].map(s => s.canvas).concat(e._sprites.free);
  e.destroy();
  assert.equal(e._spriteBytes + e._sprites.bytes, 0);
  assert.ok(canvases.every(c => c.width === 0 && c.height === 0));
});

test('stats report percentiles, queue delay, memory and independent drop snapshots', () => {
  const e = make(); e.video.paused = true; e.push({ text: 'wait' });
  now += 250; e.video.paused = false; e._drainPending(true);
  let reported; e.onStats = s => { reported = s; };
  e._frame(1000); e._frame(1020); e._frame(1050); e._frame(1300);
  assert.equal(reported.frameP95, 250); assert.equal(reported.frameP99, 250);
  assert.equal(reported.queueP95, 250); assert.ok(reported.spriteMB > 0);
  e.push({ text: '' }); assert.equal(reported.dropReasons.invalid, 0);
});

test('idle fallback stops at its actual time budget and resumes later', async () => {
  const originalIdle = globalThis.requestIdleCallback, originalTimer = globalThis.setTimeout;
  let callback;
  try {
    globalThis.requestIdleCallback = undefined;
    const { DanmakuEngine: FallbackEngine } = await import(moduleURL + '#fallback');
    const e = new FallbackEngine({ appendChild() {}, getBoundingClientRect: () => ({ width: 800, height: 396 }) },
      { currentTime: 0, paused: false, ended: false, addEventListener() {}, removeEventListener() {} });
    engines.push(e);
    e.loadTimeline(Array.from({ length: 20 }, (_, i) => ({ time: 1, text: `item ${i}` })));
    rasterCost = 2;
    globalThis.setTimeout = cb => { callback = cb; return 999; };
    e._schedulePrerender(); callback();
    assert.equal(e._preIdx, 2);
    e._schedulePrerender(); callback();
    assert.equal(e._preIdx, 4);
  } finally {
    globalThis.requestIdleCallback = originalIdle;
    globalThis.setTimeout = originalTimer;
  }
});
