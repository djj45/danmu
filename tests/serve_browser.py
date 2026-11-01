"""Real-browser acceptance server using synthetic video and the production SSE handler.

Run: python3 -B tests/serve_browser.py --port 8765
Requires ffmpeg. Open the printed URL and click 开始验收. No forum polling is started.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server as app


class VirtualFlow:
    def __init__(self):
        self.rate = 0
        self.sent = 0
        self.lock = threading.Lock()

    def emit(self):
        with self.lock:
            self.sent += 1
            n = self.sent
        app.HUB.broadcast({
            "type": "danmaku", "id": f"virtual:{n}", "pid": n, "floor": n,
            "user": "虚拟用户", "text": f"虚拟弹幕 {n} · 浏览器验收 · 你好世界 ✨",
            "color": app.PALETTE[n % len(app.PALETTE)],
            "source": {"id": "virtual", "type": "tieba", "url": "synthetic"},
        })

    def run(self):
        while True:
            rate = self.rate
            if rate:
                self.emit()
            time.sleep(1 / rate if rate else 0.05)


FLOW = VirtualFlow()
REPORT = None
ARTIFACTS = None


class AcceptanceHandler(app.Handler):
    def log_message(self, *args):
        pass

    def _send(self, body, mime, status=200, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 视频切源、seek 或关闭页面会取消尚未发完的媒体响应。

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/stream":
            return self._stream()
        if path == "/api/sources":
            return self._json({"sources": []})
        if path == "/__test__/report":
            return self._json(REPORT or {"status": "pending"})
        if path == "/__test__/video.mp4":
            body = (ARTIFACTS / "video.mp4").read_bytes()
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
            if match:
                start = int(match[1])
                end = min(int(match[2]) if match[2] else len(body) - 1, len(body) - 1)
                if start > end:
                    return self._send(b"", "video/mp4", 416, {"Content-Range": f"bytes */{len(body)}"})
                return self._send(body[start:end + 1], "video/mp4", 206,
                                  {"Content-Range": f"bytes {start}-{end}/{len(body)}", "Accept-Ranges": "bytes"})
            return self._send(body, "video/mp4", headers={"Accept-Ranges": "bytes"})
        if path in ("/", "/index.html"):
            page = (ROOT / "index.html").read_text()
            page = re.sub(r'(id="srcInput"[^>]*?value=")[^"]*', r'\g<1>/__test__/video.mp4', page)
            page = page.replace('<video id="video" playsinline>', '<video id="video" playsinline loop>')
            page = page.replace('src="src/player.js"', 'src="tests/browser-acceptance.js"')
            return self._send(page.encode(), "text/html; charset=utf-8")
        allowed = {"/src/player.js", "/src/danmaku.js", "/data/danmaku-bilibili.json",
                   "/tests/browser-acceptance.js"}
        if path in allowed:
            return self._static(path)
        return self._json({"error": "test route not found"}, 404)

    def do_POST(self):
        global REPORT
        path = urlparse(self.path).path
        body = self._body()
        if path == "/__test__/flow":
            FLOW.rate = min(200, max(0, float(body.get("rate", 0))))
            for _ in range(min(1500, max(0, int(body.get("burst", 0))))):
                FLOW.emit()
            return self._json({"sent": FLOW.sent, "rate": FLOW.rate})
        if path == "/__test__/report":
            REPORT = body
            (ARTIFACTS / "report.json").write_text(json.dumps(body, ensure_ascii=False, indent=2))
            (ARTIFACTS / f"report-{time.time_ns()}.json").write_text(json.dumps(body, ensure_ascii=False, indent=2))
            print(json.dumps(body, ensure_ascii=False), flush=True)
            return self._json({"ok": True})
        return self._json({"error": "test route not found"}, 404)


def main():
    global ARTIFACTS
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    ARTIFACTS = Path(tempfile.mkdtemp(prefix="danmu-browser-"))
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                    "-i", "testsrc2=size=960x540:rate=30", "-t", "90", "-an", "-c:v", "libx264",
                    "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    str(ARTIFACTS / "video.mp4")], check=True)
    threading.Thread(target=FLOW.run, daemon=True).start()
    print(f"Browser acceptance: http://127.0.0.1:{args.port}/\nArtifacts: {ARTIFACTS}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), AcceptanceHandler).serve_forever()


if __name__ == "__main__":
    main()
