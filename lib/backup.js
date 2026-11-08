/** 第九通路 — 备份执行。 */

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, parse, relative } from 'node:path';

import {
  MANIFEST_FILE,
  PROMPT_FILE,
  acquireLock,
  checkSpace,
  clearIncomplete,
  emptyManifest,
  formatBytes,
  markIncomplete,
  measureTree,
  sha256File,
  writeJsonAtomic,
} from './manifest.js';
import { listSessions } from './session-log.js';
import { encodeCwd } from './session-log.js';
import { MANUAL_FILE, VERSION, buildManual, buildPrompt, withBom } from './prompt.js';

const KIT_PREFIX = '第九通路备份';
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', '.svn', '.hg', 'cache', 'tmp', '.tmp']);
const EXCLUDED_FILE_PATTERNS = [/\.tmp(\..*)?$/, /\.lock$/, /^\.incomplete$/, /^\.ninth-path\.lock$/];

/** 目标是否落在系统卷上。 */
export function isSystemVolume(target) {
  const systemDrive = (process.env.SystemDrive ?? 'C:').slice(0, 2).toUpperCase();
  const root = parse(target).root.slice(0, 2).toUpperCase();
  if (!/^[A-Z]:$/.test(root)) return false; // UNC 或相对路径交给人判断
  return root === systemDrive;
}

/** 找一个可用的同版本客户端安装包（来自更新缓存）。 */
export function detectInstaller() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(join(localAppData, '@deepseek-aidsh-desktop-updater', 'installer.exe'));
    candidates.push(join(localAppData, 'deepseek-harness-updater', 'installer.exe'));
  }
  const programFiles = process.env.PROGRAMFILES;
  if (programFiles) candidates.push(join(programFiles, 'DeepSeek Harness', 'installer.exe'));
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function safeDirName(path) {
  const parsed = parse(path);
  const body = path
    .slice(parsed.root.length)
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[\\/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${parsed.root.slice(0, 1)}-${body}`.slice(0, 80) || 'workspace';
}

function shouldSkipFile(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function workspaceFilter(patterns) {
  const lowered = patterns.map((p) => p.toLowerCase());
  return (src, dest) => {
    const name = basename(src).toLowerCase();
    if (EXCLUDED_DIR_NAMES.has(name)) return false;
    if (lowered.includes(name)) return false;
    if (shouldSkipFile(name)) return false;
    return true;
  };
}

/** 复制并回报结果，绝不静默吞掉错误。可选内容失败记 warning，核心内容另行处理。 */
async function copyTree(source, destination, filter) {
  try {
    await cp(source, destination, { recursive: true, force: true, errorOnExist: false, filter });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

function sessionFilter(excludeIds) {
  return (src) => {
    const name = basename(src);
    if (shouldSkipFile(name)) return false;
    if (excludeIds.has(name)) return false;
    return true;
  };
}

async function readWorkspaceTable(dshHome) {
  const path = join(dshHome, 'storages', 'workspace.json');
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const table = raw?.tables?.workspaces ?? {};
    return Object.entries(table).map(([id, value]) => ({ id, ...value }));
  } catch {
    return [];
  }
}

async function listAgentsFiles(dshHome) {
  try {
    const names = await readdir(dshHome);
    return names.filter((name) => name === 'AGENTS.md' || name.startsWith('AGENTS.md.'));
  } catch {
    return [];
  }
}

async function hashTree(root) {
  const files = [];
  const { readdir: read } = await import('node:fs/promises');
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await read(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files.push({ full, rel });
    }
  }
  await walk(root, '');
  const digest = [];
  for (const file of files) digest.push(`${file.rel}:${await sha256File(file.full)}`);
  const { createHash } = await import('node:crypto');
  return {
    sha256: createHash('sha256').update(digest.join('\n')).digest('hex'),
    fileCount: files.length,
  };
}

/** 备份前的预估：告诉用户要占多少空间，并判断目标卷。 */
export async function planBackup({ dshHome, targetRoot, layers, excludeSessionIds = [], excludeWorkspaceIds = [] }) {
  const workspaces = await readWorkspaceTable(dshHome);
  const sessions = await listSessions(join(dshHome, 'sessions'));
  const excluded = new Set(excludeSessionIds);

  // 只有登记在工作区名下的会话会被备份；其余如实报出，不悄悄漏掉
  const assigned = new Set();
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds ?? []) assigned.add(id);
  }
  const hostSessions = sessions.filter((s) => !excluded.has(s.id));
  const assignedSessions = hostSessions.filter((s) => assigned.has(s.id));
  const unassigned = hostSessions.filter((s) => !assigned.has(s.id));

  let estimated = assignedSessions.reduce((sum, s) => sum + s.sizeBytes, 0);

  const chosen = (layers?.workspaceIds ?? []).filter((id) => !excludeWorkspaceIds.includes(id));
  for (const id of chosen) {
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) continue;
    estimated += (await measureTree(workspace.path)).sizeBytes;
  }
  if (layers?.attachments) estimated += (await measureTree(join(dshHome, 'attachments'))).sizeBytes;

  const installer = detectInstaller();
  const installerSize = installer ? (await stat(installer).catch(() => ({ size: 0 }))).size : 0;
  estimated += installerSize;

  return {
    systemVolume: isSystemVolume(targetRoot),
    targetRoot,
    estimatedBytes: estimated,
    estimatedText: formatBytes(estimated),
    sessionCount: assignedSessions.length,
    unassignedSessions: {
      count: unassigned.length,
      sizeBytes: unassigned.reduce((sum, s) => sum + s.sizeBytes, 0),
      ids: unassigned.map((s) => s.id),
      reason: '未登记在任何工作区名下，按设计不进备份',
    },
    workspaces: workspaces.map((w) => ({
      id: w.id,
      path: w.path,
      title: w.title,
      sessionCount: (w.sessionIds ?? []).length,
      chosen: chosen.includes(w.id),
    })),
    installer: installer ? { path: installer, size: installerSize } : null,
    space: await checkSpace(targetRoot, estimated),
  };
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 执行备份，返回 { kitDir, kitName, manifest, summary }。 */
export async function runBackup({
  dshHome,
  targetRoot,
  layers = { host: true, workspaceIds: [], attachments: false },
  excludeSessionIds = [],
  excludeWorkspaceIds = [],
  includeInstaller = true,
  includePlugin = true,
  pluginDir,
  createdBy = {},
  source = {},
}) {
  if (isSystemVolume(targetRoot)) {
    throw new Error(`备份目标位于系统卷（${targetRoot}）。请换到非系统盘，否则重装系统时备份会一起消失。`);
  }

  const plan = await planBackup({ dshHome, targetRoot, layers, excludeSessionIds, excludeWorkspaceIds });
  if (plan.space && !plan.space.ok) {
    throw new Error(
      plan.space.error
        ? `无法确认目标盘空间：${plan.space.error}`
        : `目标盘空间不足：可用 ${formatBytes(plan.space.free)}，需要约 ${formatBytes(plan.space.needed)}。`,
    );
  }

  const kitName = `${KIT_PREFIX}-${timestamp()}`;
  const kitDir = join(targetRoot, kitName);
  const release = await acquireLock(targetRoot);
  const warnings = [];

  try {
    await markIncomplete(kitDir);
    const manifest = emptyManifest({
      kitId: kitName,
      createdBy: { dshVersion: 'unknown', sessionFormat: 'v4', profile: '', os: process.platform, hostname: '', username: '', ...createdBy },
      source: { dshHome, systemVolume: `${(process.env.SystemDrive ?? 'C:').slice(0, 2)}`, targetVolume: parse(targetRoot).root.slice(0, 2), ...source },
    });

    const sessionsRoot = join(dshHome, 'sessions');
    const sessionList = await listSessions(sessionsRoot);
    const excluded = new Set(excludeSessionIds);
    const workspaceTable = await readWorkspaceTable(dshHome);
    const keepWorkspaces = (layers.workspaceIds ?? []).filter((id) => !excludeWorkspaceIds.includes(id));

    // 未归属工作区的会话不备份，但要在清单里说明，避免"看起来少了几条"
    const assignedIds = new Set();
    for (const workspace of workspaceTable) {
      for (const id of workspace.sessionIds ?? []) assignedIds.add(id);
    }
    const unassignedSessions = sessionList.filter(
      (session) => !assignedIds.has(session.id) && !excluded.has(session.id),
    );
    const unassignedIds = unassignedSessions.map((session) => session.id);
    const unassignedBytes = unassignedSessions.reduce((sum, session) => sum + session.sizeBytes, 0);

    // ---- host ----
    if (layers.host !== false) {
      const hostDir = join(kitDir, 'host');
      await mkdir(join(hostDir, 'storages'), { recursive: true });
      const filter = sessionFilter(excluded);
      // 会话是核心数据：复制失败必须让整次备份失败，不能产出"看起来完整"的包
      await cp(sessionsRoot, join(hostDir, 'sessions'), { recursive: true, filter, force: true, errorOnExist: false });

      for (const name of ['storages', 'skills', 'llm-deepseek']) {
        const source = join(dshHome, name);
        if (!existsSync(source)) continue;
        const copied = await copyTree(source, join(hostDir, name), (src) => !EXCLUDED_DIR_NAMES.has(basename(src).toLowerCase()));
        if (!copied.ok) warnings.push(`${name} 复制失败：${copied.error}`);
      }
      const settings = join(dshHome, 'settings.yaml');
      if (existsSync(settings)) {
        const copied = await copyTree(settings, join(hostDir, 'settings.yaml'));
        if (!copied.ok) warnings.push(`settings.yaml 复制失败：${copied.error}`);
      }

      for (const name of await listAgentsFiles(dshHome)) {
        const copied = await copyTree(join(dshHome, name), join(hostDir, name));
        if (!copied.ok) warnings.push(`${name} 复制失败：${copied.error}`);
      }

      const hostStats = await measureTree(hostDir);
      const hostHash = await hashTree(hostDir);
      manifest.layers.host = {
        sizeBytes: hostStats.sizeBytes,
        fileCount: hostStats.fileCount,
        sha256: hostHash.sha256,
        agentsFiles: await listAgentsFiles(dshHome),
      };

      for (const workspace of workspaceTable) {
        const kept = keepWorkspaces.includes(workspace.id) ? 'chosen' : 'not-chosen';
        const sessions = sessionList.filter((s) => (workspace.sessionIds ?? []).includes(s.id) && !excluded.has(s.id));
        const cwd = sessions[0]?.cwd ?? workspace.path;
        manifest.workspaces.push({
          id: workspace.id,
          path: workspace.path,
          title: workspace.title ?? '',
          cwd,
          sessionIds: sessions.map((s) => s.id),
          sessions: sessions.map((s) => ({
            id: s.id,
            cwd: s.cwd,
            title: '',
            logFile: s.logFile,
            frames: s.frames,
            sizeBytes: s.sizeBytes,
            sha256: null,
          })),
          files: { included: kept === 'chosen', subdir: kept === 'chosen' ? `workspaces/${safeDirName(workspace.path)}` : null, excludedPatterns: [...EXCLUDED_DIR_NAMES], sizeBytes: 0 },
        });
      }
      manifest.excluded.sessions = [...excluded];
      manifest.excluded.workspaces = [...excludeWorkspaceIds];
      manifest.excluded.unassignedSessions = {
        count: unassignedIds.length,
        sizeBytes: unassignedBytes,
        ids: unassignedIds,
        reason: '未登记在任何工作区名下，按设计不进备份',
      };
      manifest.excluded.reason = '执行备份的会话 / 备份工作区';
    }

    // ---- workspaces 文件 ----
    if ((layers.workspaceIds ?? []).length > 0) {
      const stats = { sizeBytes: 0, fileCount: 0 };
      for (const id of keepWorkspaces) {
        const workspace = workspaceTable.find((w) => w.id === id);
        if (!workspace) continue;
        const dirName = safeDirName(workspace.path);
        const copied = await copyTree(
          workspace.path,
          join(kitDir, 'workspaces', dirName),
          workspaceFilter([...EXCLUDED_DIR_NAMES]),
        );
        if (!copied.ok) warnings.push(`工作区文件复制失败（${workspace.path}）：${copied.error}`);
        const measured = await measureTree(join(kitDir, 'workspaces', dirName));
        stats.sizeBytes += measured.sizeBytes;
        stats.fileCount += measured.fileCount;
        const entry = manifest.workspaces.find((w) => w.id === id);
        if (entry) {
          entry.files = {
            included: copied.ok,
            subdir: `workspaces/${dirName}`,
            excludedPatterns: [...EXCLUDED_DIR_NAMES],
            sizeBytes: measured.sizeBytes,
          };
        }
      }
      manifest.layers.workspaces = {
        ...stats,
        sha256: (await hashTree(join(kitDir, 'workspaces'))).sha256,
      };
    }

    // ---- attachments ----
    if (layers.attachments) {
      const source = join(dshHome, 'attachments');
      if (existsSync(source)) {
        const copied = await copyTree(source, join(kitDir, 'attachments'));
        if (!copied.ok) warnings.push(`附件复制失败：${copied.error}`);
      }
      const measured = await measureTree(join(kitDir, 'attachments'));
      manifest.layers.attachments = {
        ...measured,
        sha256: (await hashTree(join(kitDir, 'attachments'))).sha256,
      };
    }

    // ---- 插件包 ----
    if (includePlugin && pluginDir) {
      const target = join(kitDir, 'plugin');
      const copied = await copyTree(pluginDir, target, (src) => {
        const name = basename(src);
        if (name === 'node_modules' || name === '.git' || name === 'test' || name === 'dist') return false;
        return !shouldSkipFile(name);
      });
      if (!copied.ok) {
        warnings.push(`插件包复制失败：${copied.error}。恢复时需自备插件。`);
      }
      manifest.plugin = {
        name: '@wuyinui/dsh-ninth-path',
        version: VERSION,
        peerRange: `^${VERSION.split('.')[0]}.${VERSION.split('.')[1]}.0`,
        source: copied.ok ? 'local-dir' : 'missing',
        subdir: 'plugin/',
      };
    }

    // ---- 安装包 ----
    if (includeInstaller) {
      const installer = detectInstaller();
      if (installer) {
        const name = `DSH-${createdBy.dshVersion ?? 'unknown'}.exe`;
        await mkdir(join(kitDir, 'installer'), { recursive: true });
        const copied = await copyTree(installer, join(kitDir, 'installer', name));
        if (!copied.ok) {
          warnings.push(`安装包复制失败：${copied.error}`);
          manifest.installer = { present: false, reason: `更新缓存里的安装包无法复制：${copied.error}` };
        } else {
          manifest.installer = {
            present: true,
            subdir: 'installer/',
            file: name,
            version: createdBy.dshVersion ?? 'unknown',
            origin: 'updater-cache',
            sha256: await sha256File(join(kitDir, 'installer', name)).catch(() => null),
          };
        }
      } else {
        manifest.installer = { present: false, reason: '未在更新缓存中找到安装包，恢复时请自备同版本安装程序' };
      }
    }

    // ---- 会话哈希 ----
    await fillSessionHashes(kitDir, manifest);

    // 编码碰撞检测：不同工作区落在同一会话目录时，恢复会互相覆盖
    const collisions = new Map();
    for (const workspace of manifest.workspaces) {
      const dir = encodeCwd(workspace.cwd ?? workspace.path);
      const previous = collisions.get(dir);
      if (previous && previous !== workspace.id) {
        warnings.push(`工作区 ${previous} 与 ${workspace.id} 的路径编码相同（${dir}），恢复时可能互相覆盖`);
      } else {
        collisions.set(dir, workspace.id);
      }
    }

    manifest.warnings = warnings;
    manifest.complete = true;
    await writeJsonAtomic(join(kitDir, MANIFEST_FILE), manifest);
    await writeTexts(kitDir, manifest);
    await writeChecksums(kitDir);
    await clearIncomplete(kitDir);

    const total = await measureTree(kitDir);
    return {
      kitDir,
      kitName,
      manifest,
      summary: {
        kitDir,
        size: formatBytes(total.sizeBytes),
        fileCount: total.fileCount,
        hostSize: formatBytes(manifest.layers.host.sizeBytes),
        workspaceSize: formatBytes(manifest.layers.workspaces.sizeBytes),
        attachmentSize: formatBytes(manifest.layers.attachments.sizeBytes),
        installer: manifest.installer?.present ? manifest.installer.file : '未找到',
        sessions: manifest.workspaces.reduce((sum, w) => sum + w.sessions.length, 0),
        unassigned: unassignedIds.length,
        workspaces: manifest.workspaces.length,
      },
    };
  } finally {
    await release();
  }
}

async function fillSessionHashes(kitDir, manifest) {
  const sessionsDir = join(kitDir, 'host', 'sessions');
  for (const workspace of manifest.workspaces) {
    for (const session of workspace.sessions) {
      const file = join(sessionsDir, encodeCwd(session.cwd), session.id, session.logFile);
      if (existsSync(file)) session.sha256 = await sha256File(file).catch(() => null);
    }
  }
}

async function writeTexts(kitDir, manifest) {
  const workspaces = manifest.workspaces.map((w) => ({ path: w.path }));
  await writeFile(
    join(kitDir, PROMPT_FILE),
    withBom(
      buildPrompt({
        kitName: manifest.kitId,
        hostVersion: manifest.createdBy.dshVersion,
        sessionFormat: manifest.createdBy.sessionFormat,
        workspaces,
        createdAt: manifest.createdAt,
      }),
    ),
    'utf8',
  );
  await writeFile(join(kitDir, MANUAL_FILE), withBom(buildManual()), 'utf8');
}

async function writeChecksums(kitDir) {
  const { readdir: read } = await import('node:fs/promises');
  const lines = [];
  async function walk(dir, prefix) {
    const entries = await read(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const rel = relative(kitDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile() && entry.name !== 'SHA256SUMS.txt') {
        lines.push(`${await sha256File(full)}  ${rel}`);
      }
    }
  }
  await walk(kitDir, '');
  await writeFile(join(kitDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
}
