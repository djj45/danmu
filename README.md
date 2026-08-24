# danmu — 丝滑弹幕播放器

对标 B 站手感的 Canvas 弹幕引擎 + 网页播放器，**已打通论坛回复 → 弹幕 的完整链路**：
轮询百度贴吧 / Stage1st / NGA 的帖子最新回复，实时推到播放器变成弹幕。
弹幕样本来自 B 站真实视频（`BV1Pw4m1y77i`，357 条），为接入春晚直播源做好了准备。

## 运行

```bash
cd danmu
uv run server.py          # 静态页面 + 论坛抓取后端，默认 8080 端口
# 浏览器打开 http://localhost:8080（Safari 原生支持 HLS 直播流）
```

依赖用 [uv](https://docs.astral.sh/uv/) 管理（`uv add aiotieba` 已写入 `pyproject.toml`），首次运行自动创建 `.venv`。

## 论坛回复 → 弹幕（已实现）

页面下方「论坛弹幕源」卡片添加帖子链接，最新回复就会以**回复内容本身**变成弹幕
（不显示用户名/UID；颜色按用户名哈希分配，同一用户颜色稳定），SSE 推送，多个帖子可同时挂。

| 论坛 | 抓取方式 | 认证 | 实测 |
|---|---|---|---|
| 百度贴吧 | [aiotieba](https://github.com/lumina37/aiotieba)（移动端接口，网页会被 403）；可选**百度账号扫码登录**（passport 三步公开流程：getqrcode → unicast 长轮询 → qrbdusslogin 换 BDUSS，约十年有效，防游客风控） | 游客即可，扫码更稳 | ✅ 游客与扫码登录（斗啦啦啦）双路径实测通过 |
| Stage1st | Discuz HTML 解析（GBK），按 [forum-saver](https://github.com/shuangluoxss/forum-saver) 的登录端点走**账号密码登录** | `config.toml` 或页面输入框填账密 | ✅ 真实账号登录 + 抓取端到端通过 |
| NGA | **扫码登录**自动获取 Cookie；抓取走 `read.php?lite=js` 自带 JSON 接口（`__T` 总回复数算末页、`__R` 楼层、`__U` 用户表），多页帖子自动只轮询末页 | 扫码 / 手填 Cookie | ✅ 真实帖子端到端通过（单页 + 172 楼多页帖均验证） |

凭据放 `config.toml`（不入库）；NGA/贴吧推荐直接扫码：

- **NGA 扫码登录**：源类型切到 NGA → 点「扫码登录」→ NGA App（首页 → 左上菜单 → 扫一扫）
  授权 → Cookie 自动保存到 `data/nga-cookie.json` 并被 NGA 源自动使用。
  实现复刻网页版登录流程：`nuke.php` 的 `qrlogin_gen` 生成密钥 → 轮询 `__act=login` →
  扫码确认的响应带 `{uid, token}` → 表单提交 `login_set_cookie_quick` 换取 Cookie
  （该端点对脚本返回 403 但照样下发 Set-Cookie），有效期约 120 秒，过期点「重新生成」即可。
- **百度扫码登录**：源类型切到百度贴吧 → 点「百度账号扫码登录」→ 手机百度扫一扫。
  走 passport.baidu.com 公开流程，BDUSS（约十年有效）保存到 `data/tieba-bduss.json`，
  aiotieba 自动切换为登录态，防游客风控。
- S1 / 手动 Cookie 方式仍走 `config.toml`：

```toml
[s1]
username = "你的S1用户名"
password = "你的S1密码"

[nga]
cookie = "（扫码登录则无需填写）"
```

春晚当天：播放器贴春晚 m3u8 直播源 → 添加贴吧/S1/NGA 的春晚讨论帖 → 弹幕即论坛实时讨论。

### 后端接口（server.py）

```
GET  /api/sources         源列表与状态
POST /api/sources         添加源 {type: tieba|s1|nga, url, interval?, backlog?, cookie?, username?, password?}
POST /api/sources/remove  移除源 {id}
GET  /api/stream          SSE：{type:"danmaku", user, text, color, floor, pid, source} / {type:"status", ...}
```

- 轮询间隔默认 6s（最小 2s，别把论坛打挂）；`backlog` 控制添加时回放最近几条
- 源列表持久化在 `data/sources.json`，重启自动恢复
- 抓取细节：贴吧取倒序第一页按 pid 去重；S1/NGA 先读总页数再抓最后一页；
  引用内容、签名、"本帖最后由…编辑"都会被剔除

### 抓取调试

```bash
uv run python tools/test-sources.py tieba 'https://tieba.baidu.com/p/<tid>'
uv run python tools/test-sources.py s1 'https://stage1st.com/2b/thread-<tid>-1-1.html' --guest
uv run python tools/test-sources.py nga 'https://bbs.nga.cn/read.php?tid=<tid>' --cookie '...'
```

## B 站弹幕为什么丝滑？—— 原理与本实现的对照

B 站网页播放器的弹幕层是一个铺在视频上的 `<canvas>`（打开开发者工具能在
`.bpx-player-video-danmaku` 容器里看到），画布尺寸 = 播放器尺寸 × devicePixelRatio。
丝滑不是玄学，是下面这套组合拳，本仓库逐条实现了：

| # | 关键技术 | 为什么需要 | 代码位置 |
|---|---------|-----------|---------|
| 1 | **Canvas 而非 DOM** | DOM 弹幕每帧触发 style/layout/paint，几百条就掉帧；Canvas 只是把文字按新坐标重画一遍 | `src/danmaku.js` 整个引擎 |
| 2 | **位置由时钟推导** `x(t) = W − v·(t−t₀)` | 不做逐帧增量累加 → 暂停、seek、切后台再回来，弹幕位置永远和时间轴精确一致，零漂移、零跳变 | `_draw()` / `clock()` |
| 3 | **单一 rAF 循环** | 一个 `requestAnimationFrame` 驱动所有弹幕；速度用时间表示而非像素/帧，任何刷新率下手感一致 | `_frame()` |
| 4 | **devicePixelRatio 缩放** | 画布物理尺寸 × dpr 再 `setTransform(dpr,…)`，Retina 屏文字锐利不发虚 | `resize()` |
| 5 | **轨道分配 + 追尾判定** | 画面按行高切成轨道；新弹幕入轨前判断"会不会在途中追上前车"（匀速运动可精确算出追上时刻）。文字越小速度越慢，越长越快 | `_pickScrollLane()` |
| 6 | **sprite 预渲染** | 每条弹幕的描边+填充只在入场时画一次到离屏画布，主循环里只剩 `drawImage`（比每帧 `strokeText+fillText` 快一个数量级） | `_rasterize()` |
| 7 | **对象池 + sprite 复用** | 热路径零对象分配，离屏画布重复使用不重新分配 —— 避免 GC 造成的周期性卡顿（GC 暂停是"莫名掉一下帧"的头号元凶） | `SpritePool` / `_pool` |
| 8 | **剔除与丢弃** | 画布外的弹幕不绘制；轨道全满时丢弃（B 站同样丢弃），永不积压 | `_draw()` / `_pickScrollLane()` |
| 9 | **描边而非阴影** | `shadowBlur` 是 Canvas 最贵的操作之一；B 站用细描边保证任何背景上的可读性，成本低得多 | `_rasterize()` |

另外两个容易忽视的点：

- **不要用 CSS animation/transition 做弹幕**：合成器动画遇到标签页限流、
  大量图层时会抖动，而且和视频时间轴无法精确同步。
- **进度 UI 也要 rAF**：`timeupdate` 事件只有约 4Hz，直接驱动进度条会一跳一跳。

## 目录结构

```
index.html                  播放器页面（B 站风格 UI + 论坛弹幕源卡片）
src/danmaku.js              弹幕引擎（无依赖，可直接拷走复用）
src/player.js               播放器逻辑：源加载/控制栏/设置面板/SSE 消费
server.py                   本地后端：静态托管 + 论坛轮询 + SSE 推流（uv run）
config.toml                 S1 账密 / NGA Cookie（本地凭据，不入库）
data/danmaku-bilibili.json  B 站真实弹幕样本
data/sources.json           已添加的论坛源（运行时生成）
data/capture/               抓取的原始响应（只增不删）
tools/fetch-bilibili-dm.mjs B 站弹幕抓取：node tools/fetch-bilibili-dm.mjs BV号
tools/test-sources.py       论坛源抓取调试脚本
```

## 引擎 API

```js
import { DanmakuEngine, DanmakuMode } from './src/danmaku.js';

const engine = new DanmakuEngine(container, video, {
  fontSize: 25,     // 字号 px
  opacity: 1,       // 不透明度
  speedRate: 1,     // 速度倍率
  area: 1,          // 显示区域（0.25 = 1/4 屏）
  baseDuration: 8.5,// 1x 下滚过全屏的秒数
});

engine.loadTimeline([{ time: 3.2, text: '前方高能', color: '#ffffff', mode: DanmakuMode.SCROLL }]);
engine.push({ text: '论坛最新回复', color: '#fb7299' });   // 直播推送（论坛接入口）
engine.seek(video.currentTime);                            // 点播 seek 后重定位
engine.setMode('live' | 'timeline');
engine.setOpacity(0.7); engine.setSpeedRate(1.5); engine.setFontSize(20); engine.setArea(0.5);
engine.onStats = (s) => console.log(s.fps, s.active, s.dropped);
```

## 接入春晚直播源

页面「视频源」输入框直接粘贴 m3u8 地址点加载即可（Safari 原生 HLS，
Chrome 自动走 hls.js）。春晚直播流一般是 HLS（部分是 FLV，需要 flv.js，
暂未包含）。直播流（`duration === Infinity`）会自动切换为直播模式：
隐藏进度条、弹幕改由实时推送驱动，视频暂停时弹幕时钟同步冻结。
