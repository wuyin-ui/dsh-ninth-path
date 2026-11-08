/**
 * 第九通路 — 会话日志（多帧 zstd）读写。
 *
 * DSH 的会话日志是「首帧 header + 后续追加帧」的 zstd 拼接。改写 cwd 只动首帧，
 * 其余帧字节不变，保证内容不可变部分的完整性。
 */

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const ZSTD_MAGIC = 0xfd2fb528;

/** 路径 → 会话目录名：`--E-~6587~6863-film--`（冒号丢弃，分隔符变 -） */
export function encodeCwd(cwd) {
  const normalized = String(cwd).replace(/[:/\\]/g, (ch) => (ch === '\\' || ch === '/' ? '\\' : ''));
  let out = '';
  for (const ch of normalized) {
    if (/[A-Za-z0-9-]/.test(ch)) out += ch;
    else if (ch === '\\') out += '-';
    else if (ch === ' ') out += '~0020';
    else out += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `--${out}--`;
}

/** 仅用于展示：连字符会与路径分隔符混淆，权威路径始终取自会话 header。 */
export function decodeCwd(dirName) {
  if (!dirName.startsWith('--') || !dirName.endsWith('--')) return null;
  const body = dirName.slice(2, -2).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
  const restored = body.replace(/-/g, '\\');
  return restored.replace(/^([A-Za-z])\\?/, '$1:\\');
}

/** 解析一个 zstd 帧的字节长度；失败返回 -1。 */
export function frameLength(buffer, offset = 0) {
  if (offset + 6 > buffer.length) return -1;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return -1;
  let cursor = offset + 4;
  const descriptor = buffer[cursor];
  cursor += 1;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictFlag = descriptor & 3;

  if (!singleSegment) cursor += 1; // Window_Descriptor
  cursor += [0, 1, 2, 4][dictFlag];
  if (fcsFlag === 0) {
    if (singleSegment) cursor += 1;
  } else cursor += [0, 2, 4, 8][fcsFlag];

  for (;;) {
    if (cursor + 3 > buffer.length) return -1;
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
    cursor += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    cursor += type === 1 ? 1 : size;
    if (last) break;
    if (cursor > buffer.length) return -1;
  }
  if (checksum) cursor += 4;
  return cursor - offset;
}

export function countFrames(buffer) {
  let offset = 0;
  let frames = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === ZSTD_MAGIC) {
    const length = frameLength(buffer, offset);
    if (length <= 0) break;
    offset += length;
    frames += 1;
    if (frames > 200000) break;
  }
  return frames;
}

/** 读首帧，返回 header 对象与首帧长度。 */
export function readHeader(buffer) {
  const length = frameLength(buffer, 0);
  if (length <= 0) throw new Error('不是有效的 zstd 会话日志');
  const text = zstdDecompressSync(buffer.subarray(0, length)).toString('utf8');
  const lines = text.split('\n');
  const header = JSON.parse(lines[0]);
  return { header, firstFrameLength: length, firstFrameText: text };
}

/** 只改首帧 header 的 cwd，其余帧原样保留。 */
export function rewriteCwd(buffer, newCwd) {
  const { header, firstFrameLength, firstFrameText } = readHeader(buffer);
  if (header.cwd === newCwd) return { changed: false, buffer };
  const previousCwd = header.cwd;
  header.cwd = newCwd;
  const lines = firstFrameText.split('\n');
  lines[0] = JSON.stringify(header);
  const rebuilt = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'));
  return {
    changed: true,
    buffer: Buffer.concat([rebuilt, buffer.subarray(firstFrameLength)]),
    previousCwd,
  };
}

/** 原子写回：临时文件 + rename。 */
export async function writeFileAtomic(path, data) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/** 列出一个 sessions 根下的全部会话。 */
export async function listSessions(sessionsRoot) {
  const result = [];
  let workspaceDirs = [];
  try {
    workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory()) continue;
    const workspacePath = decodeCwd(entry.name);
    const sessionDirs = await readdir(join(sessionsRoot, entry.name), { withFileTypes: true }).catch(() => []);
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory() || !sessionEntry.name.startsWith('session-')) continue;
      const dir = join(sessionsRoot, entry.name, sessionEntry.name);
      const files = await readdir(dir).catch(() => []);
      const logName = files.find((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name));
      if (!logName) continue;
      const file = join(dir, logName);
      const info = await stat(file).catch(() => null);
      let cwd = null;
      let frames = 0;
      try {
        const buffer = await readFile(file);
        frames = countFrames(buffer);
        cwd = readHeader(buffer).header.cwd;
      } catch {
        cwd = workspacePath;
      }
      result.push({
        id: sessionEntry.name,
        cwd,
        workspaceDir: entry.name,
        workspacePath,
        file,
        logFile: logName,
        sizeBytes: info?.size ?? 0,
        frames,
        modifiedAt: info?.mtime?.toISOString() ?? null,
      });
    }
  }
  return result;
}
