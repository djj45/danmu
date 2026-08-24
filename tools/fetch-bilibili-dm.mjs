#!/usr/bin/env node
/**
 * 抓取 B 站视频弹幕并解析成播放器可用的 JSON。
 *
 * 用法: node tools/fetch-bilibili-dm.mjs BV1Pw4m1y77i [输出路径]
 *
 * 原始响应按时间戳保存在 data/capture/（只增不删，防止误删辛苦抓来的数据）。
 * 弹幕 protobuf 结构（DmSegMobileReply → DanmakuElem）:
 *   1 id  2 progress(ms)  3 mode(1滚动/4底部/5顶部)  4 fontsize  5 color(int)  6 midHash  7 content
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const bvid = process.argv[2];
if (!bvid) {
  console.error('用法: node tools/fetch-bilibili-dm.mjs <bvid> [输出路径]');
  process.exit(1);
}
const outPath = process.argv[3] ?? join(ROOT, 'data', 'danmaku-bilibili.json');

const captureDir = join(ROOT, 'data', 'capture');
mkdirSync(captureDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
  headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
})).json();
if (view.code !== 0) throw new Error(`view 接口失败: ${view.code} ${view.message}`);
const { cid, duration, title } = view.data;
writeFileSync(join(captureDir, `view-${bvid}-${stamp}.json`), JSON.stringify(view));

// 通用 protobuf wire-format 字段遍历（带边界检查）
function* fields(buf, start, end) {
  let i = start;
  const varint = () => {
    let v = 0n, s = 0n;
    for (;;) {
      if (i >= end) throw new Error(`varint 越界 @${i}`);
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return v;
      s += 7n;
    }
  };
  while (i < end) {
    const tag = Number(varint());
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) yield [field, 0, Number(varint())];
    else if (wire === 2) {
      const l = Number(varint());
      if (i + l > end) throw new Error(`len 越界 @${i} l=${l}`);
      yield [field, 2, buf.subarray(i, i + l)];
      i += l;
    } else if (wire === 1) { i += 8; }
    else if (wire === 5) { i += 4; }
    else throw new Error(`非法 wire type ${wire} field ${field} @${i}`);
  }
}

const decode = new TextDecoder();
function parseSeg(buf) {
  const out = [];
  for (const [, , elem] of fields(buf, 0, buf.length)) {
    const e = { time: 0, mode: 1, fontsize: 25, color: '#ffffff', text: '' };
    for (const [f, w, v] of fields(elem, 0, elem.length)) {
      if (w === 0 && f === 2) e.time = v / 1000;
      else if (w === 0 && f === 3) e.mode = v;
      else if (w === 0 && f === 4) e.fontsize = v;
      else if (w === 0 && f === 5) e.color = '#' + (v >>> 0).toString(16).padStart(6, '0');
      else if (w === 2 && f === 7) e.text = decode.decode(v);
    }
    // 只保留滚动/顶部/底部三种常规弹幕，长度限制防止超长文本撑爆画布
    if ([1, 4, 5].includes(e.mode) && e.text && e.text.length <= 60) out.push(e);
  }
  return out;
}

// 每个分段 6 分钟；最多抓 10 段（一小时），足够任何 demo
const segCount = Math.min(10, Math.max(1, Math.ceil(duration / 360)));
const items = [];
for (let s = 1; s <= segCount; s++) {
  const res = await fetch(`https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${s}`, {
    headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${bvid}/` },
  });
  if (!res.ok) { console.error(`分段 ${s} 拉取失败 HTTP ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(captureDir, `dmseg-${cid}-${s}-${stamp}.so`), buf);
  items.push(...parseSeg(buf));
  await new Promise(r => setTimeout(r, 300)); // 轻微限速
}

items.sort((a, b) => a.time - b.time);
const payload = { source: bvid, title, cid, videoDuration: duration, count: items.length, items };
writeFileSync(outPath, JSON.stringify(payload));
console.log(`《${title}》共 ${items.length} 条弹幕 → ${outPath}`);
