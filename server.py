#!/usr/bin/env python3
"""
server.py — 弹幕播放器本地后端

职责：
  1. 托管静态文件（index.html / src / data），替代 python -m http.server
  2. 轮询论坛帖子、把最新回复通过 SSE 推给播放器变成弹幕：
     - 百度贴吧：aiotieba（游客即可，移动端 protobuf 接口，网页会被 403）
     - Stage1st：Discuz 账号密码登录（参考 forum-saver 的登录端点），GBK 页面解析
     - NGA：必须 Cookie（游客/账密都不行，同样参考 forum-saver），bbs.nga.cn

运行：uv run server.py   （默认 8080 端口，PORT 环境变量可改）

接口：
  GET  /api/sources        当前源与状态
  POST /api/sources        添加源 {type,url,interval?,backlog?,cookie?,username?,password?}
  POST /api/sources/remove 删除源 {id}
  GET  /api/stream         SSE 事件流（danmaku / status）
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html as html_mod
import json
import os
import queue
import re
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser
from http import cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.4 Safari/605.1.15")
# B 站经典弹幕色板，按用户名哈希取色，同一用户颜色稳定
PALETTE = ["#ffffff", "#fe0302", "#ff7204", "#ffff00", "#01cd5e", "#00c3ff", "#c74dde", "#fb7299"]

try:
    import aiotieba
except ImportError:
    aiotieba = None


# ---------------------------------------------------------------- 配置

def load_config() -> dict:
    cfg = {}
    path = ROOT / "config.toml"
    if path.exists():
        with open(path, "rb") as f:
            cfg = tomllib.load(f)
    return cfg

CONFIG = load_config()


# ---------------------------------------------------------------- 工具

def text_color(user: str) -> str:
    h = int(hashlib.md5(user.encode("utf-8", "ignore")).hexdigest(), 16)
    return PALETTE[h % len(PALETTE)]


class _TextExtractor(HTMLParser):
    """把 HTML 片段压成单行纯文本"""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in ("br", "p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def strip_html(fragment: str, limit: int = 120) -> str:
    p = _TextExtractor()
    p.feed(fragment)
    text = "".join(p.parts)
    text = re.sub(r"[ \t\u00a0\u200b\u3000]+", " ", text)
    text = re.sub(r"\s*\n\s*", " ", text)
    return text.strip()[:limit]


def decode_page(body: bytes, content_type: str = "") -> str:
    m = re.search(r'charset=["\']?([\w-]+)', content_type, re.I)
    if not m:
        head = body[:2048].decode("ascii", "ignore").lower()
        m = re.search(r'charset=["\']?([\w-]+)', head)
    enc = m.group(1) if m else ""
    for e in [enc, "utf-8", "gbk", "gb18030"]:
        if not e:
            continue
        try:
            return body.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", "ignore")


def http_request(url: str, jar: cookiejar.CookieJar | None, *, data: bytes | None = None,
                 headers: dict | None = None, timeout: int = 15, with_headers: bool = False,
                 allow_4xx: bool = False):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    opener = urllib.request.build_opener()
    if jar is not None:
        opener.add_handler(urllib.request.HTTPCookieProcessor(jar))
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        # NGA 等站点 403 响应里仍会下发 Set-Cookie（游客会话），不能直接抛
        if not allow_4xx:
            raise
        resp = e
    try:
        body = resp.read()
        url_out = resp.geturl()
        hdrs = resp.headers
        status = getattr(resp, "status", 0) or getattr(resp, "code", 0)
    finally:
        resp.close()
    ctype = hdrs.get("Content-Type", "")
    if with_headers:
        return body, url_out, ctype, hdrs, status
    return body, url_out, ctype


# ---------------------------------------------------------------- SSE 中心

class Hub:
    def __init__(self):
        self._lock = threading.Lock()
        self._clients: set[queue.Queue] = set()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        with self._lock:
            self._clients.add(q)
        return q

    def unsubscribe(self, q) -> None:
        with self._lock:
            self._clients.discard(q)

    def broadcast(self, event: dict) -> None:
        with self._lock:
            dead = []
            for q in self._clients:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._clients.discard(q)


HUB = Hub()


# ---------------------------------------------------------------- 源基类

class Source(threading.Thread):
    type_name = "?"

    def __init__(self, sid: str, url: str, interval: float = 6, backlog: int = 0):
        super().__init__(daemon=True)
        self.sid = sid
        self.url = url
        self.interval = max(2.0, float(interval))
        self.backlog = max(0, int(backlog))
        self._stop = threading.Event()
        self._seen: set[str] = set()
        self._first = True
        self.replies_pushed = 0
        self.last_floor = None
        self.last_poll = 0.0
        self.status = "starting"
        self.last_error = ""

    # 子类实现：返回 [{pid, user, text, floor}]，按楼层升序
    def poll(self) -> list[dict]:
        raise NotImplementedError

    def emit(self, replies: list[dict]) -> None:
        fresh = [r for r in replies if str(r["pid"]) not in self._seen]
        for r in fresh:
            self._seen.add(str(r["pid"]))
        if not fresh:
            return
        fresh.sort(key=lambda r: (r.get("floor") or 0, str(r["pid"])))
        for r in fresh:
            if r.get("floor") is not None:
                self.last_floor = r["floor"]
        if self._first:
            self._first = False
            # 首轮只回放最后 backlog 条（默认 0 = 只推此后出现的新回复）
            fresh = fresh[-self.backlog:] if self.backlog else []
        for r in fresh:
            self.replies_pushed += 1
            HUB.broadcast({
                "type": "danmaku",
                "id": f"{self.sid}:{r['pid']}",
                "source": {"id": self.sid, "type": self.type_name, "url": self.url},
                "pid": r["pid"], "user": r["user"], "text": r["text"],
                "floor": r.get("floor"), "color": text_color(r["user"]),
            })
        self.status = "running"
        self.last_error = ""

    def fail(self, msg: str) -> None:
        self.status = "error"
        self.last_error = msg
        print(f"[{self.type_name}:{self.sid}] {msg}", file=sys.stderr)

    def summary(self) -> dict:
        return {"id": self.sid, "type": self.type_name, "url": self.url,
                "interval": self.interval, "status": self.status,
                "error": self.last_error, "pushed": self.replies_pushed,
                "lastFloor": self.last_floor, "lastPoll": self.last_poll}

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
                HUB.broadcast({"type": "status", "source": self.summary()})
            except Exception as e:  # noqa: BLE001 轮询失败要保活并暴露给 UI
                self.fail(str(e))
                HUB.broadcast({"type": "status", "source": self.summary()})
            self._stop.wait(self.interval)
        self.status = "stopped"

    def poll_once(self) -> list[dict]:
        self.last_poll = time.time()
        replies = self.poll()
        self.emit(replies)
        return replies

    def stop(self) -> None:
        self._stop.set()


# ---------------------------------------------------------------- 贴吧（aiotieba）

_LOOP: asyncio.AbstractEventLoop | None = None


def _loop_thread() -> None:
    global _LOOP
    _LOOP = asyncio.new_event_loop()
    asyncio.set_event_loop(_LOOP)
    _LOOP.run_forever()


def ensure_loop() -> asyncio.AbstractEventLoop:
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        threading.Thread(target=_loop_thread, daemon=True, name="aiotieba-loop").start()
        while _LOOP is None:
            time.sleep(0.01)
    return _LOOP


_TB_CLIENT: "aiotieba.Client | None" = None
_TB_BDUSS = ""
_TB_LOCK = threading.Lock()

TIEBA_BDUSS_PATH = ROOT / "data" / "tieba-bduss.json"


def load_saved_bduss() -> str:
    try:
        return json.loads(TIEBA_BDUSS_PATH.read_text()).get("bduss", "")
    except Exception:  # noqa: BLE001
        return ""


async def _tb_client() -> "aiotieba.Client":
    """全局贴吧客户端；扫码登录保存的 BDUSS 变化时自动重建（游客→登录态）"""
    global _TB_CLIENT, _TB_BDUSS
    bduss = load_saved_bduss()
    with _TB_LOCK:
        if _TB_CLIENT is None or bduss != _TB_BDUSS:
            if _TB_CLIENT is not None:
                await _TB_CLIENT.__aexit__(None, None, None)
            _TB_CLIENT = aiotieba.Client(BDUSS=bduss)
            await _TB_CLIENT.__aenter__()
            _TB_BDUSS = bduss
    return _TB_CLIENT


async def _tb_get_posts(tid: int) -> list[dict]:
    posts = await (await _tb_client()).get_posts(
        tid, pn=1, rn=30, sort=aiotieba.enums.PostSortType.DESC)
    out = []
    for p in posts.objs:
        user = getattr(getattr(p, "user", None), "show_name", "") or \
               getattr(getattr(p, "user", None), "user_name", "") or "?"
        out.append({"pid": p.pid, "user": user,
                    "text": (p.text or "").strip(), "floor": p.floor})
    return out


class TiebaSource(Source):
    type_name = "tieba"

    def __init__(self, sid, url, **kw):
        m = re.search(r"/p/(\d+)", url)
        if not m:
            raise ValueError("贴吧链接需形如 https://tieba.baidu.com/p/<tid>")
        self.tid = int(m.group(1))
        super().__init__(sid, url, **{k: v for k, v in kw.items()
                                     if k in ("interval", "backlog")})
        if aiotieba is None:
            self.status, self.last_error = "error", "未安装 aiotieba（uv add aiotieba）"

    def poll(self) -> list[dict]:
        if aiotieba is None:
            raise RuntimeError("未安装 aiotieba")
        fut = asyncio.run_coroutine_threadsafe(_tb_get_posts(self.tid), ensure_loop())
        return fut.result(timeout=30)


# ---------------------------------------------------------------- Stage1st（Discuz 账号密码登录）

QUOTE_RE = re.compile(r'<div class="quote">.*?</div>(?:\s*</blockquote>)?', re.S)
QUOTE_RE2 = re.compile(r'\[quote\].*?\[/quote\]', re.S)
PSTATUS_RE = re.compile(r'<i class="pstatus">.*?</i>', re.S)
S1_POST_SPLIT_RE = re.compile(r'id="post_(\d+)"')
S1_AUTHOR_RE = re.compile(r'class="xw1"[^>]*>([^<]+)</a>')
S1_CONTENT_RE = re.compile(r'id="postmessage_\d+"[^>]*>(.*?)</td>', re.S)
S1_PAGE_RE = re.compile(r'thread-\d+-(\d+)-1\.html')


class S1Source(Source):
    type_name = "s1"
    BASE = "https://stage1st.com/2b"

    def __init__(self, sid, url, username="", password="", **kw):
        m = re.search(r'thread-(\d+)', url) or re.search(r'[?&]tid=(\d+)', url)
        if not m:
            raise ValueError("S1 链接需形如 https://stage1st.com/2b/thread-<tid>-1-1.html")
        self.tid = m.group(1)
        self.username = username or CONFIG.get("s1", {}).get("username", "")
        self.password = password or CONFIG.get("s1", {}).get("password", "")
        super().__init__(sid, url, **{k: v for k, v in kw.items()
                                     if k in ("interval", "backlog")})
        self.jar = cookiejar.CookieJar()
        self._logged_in = False

    def _login(self) -> None:
        if self._logged_in:
            return
        if not self.username or not self.password:
            raise RuntimeError("S1 需要账号密码：在 config.toml [s1] 填 username/password，或添加源时填入")
        # forum-saver 的 Discuz 快捷登录端点（免 formhash）
        endpoint = f"{self.BASE}/member.php?mod=logging&action=login&loginsubmit=yes&infloat=yes&lssubmit=yes&inajax=1"
        data = urllib.parse.urlencode({"username": self.username,
                                       "password": self.password}).encode()
        body, _, ctype = http_request(endpoint, self.jar, data=data,
                                      headers={"Content-Type": "application/x-www-form-urlencoded"})
        text = decode_page(body, ctype)
        if "登录失败" in text or "ultrax" in text and "登录失败" in text:
            raise RuntimeError("S1 登录失败，请检查 config.toml 中的账号密码")
        self._logged_in = True

    def _page_url(self, pn: int) -> str:
        return f"{self.BASE}/thread-{self.tid}-{pn}-1.html"

    def parse_posts(self, page: str) -> list[dict]:
        out = []
        chunks = S1_POST_SPLIT_RE.split(page)
        # split 后 [头, pid, 片段, pid, 片段 ...]；片段是 pid 所属楼层的内容
        for i in range(1, len(chunks) - 1, 2):
            pid, seg = chunks[i], chunks[i + 1]
            m = S1_CONTENT_RE.search(seg)
            if not m:
                continue
            content = m.group(1)
            content = PSTATUS_RE.sub("", content)
            content = QUOTE_RE.sub("", content)
            text = strip_html(content)
            if not text:
                continue
            am = S1_AUTHOR_RE.search(seg)
            out.append({"pid": int(pid), "user": (am.group(1) if am else "?").strip(),
                        "text": text, "floor": None})
        return out

    def poll(self) -> list[dict]:
        self._login()
        body, _, ctype = http_request(self._page_url(1), self.jar)
        page = decode_page(body, ctype)
        pages = [int(x) for x in S1_PAGE_RE.findall(page)]
        last = max(pages) if pages else 1
        if last > 1:
            body, _, ctype = http_request(self._page_url(last), self.jar)
            page = decode_page(body, ctype)
        posts = self.parse_posts(page)
        if not posts:
            raise RuntimeError("S1 页面解析不到回复（未登录或页面结构变化）")
        # pid 单调对应楼层顺序，用它推断楼层号
        for i, p in enumerate(posts, 1):
            p["floor"] = (last - 1) * 40 + i
        return posts


# ---------------------------------------------------------------- NGA（Cookie + lite=js 接口）

NGA_PAYLOAD_RE = re.compile(r"=\s*(\{.*\})\s*$", re.S)
NGA_QUOTE_BLOCK_RE = re.compile(
    r"\[(quote|code|img|flash|audio|video|tid=\d+|collapse)[^\]]*\].*?\[/\1\]", re.S | re.I)
NGA_BB_TAG_RE = re.compile(r"\[/?[a-z][^\]]*\]", re.I)


def clean_nga_content(content: str) -> str:
    content = NGA_QUOTE_BLOCK_RE.sub("", content or "")
    content = NGA_BB_TAG_RE.sub("", content)
    text = strip_html(content, limit=120)
    # 引用回复的头部："Reply to Reply Post by xxx (2025-11-22 19:06) …"
    return re.sub(r"Reply to (Reply )?(Post )?by \S+ \(\d{4}-\d\d-\d\d \d\d:\d\d\)\s*", "", text)


class NGASource(Source):
    type_name = "nga"

    def __init__(self, sid, url, cookie="", **kw):
        m = re.search(r'[?&]tid=(\d+)', url)
        if not m:
            raise ValueError("NGA 链接需形如 https://bbs.nga.cn/read.php?tid=<tid>")
        self.tid = m.group(1)
        self.base = re.match(r"(https?://[^/]+)", url).group(1)
        self.cookie = cookie or CONFIG.get("nga", {}).get("cookie", "")
        super().__init__(sid, url, **{k: v for k, v in kw.items()
                                     if k in ("interval", "backlog")})
        if not self.cookie and not load_saved_nga_cookie():
            self.status, self.last_error = "error", \
                "NGA 必须提供 Cookie：点「扫码登录」自动获取，或在 config.toml [nga] 填入"

    def _resolve_cookie(self) -> str:
        # 优先级：手动填入 > config.toml > 扫码登录保存的
        if not self.cookie:
            self.cookie = load_saved_nga_cookie()
        return self.cookie

    def _fetch(self, page: int | None = None) -> dict:
        """read.php?lite=js 是 NGA 自带的 JSON 接口：__T 帖子信息 / __R 楼层 / __U 用户表"""
        url = f"{self.base}/read.php?tid={self.tid}&lite=js"
        if page:
            url += f"&page={page}"
        headers = {"Cookie": self._resolve_cookie(), "Referer": f"{self.base}/"}
        body, _, ctype, _hdrs, status = http_request(url, None, headers=headers,
                                                     with_headers=True, allow_4xx=True)
        text = decode_page(body, ctype)
        m = NGA_PAYLOAD_RE.search(text)
        if not m:
            raise RuntimeError(f"NGA 接口返回异常(HTTP {status})，Cookie 可能失效")
        d = json.loads(m.group(1), strict=False)
        if "error" in d:
            err = d["error"].get("0", d["error"]) if isinstance(d["error"], dict) else d["error"]
            raise RuntimeError(f"NGA: {strip_html(str(err), 80)}")
        return d.get("data", {})

    def poll(self) -> list[dict]:
        if not self._resolve_cookie():
            raise RuntimeError("NGA 必须提供 Cookie（可点「扫码登录」自动获取）")
        d = self._fetch()
        try:
            replies = int(d.get("__T", {}).get("replies") or 0)
        except ValueError:
            replies = 0
        last = replies // 20 + 1 if replies > 0 else 1
        if last > 1:
            d = self._fetch(last)  # 只看末页的最新回复
        users = d.get("__U", {})
        out = []
        for row in (d.get("__R") or {}).values():
            pid = str(row.get("pid", ""))
            if not pid or pid == "0":  # 楼主主题帖 pid 为 0
                continue
            author = users.get(str(row.get("authorid")), {})
            text = clean_nga_content(row.get("content", ""))
            if not text:
                continue
            out.append({"pid": int(pid), "user": author.get("username") or f"UID:{row.get('authorid')}",
                        "text": text, "floor": row.get("lou")})
        if not out:
            raise RuntimeError("NGA 帖子解析不到回复（无回复或权限不足）")
        return out


# ---------------------------------------------------------------- NGA 扫码登录

NGA_COOKIE_PATH = ROOT / "data" / "nga-cookie.json"


def load_saved_nga_cookie() -> str:
    """读取扫码登录保存的 Cookie（凭据数据，只增不删）"""
    try:
        return json.loads(NGA_COOKIE_PATH.read_text()).get("cookie", "")
    except Exception:  # noqa: BLE001 文件不存在/损坏都视为没有
        return ""


def multipart_encode(fields: dict) -> tuple[bytes, str]:
    boundary = "----danmu" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def qr_svg(text: str) -> str:
    import io

    import qrcode
    import qrcode.image.svg
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode("ascii")


class NgaQrLogin:
    """NGA 网页版扫码登录会话（单例）。

    流程（来自 bbs.nga.cn 网页登录抓包 + 登录页 JS）：
      1. POST nuke.php __act=qrlogin_gen → data["0"] = "qrkey,hiddenkey"
      2. 二维码内容 = {base}/nuke.php?__lib=login&__act=qrlogin_ui&qrkey={qrkey}（NGA App 扫这个）
      3. 每 3s POST __act=login 轮询：error 含「未找到登录许可」=等待扫码；
         其他 error =过期；返回 data = 扫码确认成功
      4. 官方 JS 此后会延时 8s 再自动发一次 __act=login（"授权后点此登录"），
         Set-Cookie 落在这两次响应上 —— 这里手动从响应头收集 Cookie
      5. 带 Cookie 访问首页验证 __CURRENT_UNAME 出现用户名才算真正登录成功
    """
    BASE = "https://bbs.nga.cn"
    TTL = 120  # 网页端为 30 次 × 3s 轮询，对齐

    def __init__(self):
        self.reset()

    def reset(self):
        self.qrkey = ""
        self.hiddenkey = ""
        self.created = 0.0
        self.done = False
        self.user = ""
        self.cookie = ""
        self._cookies: dict[str, str] = {}

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self._cookies.items())

    def _get(self, url: str) -> tuple[str, int]:
        """带当前 Cookie 的 GET，同时收集响应里的 Set-Cookie（建立游客会话用）。
        返回 (页面文本, HTTP 状态码)；NGA 对游客 403 但仍下发 Cookie。"""
        body, _, ctype, hdrs, status = http_request(url, None,
                                                    headers={"Cookie": self._cookie_header(),
                                                             "Referer": f"{self.BASE}/"},
                                                    with_headers=True, allow_4xx=True)
        self._collect_set_cookies(hdrs)
        return decode_page(body, ctype), status

    def _post(self, fields: dict):
        data, ctype = multipart_encode(fields)
        body, _, resp_ctype, hdrs, _status = http_request(
            f"{self.BASE}/nuke.php", None, data=data,
            headers={"Content-Type": ctype,
                     "Cookie": self._cookie_header(),
                     "Referer": f"{self.BASE}/nuke/account_copy.html?login",
                     "Origin": self.BASE, "X-USER-AGENT": UA},
            with_headers=True, allow_4xx=True)
        text = decode_page(body, resp_ctype)
        m = NGA_PAYLOAD_RE.search(text)
        if not m:
            raise RuntimeError(f"NGA 登录接口返回异常: {text[:80]!r}")
        payload = json.loads(m.group(1))
        self._collect_set_cookies(hdrs)
        return payload

    def _collect_set_cookies(self, headers) -> int:
        """直接从原始 Set-Cookie 响应头收集，绕开 cookiejar 的属性校验。
        只收本站域（NGA 会同时给 img.nga.cn / img4.nga.cn 种 `_` 占位 Cookie，不能收）"""
        n = 0
        for raw in headers.get_all("Set-Cookie") or []:
            pair, _, attrs = raw.partition(";")
            if "=" not in pair:
                continue
            k, v = pair.split("=", 1)
            k, v = k.strip(), v.strip()
            dm = re.search(r"domain=([\w.\-]+)", attrs, re.I)
            domain = (dm.group(1) if dm else "bbs.nga.cn").lower().lstrip(".")
            if domain not in ("bbs.nga.cn", "nga.cn"):
                continue
            if k and v and v != "_":
                self._cookies[k] = v
                n += 1
        return n

    def start(self) -> dict:
        self.reset()
        # 先访问首页/登录页建立游客会话（NGA 只对带游客 Cookie 的会话下发登录 Cookie；
        # 首页对游客返回 403，但响应头里照样有 Set-Cookie）
        self._get(f"{self.BASE}/?rand={int(time.time() * 1000) % 100000}")
        self._get(f"{self.BASE}/nuke.php?__lib=login&__act=account&login")
        print(f"[nga-qr] 游客会话 Cookie: {list(self._cookies)}", file=sys.stderr)
        payload = self._post({"__lib": "login", "__output": "1",
                              "__act": "qrlogin_gen", "__inchst": "UTF-8"})
        raw = payload.get("data", {}).get("0", "")
        qrkey, _, hiddenkey = raw.partition(",")
        if not qrkey or not hiddenkey:
            raise RuntimeError(f"qrlogin_gen 返回异常: {payload}")
        self.qrkey, self.hiddenkey, self.created = qrkey, hiddenkey, time.time()
        return {"qrurl": f"{self.BASE}/nuke.php?__lib=login&__act=qrlogin_ui&qrkey={qrkey}"}

    def _login_fields(self) -> dict:
        return {"__lib": "login", "__output": "1", "app_id": "5004", "device": "",
                "__act": "login", "v2": "1", "qrkey": self.qrkey,
                "hiddenkey": self.hiddenkey, "__inchst": "UTF-8"}

    def _verify(self) -> str:
        """带收集到的 Cookie 访问首页：登录成功后游客 403 会变成 200 且出现 __CURRENT_UNAME"""
        if not self._cookies:
            return ""
        page, status = self._get(f"{self.BASE}/?rand={int(time.time() * 1000) % 100000}")
        m = re.search(r"__CURRENT_UNAME\s*=\s*'([^']+)'", page)
        print(f"[nga-qr] 首页验证 status={status} uname={m.group(1) if m else ''!r}",
              file=sys.stderr)
        return m.group(1) if m else ""

    def poll(self) -> dict:
        if self.done:
            return {"status": "ok", "user": self.user, "cookie": self.cookie}
        if not self.qrkey:
            return {"status": "idle"}
        if time.time() - self.created > self.TTL:
            return {"status": "expired", "error": "二维码已过期，请重新生成"}

        payload = self._post(self._login_fields())
        err = payload.get("error", {}).get("0", "")
        if err:
            if "未找到登录许可" in err:
                return {"status": "waiting"}
            self.reset()
            return {"status": "expired", "error": err}

        # 扫码确认成功。响应体里带 {uid, username, token}，但没有任何 Set-Cookie ——
        # 官方网页端此时用表单提交 uid+token 到 login_set_cookie_quick 换取真正的登录 Cookie
        print(f"[nga-qr] 扫码成功，完整响应: {json.dumps(payload, ensure_ascii=False)[:600]}",
              file=sys.stderr)
        data = payload.get("data", {})
        info = data.get("3", {})
        if not isinstance(info, dict):
            info = {}
        uid = str(info.get("uid") or data.get("1", ""))
        token = info.get("token") or data.get("2", "")
        user_guess = info.get("username", "")
        if not uid or not token:
            self.reset()
            return {"status": "expired",
                    "error": f"登录响应缺少 uid/token: {json.dumps(payload, ensure_ascii=False)[:200]}"}

        n_set = self._set_cookie_quick(uid, token)
        cookie = self._cookie_header()
        print(f"[nga-qr] login_set_cookie_quick 新增 {n_set} 个 Cookie: {list(self._cookies)}",
              file=sys.stderr)
        user = self._verify()

        if "ngaPassportCid" not in self._cookies:
            self.reset()
            return {"status": "expired", "error": "token 换取 Cookie 失败，请重新扫码"}
        if not user:
            # 保存了登录 Cookie 但首页验证未通过 —— 仍保存但提示
            self._finish(user_guess or "?", cookie)
            return {"status": "ok", "user": user_guess or "?", "cookie": cookie,
                    "warning": "Cookie 已保存但首页验证未通过，如无法抓取请重扫"}
        self._finish(user, cookie)
        return {"status": "ok", "user": user, "cookie": cookie}

    def _set_cookie_quick(self, uid: str, token: str) -> int:
        """复刻官方网页端：POST uid+cid(token) 到 login_set_cookie_quick。
        该端点对脚本请求也返回 403，但响应头里照样下发全部登录 Cookie。"""
        body, _, _ctype, hdrs, status = http_request(
            f"{self.BASE}/nuke.php?__lib=login&__act=login_set_cookie_quick&__output=9",
            None, data=urllib.parse.urlencode({"uid": uid, "cid": token}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "Cookie": self._cookie_header(),
                     "Referer": f"{self.BASE}/nuke.php?__lib=login&__act=account&login",
                     "Origin": self.BASE, "X-USER-AGENT": UA},
            with_headers=True, allow_4xx=True)
        print(f"[nga-qr] login_set_cookie_quick HTTP {status} body {len(body)}B", file=sys.stderr)
        return self._collect_set_cookies(hdrs)

    def _finish(self, user: str, cookie: str) -> None:
        self.done, self.user, self.cookie = True, user, cookie
        NGA_COOKIE_PATH.parent.mkdir(exist_ok=True)
        NGA_COOKIE_PATH.write_text(json.dumps(
            {"cookie": cookie, "user": user, "time": time.time()},
            ensure_ascii=False, indent=2))


NGA_QR = NgaQrLogin()


# ---------------------------------------------------------------- 百度贴吧扫码登录

class TiebaQrLogin:
    """百度统一扫码登录（passport.baidu.com 公开流程，无需抓包）：
      1. getqrcode → {sign, imgurl 二维码图}
      2. channel/unicast?channel_id={sign} 长轮询（未扫码则约 1 分钟超时重试）
         → channel_v.v = 临时 BDUSS
      3. v3/login/main/qrbdusslogin?bduss={临时} → Set-Cookie 正式 BDUSS（约十年有效）
    unicast 是长轮询，放在后台线程里跑；浏览器轮询本服务的 /api/tieba/qr/poll 读状态。
    """
    TTL = 300

    def __init__(self):
        self.reset()

    def reset(self):
        self.sign = ""
        self.imgurl = ""
        self.created = 0.0
        self.status = "idle"
        self.error = ""
        self.user = ""

    def start(self) -> dict:
        self.reset()
        body, _, _ct = http_request(
            "https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc"
            "&apiver=v3&tpl=mn&format=json",
            None, headers={"Referer": "https://passport.baidu.com/v2/?login&tpl=mn"})
        j = json.loads(body)
        if j.get("errno") != 0 or not j.get("sign"):
            raise RuntimeError(f"getqrcode 返回异常: {j}")
        self.sign = j["sign"]
        url = j["imgurl"]
        self.imgurl = url if url.startswith("http") else "https://" + url
        self.created = time.time()
        self.status = "waiting"
        threading.Thread(target=self._poll_loop, daemon=True, name="tieba-qr").start()
        return {"qrurl": self.imgurl}

    def _poll_loop(self):
        while self.status == "waiting" and time.time() - self.created < self.TTL:
            try:
                body, _, _ct = http_request(
                    f"https://passport.baidu.com/channel/unicast?channel_id={self.sign}"
                    f"&callback=cb&_={int(time.time() * 1000)}",
                    None, headers={"Referer": "https://passport.baidu.com/"}, timeout=75)
                m = re.search(r"\((\{.*\})\)", body.decode("utf-8", "ignore"), re.S)
                if not m:
                    continue
                j = json.loads(m.group(1))
                if j.get("errno") != 0:
                    continue  # 本轮无扫码事件，继续长轮询
                temp = json.loads(j.get("channel_v") or "{}").get("v", "")
                if temp and self._exchange(temp):
                    return
                # 拿到事件但没有临时 BDUSS（扫码未确认）→ 继续等
            except Exception as e:  # noqa: BLE001
                print(f"[tieba-qr] unicast: {e}", file=sys.stderr)
        if self.status == "waiting":
            self.status = "expired"
            self.error = "二维码已过期，请重新生成"

    def _exchange(self, temp_bduss: str) -> bool:
        body, _, _ct, hdrs, status = http_request(
            f"https://passport.baidu.com/v3/login/main/qrbdusslogin?bduss={temp_bduss}",
            None, headers={"Referer": "https://passport.baidu.com/"},
            with_headers=True, allow_4xx=True)
        bduss = ""
        for raw in hdrs.get_all("Set-Cookie") or []:
            pair = raw.split(";", 1)[0].strip()
            if pair.startswith("BDUSS=") and len(pair) > 40:
                bduss = pair.split("=", 1)[1]
        print(f"[tieba-qr] qrbdusslogin HTTP {status} 取到BDUSS: {bool(bduss)}", file=sys.stderr)
        if not bduss:
            return False
        try:
            fut = asyncio.run_coroutine_threadsafe(self._verify(bduss), ensure_loop())
            self.user = fut.result(timeout=30)
        except Exception as e:  # noqa: BLE001
            print(f"[tieba-qr] 登录态验证失败: {e}", file=sys.stderr)
            self.user = ""
        TIEBA_BDUSS_PATH.write_text(json.dumps(
            {"bduss": bduss, "user": self.user, "time": time.time()},
            ensure_ascii=False, indent=2))
        print(f"[tieba-qr] 登录成功 user={self.user!r}，BDUSS 已保存", file=sys.stderr)
        self.status = "ok"
        return True

    @staticmethod
    async def _verify(bduss: str) -> str:
        async with aiotieba.Client(BDUSS=bduss) as client:
            info = await client.get_self_info()
            return getattr(info, "user_name", "") or ""

    def summary(self) -> dict:
        saved = load_saved_bduss()
        return {"status": self.status, "error": self.error, "user": self.user,
                "logged_in": bool(saved)}


TIEBA_QR = TiebaQrLogin()


# ---------------------------------------------------------------- 源管理

class SourceManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.sources: dict[str, Source] = {}
        self._seq = 0

    def _load_persisted(self) -> None:
        path = ROOT / "data" / "sources.json"
        if not path.exists():
            return
        try:
            items = json.loads(path.read_text())
            for it in items:
                self.add(**it, quiet=True)
        except Exception as e:  # noqa: BLE001
            print(f"恢复源失败: {e}", file=sys.stderr)

    def _persist(self) -> None:
        with self.lock:
            items = []
            for s in self.sources.values():
                items.append({"type": s.type_name, "url": s.url, "interval": s.interval,
                              "backlog": s.backlog,
                              **({"cookie": s.cookie} if getattr(s, "cookie", "") else {}),
                              **({"username": s.username, "password": s.password}
                                 if getattr(s, "username", "") else {})})
            path = ROOT / "data" / "sources.json"
            path.write_text(json.dumps(items, ensure_ascii=False, indent=2))

    def add(self, type_: str, url: str, interval: float = 6, backlog: int = 0,
            cookie: str = "", username: str = "", password: str = "", quiet=False) -> dict:
        with self.lock:
            self._seq += 1
            sid = f"{type_}-{self._seq}"
        cls = {"tieba": TiebaSource, "s1": S1Source, "nga": NGASource}.get(type_)
        if cls is None:
            raise ValueError(f"未知源类型 {type_}")
        src = cls(sid, url.strip(), interval=interval, backlog=backlog,
                  cookie=cookie, username=username, password=password)
        with self.lock:
            self.sources[sid] = src
        src.start()
        self._persist()
        return src.summary()

    def remove(self, sid: str) -> bool:
        with self.lock:
            src = self.sources.pop(sid, None)
        if not src:
            return False
        src.stop()
        self._persist()
        return True

    def summaries(self) -> list[dict]:
        with self.lock:
            return [s.summary() for s in self.sources.values()]


MANAGER = SourceManager()


# ---------------------------------------------------------------- HTTP

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "danmu-server/1.0"

    # ---- 基础 ----
    def log_message(self, fmt, *args):  # 静音常规访问日志
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- 路由 ----
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/sources":
            return self._json({"sources": MANAGER.summaries()})
        if path == "/api/nga/qr/start":
            try:
                data = NGA_QR.start()
                return self._json({"ok": True, "qrurl": data["qrurl"], "svg": qr_svg(data["qrurl"])})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)}, 502)
        if path == "/api/nga/qr/poll":
            try:
                return self._json(NGA_QR.poll())
            except Exception as e:  # noqa: BLE001
                return self._json({"status": "error", "error": str(e)}, 502)
        if path == "/api/tieba/qr/start":
            try:
                data = TIEBA_QR.start()
                png, _, _ct = http_request(data["qrurl"], None,
                                           headers={"Referer": "https://passport.baidu.com/"})
                b64 = base64.b64encode(png).decode("ascii")
                return self._json({"ok": True, "qrimg": f"data:image/png;base64,{b64}"})
            except Exception as e:  # noqa: BLE001
                return self._json({"ok": False, "error": str(e)}, 502)
        if path == "/api/tieba/qr/poll":
            return self._json(TIEBA_QR.summary())
        if path == "/api/stream":
            return self._stream()
        return self._static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/sources":
                body = self._body()
                return self._json(MANAGER.add(
                    body.get("type"), body.get("url", ""),
                    interval=body.get("interval", 6), backlog=body.get("backlog", 0),
                    cookie=body.get("cookie", ""), username=body.get("username", ""),
                    password=body.get("password", "")))
            if path == "/api/sources/remove":
                ok = MANAGER.remove(self._body().get("id", ""))
                return self._json({"ok": ok}, 200 if ok else 404)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "not found"}, 404)

    # ---- SSE ----
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        q = HUB.subscribe()
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=15)
                    payload = json.dumps(event, ensure_ascii=False).encode()
                    self.wfile.write(b"data: " + payload + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.unsubscribe(q)

    # ---- 静态 ----
    def _static(self, path: str):
        if path == "/":
            path = "/index.html"
        file = (ROOT / path.lstrip("/")).resolve()
        if not str(file).startswith(str(ROOT)) or not file.is_file():
            return self._json({"error": "not found"}, 404)
        body = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(file.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    MANAGER._load_persisted()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"danmu server → http://localhost:{PORT}  (SSE: /api/stream)")
    if aiotieba is None:
        print("提示：未安装 aiotieba，贴吧源不可用（uv add aiotieba）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
