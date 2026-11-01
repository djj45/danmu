// Browser acceptance of the production player, actual Canvas, video and SSE transport.
const errors = [];
addEventListener('error', e => errors.push(e.message));
addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
await import('../src/player.js');
const { engine: e, video, DanmakuMode: M } = window.danmu;
const $ = id => document.getElementById(id);
const panel = document.createElement('section');
panel.style.cssText = 'max-width:1120px;margin:16px auto;padding:16px;background:#182330;border:1px solid #54738d;border-radius:12px;color:white';
panel.innerHTML = '<h2>虚拟弹幕流 · 浏览器验收</h2><p>本地视频 + 真实 SSE + 真实 Canvas。请用宽度至少 1000px 的窗口，运行期间保持页面可见且不缩放；用例会单独检查 360px 播放器。</p><button id="acceptRun">开始验收（约 40 秒）</button> <button id="acceptDemo">持续演示</button><pre id="acceptStatus" style="white-space:pre-wrap">等待开始</pre>';
document.body.prepend(panel);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function until(predicate, message, timeout = 8000) {
  const end = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > end) throw new Error(message); await wait(50); }
}
async function flow(rate = 0, burst = 0) {
  const response = await fetch('/__test__/flow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rate, burst }) });
  assert(response.ok, '虚拟 SSE 控制请求失败');
  return response.json();
}
function clear() { e.setMode('live'); e.setOverlap(false); e.setFontSize(25); e.setVisible(true); }
function noCrossOverlap() {
  const act = e.active;
  for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
    const a = act[i], b = act[j];
    if (a.mode !== b.mode) assert(a.y + a.sprite.ch <= b.y || b.y + b.sprite.ch <= a.y, '不同弹幕模式重叠');
  }
}

$('acceptRun').onclick = async () => {
  $('acceptRun').disabled = $('acceptDemo').disabled = true;
  const results = [], started = performance.now();
  const initialViewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
  let viewportChanged = false;
  const onResize = () => { viewportChanged ||= innerWidth !== initialViewport.width || innerHeight !== initialViewport.height || devicePixelRatio !== initialViewport.dpr; };
  addEventListener('resize', onResize);
  let metrics = {}, peakActive = 0, peakPending = 0, peakMemory = 0;
  const originalStats = e.onStats;
  e.onStats = s => {
    originalStats(s); metrics = s;
    peakActive = Math.max(peakActive, s.active);
    peakPending = Math.max(peakPending, s.pending);
    peakMemory = Math.max(peakMemory, s.spriteMB);
  };
  const status = () => { $('acceptStatus').textContent = results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ': ' + r.detail : ''}`).join('\n'); };
  async function check(name, action) {
    try { const detail = await action(); results.push({ name, ok: true, detail: detail || '' }); }
    catch (error) { results.push({ name, ok: false, detail: error.message }); }
    status();
  }
  try {
    assert(innerWidth >= 1000, '请先将浏览器窗口设为至少 1000px 宽');
    await video.play();
    await until(() => video.readyState >= 2 && $('sseState').classList.contains('on'), '视频或 SSE 未就绪');
    await wait(500);
    e.setTimelineEnabled(false); $('sampleDmChk').checked = false;
    clear();
    await check('持续 SSE 推流与视频播放', async () => {
      const before = e.stats.displayed, mediaTime = video.currentTime;
      await flow(18); await wait(12000); await flow(0);
      assert(e.stats.displayed - before >= 25, '实际显示弹幕不足');
      assert(video.currentTime > mediaTime + 5, '视频没有持续播放');
      assert(e.active.length > 0, '屏上没有弹幕');
      const pixels = e.ctx.getImageData(0, 0, e.canvas.width, e.canvas.height).data;
      assert(pixels.some((v, i) => i % 4 === 3 && v > 0), 'Canvas 没有实际绘制像素');
      return `显示 ${e.stats.displayed - before} 条，帧 P95/P99 ${metrics.frameP95}/${metrics.frameP99}ms`;
    });
    await flow(0); await wait(200); clear();
    await check('三次真实视频暂停/恢复', async () => {
      e.push({ text: '暂停后位置保持 · 三次恢复检查' }); await wait(300);
      for (let i = 0; i < 3; i++) {
        video.pause(); await frame();
        const t = e.clock(), it = e.active[0];
        assert(it, '暂停测试弹幕未上屏');
        const x = it.x;
        await wait(400);
        assert(Math.abs(e.clock() - t) < 0.01, '暂停时弹幕时钟仍在走');
        assert(Math.abs(it.x - x) < 1, '暂停时弹幕仍在移动');
        await video.play(); await frame();
        assert(e.clock() >= t && e.clock() - t < 0.25, '恢复后时钟倒退或跳变');
        await wait(100);
      }
    });
    await check('字号控件重新准备队列', async () => {
      clear(); video.pause(); await frame();
      e.push({ text: '排队中的文字切换字号' });
      const at = e._pending[0].at;
      $('fontRange').value = '14'; $('fontRange').dispatchEvent(new Event('input'));
      assert(e.active.length === 0 && e._pending[0].fontSize === 14, '字号控件未重建队列');
      assert(e._pending[0].at === at, '字号变化延长了队列寿命');
      await video.play(); await until(() => e.active.length > 0, '新字号弹幕未上屏');
      assert(e.active[0].sprite.ch === Math.ceil(14 * 1.3), '实际文字图片尺寸错误');
      $('fontRange').value = '25'; $('fontRange').dispatchEvent(new Event('input'));
    });
    await check('顶部/底部/滚动混合布局', async () => {
      clear();
      for (let i = 0; i < 12; i++) e.dispatch({ text: `混合模式 ${i} 中文 Aa ✨`, mode: [M.TOP, M.BOTTOM, M.SCROLL][i % 3] });
      await wait(800); noCrossOverlap();
      assert(new Set(e.active.map(it => it.mode)).size === 3, '未覆盖全部模式');
    });
    await check('突发 1200 条 SSE 与过期丢弃', async () => {
      clear(); video.pause(); await frame();
      const before = { ...e.stats.dropReasons };
      await flow(0, 1200); await wait(1000);
      assert(e._pending.length === 300, `队列长度错误 ${e._pending.length}`);
      assert(e.stats.dropReasons.queueFull > before.queueFull, '未记录队列溢出');
      await wait(7500); await video.play();
      await until(() => e._pending.length === 0, '过期队列没有清空');
      assert(e.stats.dropReasons.expired >= before.expired + 300, '未记录过期丢弃');
      const shown = e.stats.displayed; await flow(6);
      await until(() => e.stats.displayed > shown, '积压后 SSE 没有恢复'); await flow(0);
      return `队满丢弃 +${e.stats.dropReasons.queueFull - before.queueFull}，过期 +${e.stats.dropReasons.expired - before.expired}`;
    });
    await flow(0); await wait(200);
    await check('样本开关不清除实时弹幕', async () => {
      e.setMode('timeline'); e.clear();
      e.dispatch({ text: '保留实时弹幕' }, 'push');
      e.dispatch({ text: '清除测试弹幕' }, 'timeline');
      for (const checked of [false, true]) {
        $('sampleDmChk').checked = checked; $('sampleDmChk').dispatchEvent(new Event('change'));
      }
      assert(e.active.length === 1 && e.active[0].origin === 'push', '样本开关误清理实时弹幕');
      e.setTimelineEnabled(false); $('sampleDmChk').checked = false;
    });
    await check('播放器切源清除旧队列', async () => {
      clear(); video.pause(); await frame(); e.push({ text: '旧视频待显示弹幕' });
      $('loadSrcBtn').click();
      assert(e._pending.length === 0 && e.active.length === 0, '切源残留旧弹幕');
      await until(() => video.readyState >= 2 && !video.paused, '本地视频重新加载失败');
    });
    await check('窄屏尺寸与重新布局', async () => {
      clear(); const player = $('player'); const old = player.style.width;
      player.style.width = '360px';
      await until(() => e.width === 360, 'ResizeObserver 没有更新窄屏画布');
      for (const mode of [M.TOP, M.BOTTOM, M.SCROLL]) e.dispatch({ text: '窄屏测试', mode });
      await wait(300); noCrossOverlap();
      assert(e.canvas.width === Math.round(360 * e.dpr), 'DPR 画布尺寸错误');
      player.style.width = old;
      await until(() => e.width > 360, '播放器宽度未恢复');
    });
    await check('允许重叠时的密集真实渲染', async () => {
      clear(); $('overlapSwitch').classList.remove('on'); $('overlapSwitch').click();
      assert(e.overlap, '重叠开关未生效');
      const before = { ...e.stats.dropReasons }, shownBefore = e.stats.displayed;
      for (let i = 0; i < 220; i++) e.dispatch({ text: `密集 ${i} 中文`, color: i % 2 ? '#00c3ff' : '#ffffff' });
      const initial = e.active.length;
      const geometry = e.active.slice(0, 3).map(it => ({ textW: it.w, canvasW: it.sprite.canvas.width,
        canvasH: it.sprite.canvas.height, bytes: it.sprite.bytes, fontSize: it.fontSize }));
      await wait(2500);
      assert(e.active.length >= 200, JSON.stringify({ initial, remaining: e.active.length,
        displayed: e.stats.displayed - shownBefore, memoryDrops: e.stats.dropReasons.memory - before.memory,
        noLaneDrops: e.stats.dropReasons.noLane - before.noLane, mode: e.mode, geometry }));
      assert(metrics.spriteMB <= 32, '超过缓存预算');
      return `${e.active.length} 条同时显示，帧 P95/P99 ${metrics.frameP95}/${metrics.frameP99}ms`;
    });
    await check('长文本超过内存预算时受控丢弃', async () => {
      e.clear(); const before = e.stats.dropReasons.memory;
      for (let i = 0; i < 600; i++) e.dispatch({ text: `预算 ${i} ` + '弹'.repeat(35) });
      await wait(1000);
      assert(e.stats.dropReasons.memory > before, '长文本没有触发内存限制');
      assert(metrics.spriteMB <= 32, '长文本缓存超过内存预算');
      return `内存限制丢弃 +${e.stats.dropReasons.memory - before}，缓存 ${metrics.spriteMB.toFixed(2)} MiB`;
    });
    await check('浏览器未发生未捕获异常', () => assert(errors.length === 0, errors.join('; ')));
    await check('验收期间浏览器视口保持稳定', () => assert(!viewportChanged, '浏览器视口发生变化，请固定窗口后重跑'));
  } catch (error) {
    results.push({ name: '验收准备', ok: false, detail: error.message });
  } finally {
    removeEventListener('resize', onResize);
    await flow(0);
    const report = { status: results.every(r => r.ok) ? 'passed' : 'failed',
      userAgent: navigator.userAgent, dpr: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight }, durationMs: Math.round(performance.now() - started),
      peakActive, peakPending, peakMemoryMiB: Number(peakMemory.toFixed(2)), results, errors };
    await fetch('/__test__/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
    status(); $('acceptStatus').textContent += `\n\n${report.status === 'passed' ? '全部通过' : '验收失败'} · ${results.filter(r => r.ok).length}/${results.length} · 峰值屏上 ${peakActive} / 排队 ${peakPending} / 缓存 ${report.peakMemoryMiB} MiB`;
    e.onStats = originalStats;
    $('acceptRun').disabled = $('acceptDemo').disabled = false;
  }
};

$('acceptDemo').onclick = async () => {
  await video.play(); e.setTimelineEnabled(false); clear(); await flow(12);
  $('acceptStatus').textContent = '持续演示中：每秒 12 条虚拟 SSE 弹幕。可操作原播放器的字号、速度、重叠、暂停和全屏。';
};
