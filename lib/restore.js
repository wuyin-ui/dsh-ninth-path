/** 第九通路 — 恢复执行。合并写入，绝不整体替换。 */

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  MANIFEST_FILE,
  PROMPT_FILE,
  checkCompat,
  formatBytes,
  isInside,
  isIncomplete,
  measureTree,
  readManifest,
  sha256File,
  writeJsonAtomic,
} from './manifest.js';
import { encodeCwd, listSessions, readHeader, rewriteCwd, writeFileAtomic } from './session-log.js';
import { buildDocx } from './docx.js';

const AGENTS_MAIN = 'AGENTS.md';

/** 读清单并判断兼容性，同时给出每个工作区的建议模式。 */
export async function planRestore({ kitDir, dshHome, currentVersion, sessionFormat }) {
  if (await isIncomplete(kitDir)) {
    throw new Error('这份备份没有完成（存在 .incomplete 标记），不能用于恢复。');
  }
  const { manifest, ok, errors } = await readManifest(join(kitDir, MANIFEST_FILE));
  if (!ok) throw new Error(`清单校验失败：${errors.join('；')}`);

  const compat = checkCompat(manifest, { dshVersion: currentVersion, sessionFormat });
  const workspaces = [];
  for (const workspace of manifest.workspaces) {
    const exists = existsSync(workspace.path);
    const subdir = workspace.files?.subdir;
    const filesInKit =
      workspace.files?.included === true &&
      typeof subdir === 'string' &&
      isInside(kitDir, resolve(kitDir, subdir)) &&
      existsSync(resolve(kitDir, subdir));
    workspaces.push({
      id: workspace.id,
      oldPath: workspace.path,
      title: workspace.title,
      sessionCount: workspace.sessions.length,
      oldPathExists: exists,
      filesInKit,
      suggestedMode: exists ? 'reuse' : 'ask',
      question: exists
        ? null
        : `工作区「${workspace.title || workspace.path}」的旧路径 ${workspace.path} 在新系统上不存在。要恢复到哪里？指定新路径，或直接用备份里的副本，也可以跳过。`,
    });
  }

  return {
    kitDir,
    manifest,
    compat,
    workspaces,
    needQuestions: workspaces.filter((w) => w.suggestedMode !== 'reuse'),
    hasAgents: (manifest.layers?.host?.agentsFiles ?? []).some((name) => name.startsWith(AGENTS_MAIN)),
    layers: {
      host: (manifest.layers?.host?.sizeBytes ?? 0) > 0,
      workspaces: (manifest.layers?.workspaces?.sizeBytes ?? 0) > 0,
      attachments: (manifest.layers?.attachments?.sizeBytes ?? 0) > 0,
    },
    promptFile: join(kitDir, manifest.prompt?.file ?? PROMPT_FILE),
  };
}

/** 找出目标目录里已经存在、会被覆盖的文件（相对路径），用于先备份再覆盖。 */
async function collectConflicts(sourceDir, targetDir) {
  if (!existsSync(targetDir)) return [];
  const conflicts = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const sourcePath = join(dir, entry.name);
      const targetPath = join(targetDir, rel);
      if (entry.isDirectory()) {
        if (existsSync(targetPath)) await walk(sourcePath, rel);
      } else if (entry.isFile() && existsSync(targetPath)) {
        conflicts.push(rel);
      }
    }
  }
  await walk(sourceDir, '');
  return conflicts;
}

function resolveTargetPath(mapping, workspace, kitDir) {
  const entry = mapping.workspaces?.find((w) => w.id === workspace.id);
  const mode = entry?.mode ?? 'reuse';
  if (mode === 'skip') return { mode, path: null };
  if (mode === 'newPath') {
    if (!entry.newPath) throw new Error(`工作区 ${workspace.path} 选择了新路径，但没有提供路径`);
    return { mode, path: entry.newPath };
  }
  if (mode === 'inKit') {
    const subdir = workspace.files?.subdir;
    if (!subdir) throw new Error(`备份里没有工作区 ${workspace.path} 的文件副本，无法原地使用`);
    const path = resolve(kitDir, subdir);
    if (!isInside(kitDir, path)) throw new Error(`工作区副本路径越出备份目录：${subdir}`);
    return { mode, path };
  }
  return { mode: 'reuse', path: workspace.path };
}

/** 合并现有 workspace.json 与新恢复的工作区记录。 */
function mergeWorkspaceTable(current, incoming, resolved) {
  const next = current ? structuredClone(current) : { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: {} } };
  next.tables ??= {};
  next.tables.workspaces ??= {};
  next.global ??= {};
  next.global.workspaceIds ??= [];

  const byPath = new Map();
  for (const [id, record] of Object.entries(next.tables.workspaces)) {
    byPath.set(String(record.path).toLowerCase(), id);
  }

  for (const entry of resolved) {
    if (entry.mode === 'skip' || !entry.path) continue;
    const key = String(entry.path).toLowerCase();
    const existingId = byPath.get(key);
    if (existingId) {
      const record = next.tables.workspaces[existingId];
      const merged = new Set([...(record.sessionIds ?? []), ...entry.sessionIds]);
      record.sessionIds = [...merged];
      record.updatedAt = new Date().toISOString();
      continue;
    }
    const id = next.tables.workspaces[entry.originalId] ? randomUUID() : entry.originalId;
    next.tables.workspaces[id] = {
      path: entry.path,
      title: entry.title ?? basename(entry.path),
      sessionIds: entry.sessionIds,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!next.global.workspaceIds.includes(id)) next.global.workspaceIds.push(id);
    byPath.set(key, id);
  }

  next.global.issuedWorkspaceId ??= randomUUID();
  return next;
}

/** 恢复执行。mapping: { workspaces: [{id, mode, newPath}], agentsMd, layers, excludeSessionIds } */
export async function applyRestore({ kitDir, dshHome, mapping, currentVersion }) {
  const plan = await planRestore({
    kitDir,
    dshHome,
    currentVersion,
    sessionFormat: mapping.sessionFormat ?? 'v4',
  });
  if (plan.compat.level === 'block') {
    throw new Error(`版本不兼容，已停止：${plan.compat.blockers.join('；')}`);
  }

  const warnings = [...(plan.manifest.warnings ?? []), ...plan.compat.warnings];
  const excluded = new Set(mapping.excludeSessionIds ?? []);
  const restored = [];
  const stamp = Date.now();

  // 1. 快照现有数据：拍不了就不动，避免"没有回头路"的写入
  const snapshot = `${dshHome}.pre-restore-${stamp}`;
  if (existsSync(dshHome)) {
    try {
      await cp(dshHome, snapshot, { recursive: true, force: true, errorOnExist: false });
    } catch (error) {
      if (!mapping.allowNoSnapshot) {
        throw new Error(
          `现有数据快照失败，已停止：${error.message}。确认要跳过快照时，传 allowNoSnapshot 再试。`,
        );
      }
      warnings.push(`现有数据快照失败，按用户要求继续：${error.message}`);
    }
  }

  // 2. 会话
  const sessionsDir = join(dshHome, 'sessions');
  const sessionsSourceRoot = resolve(kitDir, 'host', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const dirOwners = new Map();
  const overwritten = new Set();
  for (const workspace of plan.manifest.workspaces) {
    const target = resolveTargetPath(mapping, workspace, kitDir);
    if (target.mode === 'skip' || !target.path) {
      restored.push({ id: workspace.id, oldPath: workspace.path, mode: 'skip', path: null, sessions: 0, files: false });
      continue;
    }
    const targetDir = join(sessionsDir, encodeCwd(target.path));
    const owner = dirOwners.get(targetDir);
    if (owner && owner !== workspace.id) {
      warnings.push(`工作区 ${owner} 与 ${workspace.id} 的目标目录相同（${encodeCwd(target.path)}），已跳过后者`);
      restored.push({ id: workspace.id, oldPath: workspace.path, mode: target.mode, path: target.path, sessions: 0, files: false, skipped: '目录碰撞' });
      continue;
    }
    dirOwners.set(targetDir, workspace.id);

    let copied = 0;
    for (const session of workspace.sessions) {
      if (excluded.has(session.id)) continue;
      const source = resolve(sessionsSourceRoot, encodeCwd(session.cwd), session.id, session.logFile);
      if (!isInside(sessionsSourceRoot, source)) {
        warnings.push(`会话 ${session.id} 的路径越出备份目录，已跳过`);
        continue;
      }
      if (!existsSync(source)) {
        warnings.push(`会话 ${session.id} 在备份中缺失`);
        continue;
      }
      if (session.sha256) {
        const actual = await sha256File(source).catch(() => null);
        if (actual !== session.sha256) {
          warnings.push(`会话 ${session.id} 哈希不符（备份损坏或被改动），已跳过`);
          continue;
        }
      }
      const destinationDir = join(targetDir, session.id);
      await mkdir(destinationDir, { recursive: true });
      const destination = join(destinationDir, session.logFile);
      if (existsSync(destination) && !overwritten.has(destination)) {
        const kept = `${destination}.pre-restore-${stamp}`;
        await cp(destination, kept).catch(() => {});
        overwritten.add(destination);
        warnings.push(`会话 ${session.id} 覆盖了已有文件，旧文件存为 ${basename(kept)}`);
      }
      const buffer = await readFile(source);
      const output = target.path === session.cwd ? buffer : rewriteCwd(buffer, target.path).buffer;
      await writeFileAtomic(destination, output);
      copied += 1;
    }

    // 3. 工作区文件
    let filesRestored = false;
    if (workspace.files?.included && target.mode !== 'inKit') {
      const rawSubdir = workspace.files.subdir ?? '';
      const source = resolve(kitDir, rawSubdir);
      if (!isInside(kitDir, source)) {
        warnings.push(`工作区副本路径越出备份目录（${rawSubdir}），已跳过文件恢复`);
      } else if (existsSync(source)) {
        const conflicts = await collectConflicts(source, target.path);
        if (conflicts.length > 0) {
          const kept = `${target.path}.pre-restore-${stamp}`;
          for (const rel of conflicts) {
            await mkdir(dirname(join(kept, rel)), { recursive: true }).catch(() => {});
            await cp(join(target.path, rel), join(kept, rel)).catch(() => {});
          }
          warnings.push(`目标目录已有 ${conflicts.length} 个同名文件，已备份到 ${basename(kept)}`);
        }
        const failure = await cp(source, target.path, {
          recursive: true,
          force: true,
          errorOnExist: false,
        }).then(() => null).catch((error) => error);
        if (failure) {
          warnings.push(`工作区文件复制失败：${failure.message}`);
        } else {
          filesRestored = true;
        }
      }
    } else if (target.mode === 'inKit') {
      filesRestored = true;
    }
    restored.push({
      id: workspace.id,
      oldPath: workspace.path,
      mode: target.mode,
      path: target.path,
      sessions: copied,
      files: filesRestored,
    });
  }

  // 4. 其余宿主数据
  const hostDir = join(kitDir, 'host');
  for (const name of ['storages', 'skills', 'llm-deepseek']) {
    if (name === 'storages') continue; // workspace.json 单独合并
    const source = join(hostDir, name);
    if (!existsSync(source)) continue;
    await cp(source, join(dshHome, name), { recursive: true, force: true, errorOnExist: false }).catch((error) => {
      warnings.push(`${name} 恢复失败：${error.message}`);
    });
  }
  if (existsSync(join(hostDir, 'settings.yaml'))) {
    await cp(join(hostDir, 'settings.yaml'), join(dshHome, 'settings.yaml'), { force: true }).catch(() => {
      warnings.push('settings.yaml 未能恢复');
    });
  }

  // 5. workspace.json 合并
  const currentTablePath = join(dshHome, 'storages', 'workspace.json');
  const currentTable = existsSync(currentTablePath)
    ? JSON.parse(await readFile(currentTablePath, 'utf8'))
    : null;
  const resolved = plan.manifest.workspaces.map((workspace) => {
    const target = resolveTargetPath(mapping, workspace, kitDir);
    return {
      originalId: workspace.id,
      title: workspace.title,
      createdAt: workspace.createdAt,
      mode: target.mode,
      path: target.path,
      sessionIds: target.mode === 'skip' ? [] : workspace.sessionIds.filter((id) => !excluded.has(id)),
    };
  });
  const mergedTable = mergeWorkspaceTable(currentTable, plan.manifest.workspaces, resolved);
  await writeJsonAtomic(currentTablePath, mergedTable);

  // 6. AGENTS.md
  let agentsResult = mapping.agentsMd ?? 'skip';
  if (agentsResult !== 'skip') {
    const source = join(hostDir, AGENTS_MAIN);
    if (existsSync(source)) {
      const destination = join(dshHome, AGENTS_MAIN);
      if (agentsResult === 'overwrite') {
        if (existsSync(destination)) {
          await cp(destination, `${destination}.pre-restore-${stamp}`).catch((error) => {
            warnings.push(`原 AGENTS.md 备份失败：${error.message}`);
          });
        }
        await cp(source, destination, { force: true }).catch((error) =>
          warnings.push(`AGENTS.md 覆盖失败：${error.message}`),
        );
      } else {
        await cp(source, `${destination}.from-backup`, { force: true }).catch((error) =>
          warnings.push(`AGENTS.md 并存写入失败：${error.message}`),
        );
      }
    } else {
      warnings.push('备份里没有 AGENTS.md');
      agentsResult = 'skip';
    }
  }

  // 7. 附件
  if (mapping.layers?.attachments && existsSync(join(kitDir, 'attachments'))) {
    await cp(join(kitDir, 'attachments'), join(dshHome, 'attachments'), {
      recursive: true,
      force: true,
      errorOnExist: false,
    }).catch((error) => warnings.push(`附件恢复失败：${error.message}`));
  }

  // 8. 报告
  const reportPath = await writeReport({ kitDir, dshHome, plan, restored, warnings, mapping });

  return {
    restored,
    warnings,
    snapshot: existsSync(snapshot) ? snapshot : null,
    reportPath,
    requiresRestart: true,
    agentsMd: agentsResult,
  };
}

async function writeReport({ kitDir, dshHome, plan, restored, warnings, mapping }) {
  const totalSessions = restored.reduce((sum, item) => sum + item.sessions, 0);
  const doc = {
    title: '恢复报告',
    subtitle: `第九通路 · ${new Date().toLocaleString('zh-CN')} · 备份 ${plan.manifest.kitId}`,
    sections: [
      {
        heading: '一、概要',
        blocks: [
          { type: 'p', runs: [{ text: '宿主版本：', bold: true }, { text: `${plan.manifest.createdBy.dshVersion}（会话格式 ${plan.manifest.createdBy.sessionFormat}）` }] },
          { type: 'p', runs: [{ text: '恢复目标：', bold: true }, { text: dshHome }] },
          { type: 'p', runs: [{ text: '会话数：', bold: true }, { text: String(totalSessions) }] },
          { type: 'p', runs: [{ text: '告警：', bold: true, color: warnings.length ? 'C00000' : '344054' }, { text: warnings.length ? warnings.join('；') : '无' }] },
        ],
      },
      {
        heading: '二、工作区',
        blocks: [
          {
            type: 'table',
            header: ['旧路径', '新路径', '模式', '会话', '文件'],
            weights: [30, 30, 12, 12, 16],
            monoColumns: [0, 1],
            rows: restored.map((item) => ({
              cells: [item.oldPath, item.path ?? '（跳过）', item.mode, String(item.sessions), item.files ? '已恢复' : '未恢复'],
              abnormal: item.mode === 'skip' || !item.files,
            })),
          },
        ],
      },
      {
        heading: '三、会话明细',
        pageBreakBefore: true,
        blocks: [
          {
            type: 'table',
            header: ['会话 ID', '原始 cwd', '结果'],
            weights: [30, 46, 24],
            monoColumns: [0, 1],
            rows: plan.manifest.workspaces.flatMap((workspace) => {
              const match = restored.find((item) => item.id === workspace.id);
              return workspace.sessions.map((session) => ({
                cells: [session.id, session.cwd, match?.mode === 'skip' ? '跳过' : '已写入'],
                abnormal: match?.mode === 'skip',
              }));
            }),
          },
        ],
      },
      {
        heading: '四、待办',
        blocks: [
          { type: 'p', text: '1. 重启客户端，使新的会话列表与索引生效。' },
          { type: 'p', text: '2. 重新登录账号；被脱敏的 API Key 需要重新填写。' },
          { type: 'p', text: mapping.agentsMd === 'skip' ? '3. AGENTS.md 未恢复。' : `3. AGENTS.md 处理方式：${mapping.agentsMd}。` },
          { type: 'p', text: '4. 若客户端被自动更新，版本号前移不影响已恢复数据。' },
        ],
      },
    ],
  };

  // 报告写到本机数据目录下，不写回备份介质（那里可能只读或受限）
  const reportsDir = join(dshHome, 'ninth-path', 'reports');
  await mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const path = join(reportsDir, `恢复报告-${stamp}.docx`);
  await writeFile(path, buildDocx(doc));
  return path;
}
