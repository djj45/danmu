#!/usr/bin/env python3
"""
直接测试论坛源抓取（不起 server），用于调试解析逻辑。

用法:
  uv run python tools/test-sources.py tieba https://tieba.baidu.com/p/<tid>
  uv run python tools/test-sources.py s1 https://stage1st.com/2b/thread-<tid>-1-1.html [--guest]
  uv run python tools/test-sources.py nga 'https://bbs.nga.cn/read.php?tid=<tid>' [--cookie '...']
选项: --backlog N 首轮回放最近 N 条  --polls N 轮询次数  --interval 秒
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import Hub, NGASource, S1Source, TiebaSource  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("type", choices=["tieba", "s1", "nga"])
    ap.add_argument("url")
    ap.add_argument("--guest", action="store_true", help="S1 跳过登录直接抓（仅调试解析）")
    ap.add_argument("--cookie", default="")
    ap.add_argument("--username", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--backlog", type=int, default=3)
    ap.add_argument("--polls", type=int, default=1)
    ap.add_argument("--interval", type=float, default=6)
    args = ap.parse_args()

    cls = {"tieba": TiebaSource, "s1": S1Source, "nga": NGASource}[args.type]
    src = cls("test", args.url, interval=args.interval, backlog=args.backlog,
              cookie=args.cookie, username=args.username, password=args.password)
    if args.guest and isinstance(src, S1Source):
        src.username = src.password = "GUEST_BYPASS"
        src._login = lambda: None  # noqa: SLF001 调试用：跳过登录

    events: list[dict] = []
    orig_broadcast = Hub.broadcast
    Hub.broadcast = staticmethod(lambda ev: events.append(ev))

    for i in range(args.polls):
        try:
            replies = src.poll_once()
            print(f"—— 第 {i + 1} 轮：页面解析到 {len(replies)} 条回复，本轮推送 ↓")
        except Exception as e:  # noqa: BLE001
            print(f"—— 第 {i + 1} 轮失败: {e}")
        for ev in events:
            if ev["type"] == "danmaku":
                print(f"  [{ev['user']}] (pid={ev['pid']} floor={ev['floor']}) {ev['text'][:60]}")
        events.clear()
        if i + 1 < args.polls:
            time.sleep(args.interval)

    Hub.broadcast = orig_broadcast


if __name__ == "__main__":
    main()
