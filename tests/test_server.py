"""Offline regression tests: all forum responses are synthetic; no network or persisted writes."""
import asyncio
import unittest
from unittest.mock import patch, Mock, AsyncMock

import server


def reply(pid):
    return {"pid": pid, "floor": pid, "user": "test", "text": f"message {pid}"}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.hub = server.Hub()
        self.events = self.hub.subscribe()
        self.patch_hub = patch.object(server, "HUB", self.hub)
        self.patch_hub.start()
        self.addCleanup(self.patch_hub.stop)
        network = patch.object(server, "http_request", side_effect=AssertionError("unexpected network call"))
        network.start()
        self.addCleanup(network.stop)

    def emitted_ids(self):
        result = []
        while not self.events.empty():
            event = self.events.get_nowait()
            if event["type"] == "danmaku":
                result.append(event["pid"])
        return result

    def test_slow_sse_client_recovers_without_reconnecting(self):
        hub = server.Hub()
        slow, fast = hub.subscribe(), hub.subscribe()
        for i in range(700):
            hub.broadcast({"n": i})
            self.assertEqual(fast.get_nowait(), {"n": i})
        self.assertEqual(slow.qsize(), 500)
        self.assertEqual(slow.get_nowait(), {"n": 200})
        while not slow.empty():
            slow.get_nowait()
        hub.broadcast({"n": 700})
        self.assertEqual(slow.get_nowait(), {"n": 700})
        self.assertEqual(fast.get_nowait(), {"n": 700})

    def test_recovery_and_deduplication_without_new_replies(self):
        src = server.Source("test", "local", backlog=2)
        src.emit([reply(1), reply(1), reply(2)])
        self.assertEqual(self.emitted_ids(), [1, 2])
        src.status, src.last_error = "error", "temporary failure"
        src.emit([reply(2)])
        self.assertEqual((src.status, src.last_error), ("running", ""))
        self.assertEqual(self.emitted_ids(), [])

    def test_initial_backlog_does_not_fetch_history(self):
        src = server.Source("test", "local", backlog=1)
        fetch = Mock(return_value=[reply(8), reply(9)])
        src.emit(src.recent_replies(fetch, last=50))
        fetch.assert_called_once_with(50)
        self.assertEqual(self.emitted_ids(), [9])

    def test_page_rollover_includes_previous_page_tail_in_order(self):
        src = server.Source("test", "local")
        src.emit([reply(39)])
        pages = {1: [reply(39), reply(40)], 2: [reply(41), reply(42)], 3: [reply(43)]}
        fetch = Mock(side_effect=lambda pn: pages[pn])
        src.emit(src.recent_replies(fetch, last=3))
        self.assertEqual([call.args[0] for call in fetch.call_args_list], [3, 2, 1])
        self.assertEqual(self.emitted_ids(), [40, 41, 42, 43])

    def test_reverse_pagination_stops_at_seen_boundary(self):
        src = server.Source("test", "local")
        src.emit([reply(1)])
        pages = {1: [reply(4), reply(3)], 2: [reply(2), reply(1)]}
        fetch = Mock(side_effect=lambda pn: pages[pn])
        src.emit(src.recent_replies(fetch))
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(self.emitted_ids(), [2, 3, 4])

    def test_contentless_page_does_not_hide_unseen_previous_tail(self):
        src = server.Source("test", "local")
        src.emit([reply(19)])
        pages = {3: [reply(41)], 2: [], 1: [reply(19), reply(20)]}
        src.emit(src.recent_replies(lambda pn: pages[pn], last=3))
        self.assertEqual(self.emitted_ids(), [20, 41])

    def test_pinned_old_reply_is_not_a_catchup_boundary(self):
        src = server.Source("test", "local")
        src.emit([reply(1), reply(20)])
        pages = {3: [reply(1), reply(41)], 2: [reply(20), reply(21)]}
        src.emit(src.recent_replies(lambda pn: pages[pn], last=3))
        self.assertEqual(self.emitted_ids(), [21, 41])

    def test_deleted_boundary_does_not_replay_older_unseen_history(self):
        src = server.Source("test", "local")
        src.emit([reply(20)])
        pages = {3: [reply(21)], 2: [reply(18), reply(19)]}
        src.emit(src.recent_replies(lambda pn: pages[pn], last=3))
        self.assertEqual(self.emitted_ids(), [21])

    def test_catchup_limit_and_partial_failure_do_not_advance_seen(self):
        src = server.Source("test", "local")
        src.emit([reply(1)])
        fetch = Mock(side_effect=lambda pn: [reply(pn * 10)])
        src.emit(src.recent_replies(fetch, last=10))
        self.assertEqual(fetch.call_count, 4)
        self.assertEqual(self.emitted_ids(), [70, 80, 90, 100])
        self.assertEqual(src.summary()["catchupLimited"], 1)
        failing = Mock(side_effect=[[reply(101)], RuntimeError("offline")])
        with self.assertRaises(RuntimeError):
            src.recent_replies(failing, last=11)
        self.assertNotIn("101", src._seen)

    def test_s1_adapter_fetches_new_and_previous_tail_pages(self):
        src = server.S1Source("test", "https://stage1st.com/2b/thread-123-1-1.html")
        src._login = Mock()
        src.emit([reply(39)])
        def page(pids):
            return ('thread-123-2-1.html ' + ''.join(
                f'<div id="post_{pid}"><a class="xw1">test</a>'
                f'<td id="postmessage_{pid}">message</td></div>' for pid in pids)).encode()
        with patch.object(server, "http_request", side_effect=[(page([39, 40]), "", "utf-8"),
                                                               (page([41]), "", "utf-8")]) as request:
            src.poll_once()
        self.assertEqual(request.call_count, 2)
        self.assertEqual(self.emitted_ids(), [40, 41])

    def test_nga_adapter_fetches_rollover_and_accepts_empty_thread(self):
        src = server.NGASource("test", "https://bbs.nga.cn/read.php?tid=1", cookie="synthetic")
        src.emit([reply(19)])
        def page(pids):
            return {"__T": {"replies": 21}, "__R": {str(pid): {
                "pid": pid, "lou": pid, "authorid": 1, "content": "message"} for pid in pids}}
        src._fetch = Mock(side_effect=lambda pn=None: page([21]) if pn == 2 else page([19, 20]))
        src.poll_once()
        self.assertEqual(self.emitted_ids(), [20, 21])
        self.assertEqual(server.NGASource._parse_replies({"__R": {}}), [])
        with self.assertRaises(RuntimeError):
            server.NGASource._parse_replies({})

    def test_tieba_adapter_passes_page_number_to_existing_api(self):
        fake = Mock()
        fake.get_posts = AsyncMock(return_value=Mock(objs=[]))
        with patch.object(server, "_tb_client", new=AsyncMock(return_value=fake)), \
             patch.object(server, "aiotieba", Mock()):
            asyncio.run(server._tb_get_posts(123, pn=3))
        self.assertEqual(fake.get_posts.call_args.kwargs["pn"], 3)
        self.assertEqual(fake.get_posts.call_args.kwargs["rn"], 30)

    def test_stopped_source_can_be_joined(self):
        src = server.Source("test", "local")
        src.stop()
        src.start()
        src.join(timeout=1)
        self.assertFalse(src.is_alive())


if __name__ == "__main__":
    unittest.main()
