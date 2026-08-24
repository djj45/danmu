/**
 * player.js — 把弹幕引擎、视频和 UI 控件接在一起
 */
import { DanmakuEngine, DanmakuMode } from './danmaku.js';

const $ = (id) => document.getElementById(id);

const player = $('player');
const video = $('video');
const playBtn = $('playBtn'), playIcon = $('playIcon'), muteBtn = $('muteBtn'), volIcon = $('volIcon');
const timeLabel = $('timeLabel'), progress = $('progress'), played = $('played'), buffered = $('buffered'), knob = $('knob');
const centerTip = $('centerTip'), liveBadge = $('liveBadge'), statsEl = $('stats');
const dmInput = $('dmInput'), dmColor = $('dmColor'), sendBtn = $('sendBtn');
const settingsBtn = $('settingsBtn'), settingsPop = $('settingsPop');
const volume = $('volume');

const engine = new DanmakuEngine(player, video, { fontSize: 25, opacity: 1, speedRate: 1, area: 1 });

/* ---------------- 视频源加载（mp4 / m3u8） ---------------- */

let hls = null;
let sampleItems = [];   // B 站抓来的样本弹幕

async function ensureHlsJs() {
  if (window.Hls) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('hls.js 加载失败'));
    document.head.appendChild(s);
  });
}

async function loadSource(url) {
  stopSim();
  destroyHls();
  showTip('spinner');
  try {
    if (/\.m3u8(\?|#|$)/i.test(url)) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url; // Safari 原生 HLS
      } else {
        await ensureHlsJs();
        if (!window.Hls?.isSupported()) throw new Error('当前浏览器不支持 HLS');
        hls = new window.Hls({ enableWorker: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) showTip('视频加载失败：' + data.type, true);
        });
      }
    } else {
      video.src = url;
    }
    video.muted = true; // 静音自动播放，避免浏览器拦截
    updateMuteIcon();
    await video.play().catch(() => {});
  } catch (err) {
    showTip('加载失败：' + err.message, true);
  }
}

function destroyHls() {
  if (hls) { hls.destroy(); hls = null; }
}

/* ---------------- 弹幕数据：点播铺时间轴 / 直播走推送 ---------------- */

video.addEventListener('loadedmetadata', () => {
  const duration = video.duration;
  if (isFinite(duration) && duration > 0 && sampleItems.length) {
    setupTimeline(duration);
  } else {
    setupLive();
  }
});

function setupTimeline(duration) {
  const span = sampleItems[sampleItems.length - 1].time || 1;
  const items = [];
  if (duration > span * 1.4) {
    // 视频比弹幕样本长很多（比如换了 10 分钟的测试流）→ 循环铺满整条时间轴
    for (let base = 0; base < duration - 0.5 && items.length < 5000; base += span) {
      for (const it of sampleItems) {
        const t = base + it.time;
        if (t < duration - 0.2) items.push({ ...it, time: t });
      }
    }
  } else {
    const k = duration / span;
    for (const it of sampleItems) items.push({ ...it, time: it.time * k });
  }
  liveBadge.classList.add('hidden');
  progress.style.display = '';
  engine.setMode('timeline');
  engine.loadTimeline(items);
}

function setupLive() {
  liveBadge.classList.remove('hidden');
  progress.style.display = 'none';
  engine.setMode('live');
}

video.addEventListener('seeking', () => {
  if (engine.mode === 'timeline') engine.seek(video.currentTime);
});
video.addEventListener('pause', () => { if (engine.mode === 'live') engine.freezeLiveClock(); updatePlayIcon(); });
video.addEventListener('play', () => { if (engine.mode === 'live') engine.unfreezeLiveClock(); updatePlayIcon(); hideTip(); });

fetch('data/danmaku-bilibili.json')
  .then((r) => r.json())
  .then((j) => {
    sampleItems = j.items;
    if (video.readyState >= 1) {
      // 源先到、数据后到时补一次装配
      const d = video.duration;
      if (isFinite(d) && d > 0) setupTimeline(d); else setupLive();
    }
  })
  .catch(() => { sampleItems = []; });

/* ---------------- 播放控制 ---------------- */

const ICON_PLAY = '<path d="M8 5.5v13l11-6.5z"/>';
const ICON_PAUSE = '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>';
const ICON_VOL = '<path d="M4 9v6h4l5 5V4L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>';
const ICON_MUTED = '<path d="M4 9v6h4l5 5V4L8 9H4zm14.2 3 2.3-2.3-1.4-1.4-2.3 2.3-2.3-2.3-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3z"/>';

function updatePlayIcon() { playIcon.innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE; }
function updateMuteIcon() { volIcon.innerHTML = (video.muted || video.volume === 0) ? ICON_MUTED : ICON_VOL; }

playBtn.onclick = () => video.paused ? video.play() : video.pause();
muteBtn.onclick = () => { video.muted = !video.muted; updateMuteIcon(); };
volume.oninput = () => { video.volume = +volume.value; video.muted = video.volume === 0; updateMuteIcon(); };
video.volume = +volume.value;

video.addEventListener('click', () => video.paused ? video.play() : video.pause());
video.addEventListener('waiting', () => showTip('spinner'));
video.addEventListener('playing', hideTip);
video.addEventListener('error', () => { if (video.src) showTip('视频加载失败，请检查地址或换个源', true); });

function showTip(content, isError) {
  centerTip.classList.remove('hidden');
  centerTip.innerHTML = isError
    ? `<div style="text-align:center;line-height:1.8">${content}<br><span style="font-size:12px;opacity:.75">点击重试</span></div>`
    : '<div class="spinner"></div>';
}
function hideTip() { centerTip.classList.add('hidden'); }
centerTip.onclick = () => { hideTip(); video.play().catch(() => {}); };

const fmt = (t) => {
  if (!isFinite(t)) return '00:00';
  const s = Math.floor(t % 60), m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/* 进度条：UI 用独立 rAF 刷新（timeupdate 只有 4Hz，会跳） */
(function uiLoop() {
  requestAnimationFrame(uiLoop);
  if (engine.mode !== 'timeline' || !isFinite(video.duration)) return;
  const d = video.duration, p = video.currentTime / d;
  played.style.width = (p * 100) + '%';
  knob.style.left = (p * 100) + '%';
  timeLabel.textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
  try {
    if (video.buffered.length) {
      buffered.style.width = (video.buffered.end(video.buffered.length - 1) / d * 100) + '%';
    }
  } catch { /* ignore */ }
})();

let dragging = false;
const seekByEvent = (e) => {
  const rect = progress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  video.currentTime = ratio * video.duration;
};
progress.addEventListener('pointerdown', (e) => {
  if (!isFinite(video.duration)) return;
  dragging = true;
  progress.setPointerCapture(e.pointerId);
  seekByEvent(e);
});
progress.addEventListener('pointermove', (e) => { if (dragging) seekByEvent(e); });
progress.addEventListener('pointerup', () => { dragging = false; });

/* 全屏（Safari 需要webkit前缀） */
$('fullBtn').onclick = () => {
  const el = player;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  } else {
    (el.requestFullscreen ?? el.webkitEnterFullscreen ?? el.webkitRequestFullscreen).call(el);
  }
};

/* 控制栏自动隐藏 */
let hideTimer = 0;
const wakeControls = () => {
  player.classList.remove('ctrl-hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!video.paused && !settingsOpen) player.classList.add('ctrl-hidden'); }, 2600);
};
player.addEventListener('pointermove', wakeControls);
player.addEventListener('pointerleave', () => { if (!video.paused) player.classList.add('ctrl-hidden'); });
wakeControls();

/* 快捷键 */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 5);
  else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
});

/* ---------------- 发弹幕 / 压力测试 / 模拟直播 ---------------- */

function sendDanmaku() {
  const text = dmInput.value.trim();
  if (!text) return;
  engine.push({ text, color: dmColor.value, mode: DanmakuMode.SCROLL });
  dmInput.value = '';
  dmInput.focus();
}
sendBtn.onclick = sendDanmaku;
dmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDanmaku(); });

const STRESS_COLORS = ['#ffffff', '#fe0302', '#ff7204', '#ffff00', '#01cd5e', '#00c3ff', '#c74dde', '#fb7299'];

$('stressBtn').onclick = () => {
  if (!sampleItems.length) return;
  // 持续 8 秒高速推送：轨道接纳上限约 16 条/秒，稳定后屏上会积压 130+ 条同时飞
  let sent = 0;
  const total = 1200, batch = () => {
    for (let k = 0; k < 3 && sent < total; k++, sent++) {
      const src = sampleItems[(Math.random() * sampleItems.length) | 0];
      engine.push({
        text: src.text,
        color: STRESS_COLORS[(Math.random() * STRESS_COLORS.length) | 0],
        mode: Math.random() < 0.05 ? DanmakuMode.TOP : DanmakuMode.SCROLL,
      });
    }
    if (sent < total) setTimeout(batch, 20);
  };
  batch();
};

let simTimer = 0;
function stopSim() { clearInterval(simTimer); simTimer = 0; $('simLiveChk').checked = false; }
$('simLiveChk').onchange = (e) => {
  clearInterval(simTimer);  // 只停旧定时器，不能动勾选状态（stopSim 会重置勾选框）
  simTimer = 0;
  if (!e.target.checked || !sampleItems.length) return;
  simTimer = setInterval(() => {
    if (Math.random() < 0.75) {
      const src = sampleItems[(Math.random() * sampleItems.length) | 0];
      engine.push({
        text: src.text,
        color: Math.random() < 0.25 ? STRESS_COLORS[(Math.random() * STRESS_COLORS.length) | 0] : '#ffffff',
        mode: Math.random() < 0.06 ? DanmakuMode.BOTTOM : DanmakuMode.SCROLL,
      });
    }
  }, 380);
};

/* ---------------- 设置面板 ---------------- */

let settingsOpen = false;
settingsBtn.onclick = (e) => {
  e.stopPropagation();
  settingsOpen = !settingsOpen;
  settingsPop.classList.toggle('hidden', !settingsOpen);
};
player.addEventListener('click', (e) => {
  if (settingsOpen && !settingsPop.contains(e.target)) { settingsOpen = false; settingsPop.classList.add('hidden'); }
});

$('dmSwitch').onclick = (e) => {
  const on = e.currentTarget.classList.toggle('on');
  engine.setVisible(on);
};
$('opacityRange').oninput = (e) => {
  const v = +e.target.value;
  engine.setOpacity(v / 100);
  $('opacityVal').textContent = v + '%';
};
$('fontRange').oninput = (e) => {
  const v = +e.target.value;
  engine.setFontSize(v);
  $('fontVal').textContent = v + 'px';
};
for (const segId of ['speedSeg', 'areaSeg']) {
  $(segId).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $(segId).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    if (segId === 'speedSeg') engine.setSpeedRate(+btn.dataset.v);
    else engine.setArea(+btn.dataset.v);
  });
}

/* ---------------- 性能面板 ---------------- */

$('showStatsChk').onchange = (e) => statsEl.classList.toggle('hidden', !e.target.checked);
statsEl.classList.remove('hidden');
engine.onStats = (s) => {
  statsEl.textContent = `${s.fps} FPS · 屏上 ${s.active} · 已发 ${s.displayed} · 丢弃 ${s.dropped}`;
};

/* 测试弹幕（B站样本，时间轴数据）开关：关掉后只剩实时推送的弹幕 */
$('sampleDmChk').onchange = (e) => engine.setTimelineEnabled(e.target.checked);

/* ---------------- 启动 ---------------- */

updatePlayIcon();
updateMuteIcon();
loadSource($('srcInput').value);
$('loadSrcBtn').onclick = () => loadSource($('srcInput').value.trim());
$('srcInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSource(e.target.value.trim()); });

// 供控制台/外部集成调用：window.danmu.push({...}) 就是外部弹幕的接入口
window.danmu = { engine, video, DanmakuMode };

/* ---------------- 论坛弹幕源（SSE） ---------------- */

const forumList = $('forumList'), sseState = $('sseState'), dmOnAir = $('dmOnAir');
const TYPE_LABEL = { tieba: '贴吧', s1: 'S1', nga: 'NGA' };

// 凭据输入框按类型显隐
$('forumType').onchange = (e) => {
  $('tiebaCredRow').classList.toggle('show', e.target.value === 'tieba');
  $('s1CredRow').classList.toggle('show', e.target.value === 's1');
  $('ngaCredRow').classList.toggle('show', e.target.value === 'nga');
};

function renderSources(sources) {
  forumList.innerHTML = '';
  for (const s of sources) {
    const li = document.createElement('li');
    const state = document.createElement('span');
    state.className = 'f-state ' + (s.status === 'running' ? 'ok' : s.status === 'error' ? 'err' : '');
    state.textContent = s.status === 'running'
      ? `已推 ${s.pushed} 条${s.lastFloor != null ? ` · 楼层 #${s.lastFloor}` : ''}`
      : (s.error || s.status);
    li.innerHTML = `<span class="f-type">${TYPE_LABEL[s.type] ?? s.type}</span>
      <span class="f-url" title="${s.url}">${s.url}</span>`;
    li.appendChild(state);
    const del = document.createElement('button');
    del.className = 'f-del'; del.title = '移除'; del.textContent = '✕';
    del.onclick = () => fetch('/api/sources/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id }),
    }).then(refreshSources);
    li.appendChild(del);
    forumList.appendChild(li);
  }
}

async function refreshSources() {
  try {
    const r = await fetch('/api/sources');
    renderSources((await r.json()).sources ?? []);
  } catch { /* server 未启动时静默 */ }
}

$('addForumBtn').onclick = async () => {
  const type = $('forumType').value;
  const url = $('forumUrl').value.trim();
  if (!url) { $('forumUrl').focus(); return; }
  const body = {
    type, url,
    interval: +$('forumInterval').value || 6,
    backlog: 3, // 添加时回放最近 3 条，确认链路通
    username: $('s1User').value.trim(),
    password: $('s1Pass').value,
    cookie: $('ngaCookie').value.trim(),
  };
  const r = await fetch('/api/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { alert(j.error || '添加失败'); return; }
  $('forumUrl').value = '';
  refreshSources();
};

// SSE：论坛回复 → 弹幕
let onAirFlash = 0;
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => sseState.classList.add('on');
  es.onerror = () => sseState.classList.remove('on');
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'danmaku') {
      // 只显示回复内容本身；颜色仍按用户名哈希，同一用户颜色稳定
      engine.push({ text: m.text, color: m.color, mode: DanmakuMode.SCROLL });
      dmOnAir.textContent = `「${TYPE_LABEL[m.source.type] ?? ''} #${m.floor ?? m.pid}」`;
      clearTimeout(onAirFlash);
      onAirFlash = setTimeout(() => { dmOnAir.textContent = ''; }, 4000);
    } else if (m.type === 'status') {
      refreshSources();
    }
  };
}
connectStream();
refreshSources();

/* ---------------- 扫码登录（NGA / 百度贴吧通用） ---------------- */

const qrModal = $('qrModal'), qrCode = $('qrCode'), qrStatus = $('qrStatus'),
      qrRetryBtn = $('qrRetryBtn'), qrTitle = $('qrTitle'), qrTip = $('qrTip');
let qrTimer = 0, qrKind = 'nga';

const QR_META = {
  nga: { title: 'NGA 扫码登录', tip: '打开 NGA App：首页 → 左上角菜单 → 扫一扫。Cookie 自动保存到 data/nga-cookie.json', app: 'NGA App' },
  tieba: { title: '百度账号扫码登录', tip: '打开手机百度 / 百度App 扫一扫并确认登录。BDUSS 自动保存到 data/tieba-bduss.json（约十年有效）', app: '手机百度' },
};

async function startQrLogin(kind) {
  qrKind = kind;
  const meta = QR_META[kind];
  qrTitle.textContent = meta.title;
  qrTip.textContent = meta.tip;
  qrRetryBtn.classList.add('hidden');
  qrCode.innerHTML = '';
  qrStatus.textContent = '正在生成二维码…';
  try {
    const j = await (await fetch(`/api/${kind}/qr/start`)).json();
    if (!j.ok) throw new Error(j.error || '生成失败');
    qrCode.innerHTML = j.svg || `<img src="${j.qrimg}" alt="二维码">`;
    qrStatus.textContent = `请用${meta.app}扫码`;
    clearInterval(qrTimer);
    qrTimer = setInterval(pollQr, 3000);
  } catch (e) {
    qrStatus.textContent = '生成失败：' + e.message;
    qrRetryBtn.classList.remove('hidden');
  }
}

async function pollQr() {
  let j;
  try {
    j = await (await fetch(`/api/${qrKind}/qr/poll`)).json();
  } catch { return; /* 网络抖动，下轮再查 */ }
  if (j.status === 'waiting' || j.status === 'idle') return;
  clearInterval(qrTimer);
  if (j.status === 'ok') {
    qrCode.innerHTML = '✓';
    qrStatus.textContent = `登录成功（${j.user || '未知用户'}），凭据已保存`;
    setTimeout(() => qrModal.classList.add('hidden'), 2400);
  } else {
    qrStatus.textContent = j.error || '二维码已过期';
    qrRetryBtn.classList.remove('hidden');
  }
}

$('ngaQrBtn').onclick = () => { qrModal.classList.remove('hidden'); startQrLogin('nga'); };
$('tiebaQrBtn').onclick = () => { qrModal.classList.remove('hidden'); startQrLogin('tieba'); };
qrRetryBtn.onclick = () => startQrLogin(qrKind);
$('qrCloseBtn').onclick = () => { clearInterval(qrTimer); qrModal.classList.add('hidden'); };
