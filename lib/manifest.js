/**
 * 第九通路 — 备份清单（manifest.json）。插件、脚本、提示词三方共用的唯一契约。
 *
 * 规则：manifestVersion 只增不改；旧字段语义永不修改；新字段可加。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const INCOMPLETE_MARKER = '.incomplete';
export const PROMPT_FILE = '恢复说明.txt';

const LAYER_KEYS = ['host', 'workspaces', 'attachments'];

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 生成一份空骨架，调用方填完再写盘。 */
export function emptyManifest({ kitId, createdAt, createdBy, source }) {
  return {
    manifestVersion: MANIFEST_VERSION,
    kitId,
    createdAt: createdAt ?? new Date().toISOString(),
    complete: false,
    createdBy,
    source,
    layers: {
      host: { sizeBytes: 0, fileCount: 0, sha256: null },
      workspaces: { sizeBytes: 0, fileCount: 0, sha256: null },
      attachments: { sizeBytes: 0, fileCount: 0, sha256: null },
    },
    workspaces: [],
    excluded: { sessions: [], workspaces: [], reason: '' },
    warnings: [],
    plugin: { name: '', version: '', peerRange: '', source: 'local-dir', subdir: 'plugin/' },
    installer: { present: false },
    credentials: { included: false, redacted: [], note: '' },
    prompt: { file: PROMPT_FILE, encoding: 'utf-8-bom' },
    checksums: { file: 'SHA256SUMS.txt', algorithm: 'sha256' },
  };
}

/** 返回 { ok, errors }；errors 是中文可读句子，直接进报告。 */
export function validateManifest(value) {
  const errors = [];
  const push = (message) => errors.push(message);

  if (!value || typeof value !== 'object') return { ok: false, errors: ['清单不是对象'] };

  if (value.manifestVersion !== MANIFEST_VERSION) {
    push(`清单版本 ${value.manifestVersion} 与当前支持的 ${MANIFEST_VERSION} 不符`);
  }
  if (!isString(value.kitId)) push('缺少 kitId');
  if (!isString(value.createdAt)) push('缺少 createdAt');
  if (typeof value.complete !== 'boolean') push('缺少 complete 标记');

  const created = value.createdBy ?? {};
  if (!isString(created.dshVersion)) push('缺少 createdBy.dshVersion');
  if (!isString(created.sessionFormat)) push('缺少 createdBy.sessionFormat');

  if (!value.layers || typeof value.layers !== 'object') push('缺少 layers');
  else {
    for (const key of LAYER_KEYS) {
      if (!value.layers[key]) push(`缺少 layers.${key}`);
      else if (!isNumber(value.layers[key].sizeBytes)) push(`layers.${key}.sizeBytes 无效`);
    }
  }

  if (!Array.isArray(value.workspaces)) push('workspaces 必须是数组');
  else {
    value.workspaces.forEach((workspace, index) => {
      const at = `workspaces[${index}]`;
      if (!isString(workspace.id)) push(`${at}.id 缺失`);
      if (!isString(workspace.path)) push(`${at}.path 缺失`);
      if (!Array.isArray(workspace.sessionIds)) push(`${at}.sessionIds 必须是数组`);
      if (!Array.isArray(workspace.sessions)) push(`${at}.sessions 必须是数组`);
      else {
        workspace.sessions.forEach((session, sessionIndex) => {
          const label = `${at}.sessions[${sessionIndex}]`;
          if (!isString(session.id)) push(`${label}.id 缺失`);
          if (!isString(session.cwd)) push(`${label}.cwd 缺失`);
          if (!isString(session.logFile)) push(`${label}.logFile 缺失`);
          if (!isNumber(session.frames)) push(`${label}.frames 缺失`);
        });
      }
    });
  }

  if (!value.excluded || typeof value.excluded !== 'object') push('缺少 excluded');
  return { ok: errors.length === 0, errors };
}

/** 目标路径是否落在 root 之内（含相等）。 */
export function isInside(root, child) {
  const base = resolve(root);
  const target = resolve(child);
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${'/'}`) && !rel.startsWith('..\\') && !isAbsolute(rel));
}

/** 清单里的路径一律用它把关；越界直接拒绝，不给"尽力而为"的余地。 */
export function assertInside(root, child, label) {
  if (!isInside(root, child)) {
    throw new Error(`${label} 越出备份目录：${child}`);
  }
}

/** 语义化版本解析，保留预发布段（rc.2 → pre = "rc.2"）。 */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNumeric) return -1;
    else if (yNumeric) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return Number.NaN;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/**
 * 恢复前的兼容性判定：major.minor 必须一致，patch 差异只警告，格式代际必须相同。
 * level: 'ok' | 'warn' | 'block'
 */
const UNKNOWN_VERSIONS = new Set(['', 'unknown', 'undefined', 'null', 'n/a']);

export function checkCompat(manifest, current) {
  const warnings = [];
  const blockers = [];

  if (manifest?.complete !== true) blockers.push('这份备份没有标记为完成，恢复一律拒收');

  const saved = manifest?.createdBy ?? {};
  if (saved.sessionFormat !== current.sessionFormat) {
    blockers.push(`会话格式代际不同：备份为 ${saved.sessionFormat}，当前为 ${current.sessionFormat}`);
  }

  const savedVersion = String(saved.dshVersion ?? '').trim();
  const currentVersion = String(current.dshVersion ?? '').trim();
  const left = parseVersion(savedVersion);
  const right = parseVersion(currentVersion);

  // unknown 表示没采集到版本，不是数据损坏：降级为警告，仍靠格式代际把关
  if (UNKNOWN_VERSIONS.has(savedVersion.toLowerCase()) || UNKNOWN_VERSIONS.has(currentVersion.toLowerCase())) {
    warnings.push('版本号未知，跳过版本比对；会话格式代际仍已校验');
  } else if (!left || !right) {
    blockers.push(`版本号无法解析（备份 ${savedVersion}，当前 ${currentVersion}），无法确认兼容性`);
  } else if (left.major !== right.major) {
    blockers.push(`主版本不同（备份 ${saved.dshVersion}，当前 ${current.dshVersion}）`);
  } else if (left.minor !== right.minor) {
    blockers.push(`次版本不同（备份 ${saved.dshVersion}，当前 ${current.dshVersion}）`);
  } else if (compareVersions(saved.dshVersion, current.dshVersion) !== 0) {
    warnings.push(`版本不完全一致（备份 ${saved.dshVersion}，当前 ${current.dshVersion}）`);
  }

  const level = blockers.length ? 'block' : warnings.length ? 'warn' : 'ok';
  return { level, blockers, warnings };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** 写 JSON：先写临时文件再 rename，避免留下半截。 */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readManifest(path) {
  const manifest = await readJson(path);
  const { ok, errors } = validateManifest(manifest);
  return { manifest, ok, errors };
}

/** 打包期间用 .incomplete 占位；完成时清掉并写 complete: true。 */
export async function markIncomplete(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, INCOMPLETE_MARKER), `${new Date().toISOString()}\n`, 'utf8');
}

export async function clearIncomplete(root) {
  await rm(join(root, INCOMPLETE_MARKER), { force: true });
}

export async function isIncomplete(root) {
  try {
    await stat(join(root, INCOMPLETE_MARKER));
    return true;
  } catch {
    return false;
  }
}

/** 计算目录/文件体积与文件数，用于空间预检。 */
export async function measureTree(path) {
  const result = { sizeBytes: 0, fileCount: 0 };
  const { readdir } = await import('node:fs/promises');
  async function walk(target) {
    let info;
    try {
      info = await stat(target);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(target)) await walk(join(target, name));
    } else if (info.isFile()) {
      result.sizeBytes += info.size;
      result.fileCount += 1;
    }
  }
  await walk(path);
  return result;
}

/** 目标卷空间检查：预计体积 × 余量系数 + 固定保留。目标目录可能还不存在，向上找可访问的祖先。 */
export async function checkSpace(targetDir, estimatedBytes) {
  const { statfs } = await import('node:fs/promises');
  let probe = targetDir;
  let info = null;
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      info = await statfs(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (!parent || parent === probe) break;
      probe = parent;
    }
  }
  const needed = Math.ceil(estimatedBytes * 1.2) + 5 * 1024 ** 3;
  if (!info) return { free: 0, needed, ok: false, error: '无法读取目标盘空间' };
  const free = Number(info.bavail) * Number(info.bsize);
  return { free, needed, ok: free >= needed, probe };
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 打开文件并独占，用于备份锁。 */
export async function acquireLock(root) {
  const lockPath = join(root, '.ninth-path.lock');
  await mkdir(root, { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return async () => {
      await handle.close();
      await rm(lockPath, { force: true });
    };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const holder = await readFile(lockPath, 'utf8').catch(() => '');
      throw new Error(`备份目录正被占用（锁内容：${holder.trim().split('\n')[0] || '未知'}）。确认没有其它备份在进行后，删除 ${lockPath} 再试。`);
    }
    throw error;
  }
}
