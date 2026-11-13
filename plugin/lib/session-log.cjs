'use strict';
/**
 * 多帧 zstd 会话日志读取器。
 *
 * DSH 的 session.v4.jsonl.zstd 是「每追加一次就压一帧」的多帧文件，
 * 而 Node 的 zlib.zstdDecompressSync / createZstdDecompress 都只解第一帧。
 * 这里按 zstd 帧格式手工走边界，再逐帧解压。
 */
const fs = require('fs');
const zlib = require('zlib');

const MAGIC = 0xfd2fb528;

/** 返回 [[start, end], ...]，每项是一帧在文件中的字节区间。 */
function frameBounds(buf) {
  const out = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) break; // 尾部残留或非 zstd
    const start = off;
    const fhd = buf[off + 4];
    const fcsFlag = (fhd >> 6) & 3;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    off += 5;
    if (!single) off += 1; // window descriptor
    off += [0, 1, 2, 4][dictFlag]; // dictionary id
    off += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    while (off + 3 <= buf.length) {
      const v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      const last = v & 1;
      const type = (v >> 1) & 3;
      const size = v >>> 3;
      off += 3;
      if (type === 0) off += size; // raw
      else if (type === 1) off += 1; // rle
      else if (type === 2) off += size; // compressed
      else throw new Error('reserved block type at ' + (off - 3));
      if (last) break;
    }
    if (checksum) off += 4;
    out.push([start, off]);
  }
  return out;
}

/** 解码整份会话日志，返回按行切分的字符串数组。 */
function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  const bounds = frameBounds(buf);
  const lines = [];
  let error = null;
  for (const [s, e] of bounds) {
    try {
      const chunk = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
      for (const line of chunk.split('\n')) if (line.trim()) lines.push(line);
    } catch (err) {
      error = err.message;
    }
  }
  return { bytes: buf.length, frames: bounds.length, lines, error, tail: buf.length - (bounds.length ? bounds[bounds.length - 1][1] : 0) };
}

const ATTACH_RE = /"attachmentId"\s*:\s*"sha256:([0-9a-f]{64})"/gi;

/** 从日志行里收集所有 sha256 附件引用。 */
function collectAttachmentIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    ATTACH_RE.lastIndex = 0;
    let m;
    while ((m = ATTACH_RE.exec(line))) ids.add(m[1].toLowerCase());
  }
  return ids;
}

module.exports = { frameBounds, readSessionLog, collectAttachmentIds };
