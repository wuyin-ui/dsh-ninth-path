/**
 * 第九通路 — Host 入口。
 *
 * 注册五个工具：状态、备份、恢复计划、恢复执行、会话角色绑定。
 * 所有文件操作走 node:fs（宿主插件自有存储，不经过模型侧沙箱接口）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatBytes, readJson, writeJsonAtomic } from './lib/manifest.js';
import { planBackup, runBackup, isSystemVolume } from './lib/backup.js';
import { applyRestore, planRestore } from './lib/restore.js';
import { listSessions } from './lib/session-log.js';
import { AUTHOR, EMAIL, TOOL_NAME, VERSION } from './lib/prompt.js';

export const name = 'ninth-path';
export const inject = ['tools'];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLES_FILE = 'roles.json';

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

function hostVersion() {
  const fromEnv = process.env.DSH_VERSION ?? process.env.DSH_HOST_VERSION;
  if (fromEnv) return fromEnv;

  // 桌面版的应用版本在 resources/app.asar/package.json；Host 进程能直接读到 asar
  const candidates = [];
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app.asar', 'package.json'));
  if (process.execPath) candidates.push(join(dirname(process.execPath), 'resources', 'app.asar', 'package.json'));

  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    } catch {
      // 读不到就继续尝试下一个来源
    }
  }

  // 拿不到就如实返回 unknown；恢复时按「未知」降级为警告，不当作损坏
  return 'unknown';
}

function sessionFormat() {
  return process.env.DSH_SESSION_FORMAT ?? 'v4';
}

function rolesPath() {
  return join(dshHome(), 'ninth-path', ROLES_FILE);
}

async function readRoles() {
  return (await readJson(rolesPath()).catch(() => null)) ?? { sessions: {} };
}

async function bindRole(sessionId, role) {
  const roles = await readRoles();
  roles.sessions ??= {};
  roles.sessions[sessionId] = { role, at: new Date().toISOString() };
  await writeJsonAtomic(rolesPath(), roles);
  return roles.sessions[sessionId];
}

async function workspaceTable() {
  const raw = await readJson(join(dshHome(), 'storages', 'workspace.json')).catch(() => null);
  const table = raw?.tables?.workspaces ?? {};
  return Object.entries(table).map(([id, value]) => ({ id, ...value }));
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function output(schema) {
  return {
    schema,
    render: (_args, value) => {
      const summary = typeof value?.summary === 'string' ? value.summary : '';
      const body = JSON.stringify(value, null, 2);
      return text(`${summary}\n\n${body}`);
    },
  };
}

const anyObject = { type: 'object', additionalProperties: true };

export function apply(ctx) {
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition), `ninth-path:${definition.name}`);

  register({
    name: 'ninth_path_status',
    description:
      '查看第九通路的可用状态：数据目录、客户端版本、会话数、工作区列表与各盘卷信息。备份或恢复前先调用一次。',
    parameters: anyObject,
    output: output(anyObject),
    async execute(_args, exec) {
      const home = dshHome();
      const sessions = await listSessions(join(home, 'sessions'));
      const workspaces = await workspaceTable();
      const roles = await readRoles();
      const sessionId = exec.agent?.id ?? null;
      return {
        summary: `${TOOL_NAME} v${VERSION}｜数据目录 ${home}｜${sessions.length} 条会话｜${workspaces.length} 个工作区`,
        tool: TOOL_NAME,
        version: VERSION,
        author: AUTHOR,
        email: EMAIL,
        dshHome: home,
        hostVersion: hostVersion(),
        sessionFormat: sessionFormat(),
        sessionId,
        role: sessionId ? roles.sessions?.[sessionId]?.role ?? null : null,
        sessionCount: sessions.length,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          path: w.path,
          title: w.title ?? '',
          sessionCount: (w.sessionIds ?? []).length,
        })),
        systemDrive: (process.env.SystemDrive ?? 'C:').slice(0, 2),
        pluginDir: HERE,
      };
    },
  });

  register({
    name: 'ninth_path_bind_role',
    description:
      '把当前会话认定为「备份工作区」或「恢复工作区」。只有显式调用本工具才算认定；目录名、路径、内容都不作为依据。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['backup', 'restore'], description: 'backup = 执行备份的工具会话；restore = 执行恢复的工具会话' },
      },
      required: ['role'],
      additionalProperties: false,
    },
    output: output(anyObject),
    async execute(args, exec) {
      const sessionId = exec.agent?.id;
      if (!sessionId) throw new Error('无法取得当前会话 id');
      const role = args?.role;
      if (role !== 'backup' && role !== 'restore') throw new Error('role 只能是 backup 或 restore');
      const record = await bindRole(sessionId, role);
      return {
        summary: `已把会话 ${sessionId} 认定为${role === 'backup' ? '备份' : '恢复'}工作区（${record.at}）。这个会话不会被备份，也不会被恢复覆盖。`,
        sessionId,
        role,
        at: record.at,
      };
    },
  });

  register({
    name: 'ninth_path_backup',
    description:
      '把客户端数据备份到非系统盘。先调用 ninth_path_status 与 ninth_path_bind_role(backup)，再调用本工具。返回备份目录与清单摘要。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '非系统盘上的目标目录，例如 E:\\备份 或 E:' },
        host: { type: 'boolean', description: '是否备份宿主数据（会话、工作区注册、偏好、技能），默认 true' },
        workspaceIds: { type: 'array', items: { type: 'string' }, description: '要一并备份文件的工作区 id；留空表示只备份宿主数据' },
        attachments: { type: 'boolean', description: '是否备份附件，默认 false' },
        excludeWorkspaceIds: { type: 'array', items: { type: 'string' }, description: '要排除的工作区 id' },
        includeInstaller: { type: 'boolean', description: '是否把同版本安装包放入备份，默认 true' },
        includePlugin: { type: 'boolean', description: '是否把本插件安装包放入备份，默认 true' },
        dryRun: { type: 'boolean', description: '只做预检并返回计划，不写任何文件' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: output(anyObject),
    async execute(args, exec) {
      if (!args?.target) throw new Error('缺少 target');
      if (isSystemVolume(args.target)) {
        throw new Error(`目标 ${args.target} 位于系统卷。请换到非系统盘，否则重装系统时备份会一起消失。`);
      }
      const home = dshHome();
      const layers = {
        host: args.host !== false,
        workspaceIds: args.workspaceIds ?? [],
        attachments: args.attachments === true,
      };
      const roles = await readRoles();
      const sessionId = exec.agent?.id ?? null;
      if (sessionId && roles.sessions?.[sessionId]?.role !== 'backup') {
        throw new Error('当前会话还没有认定为备份工作区。请先调用 ninth_path_bind_role(role="backup")。');
      }

      if (args.dryRun) {
        const plan = await planBackup({
          dshHome: home,
          targetRoot: args.target,
          layers,
          excludeSessionIds: sessionId ? [sessionId] : [],
          excludeWorkspaceIds: args.excludeWorkspaceIds ?? [],
        });
        return {
          summary:
            `预检：预计 ${plan.estimatedText}，将备份 ${plan.sessionCount} 条会话` +
            `（另有 ${plan.unassignedSessions.count} 条未归属工作区，不会备份），` +
            `${plan.workspaces.length} 个工作区，系统卷=${plan.systemVolume}` +
            `${plan.space ? `，目标盘可用 ${formatBytes(plan.space.free)}` : ''}`,
          plan,
        };
      }

      const result = await runBackup({
        dshHome: home,
        targetRoot: args.target,
        layers,
        excludeSessionIds: sessionId ? [sessionId] : [],
        excludeWorkspaceIds: args.excludeWorkspaceIds ?? [],
        includeInstaller: args.includeInstaller !== false,
        includePlugin: args.includePlugin !== false,
        pluginDir: HERE,
        createdBy: {
          dshVersion: hostVersion(),
          sessionFormat: sessionFormat(),
          profile: process.env.DSH_PROFILE ?? '',
          os: process.platform,
          hostname: process.env.COMPUTERNAME ?? '',
          username: process.env.USERNAME ?? '',
        },
      });
      return {
        summary:
          `备份完成：${result.kitDir}（${result.summary.size}，${result.summary.sessions} 条会话` +
          `${result.summary.unassigned ? `，另有 ${result.summary.unassigned} 条未归属工作区未备份` : ''}）。` +
          '恢复提示词在该目录的「恢复说明.txt」。',
        ...result.summary,
        manifestPath: join(result.kitDir, 'manifest.json'),
        promptPath: join(result.kitDir, '恢复说明.txt'),
      };
    },
  });

  register({
    name: 'ninth_path_restore_plan',
    description:
      '读取备份目录的 manifest 并给出恢复计划：版本兼容性、每个工作区的旧路径是否仍有效、哪些需要向用户提问。不写任何文件。',
    parameters: {
      type: 'object',
      properties: {
        kitDir: { type: 'string', description: '备份目录的绝对路径' },
      },
      required: ['kitDir'],
      additionalProperties: false,
    },
    output: output(anyObject),
    async execute(args) {
      if (!args?.kitDir) throw new Error('缺少 kitDir');
      const plan = await planRestore({
        kitDir: args.kitDir,
        dshHome: dshHome(),
        currentVersion: hostVersion(),
        sessionFormat: sessionFormat(),
      });
      return {
        summary: `兼容性 ${plan.compat.level}｜${plan.workspaces.length} 个工作区，${plan.needQuestions.length} 个需要提问`,
        compat: plan.compat,
        workspaces: plan.workspaces,
        needQuestions: plan.needQuestions,
        hasAgents: plan.hasAgents,
        layers: plan.layers,
      };
    },
  });

  register({
    name: 'ninth_path_restore_apply',
    description:
      '执行恢复。必须先调用 ninth_path_bind_role(role="restore") 与 ninth_path_restore_plan，并按计划向用户提问后再调用。合并写入，不整体替换。',
    parameters: {
      type: 'object',
      properties: {
        kitDir: { type: 'string' },
        workspaces: {
          type: 'array',
          description: '每个工作区的去向：mode 取 reuse / newPath / inKit / skip',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              mode: { type: 'string', enum: ['reuse', 'newPath', 'inKit', 'skip'] },
              newPath: { type: 'string' },
            },
            required: ['id', 'mode'],
            additionalProperties: false,
          },
        },
        agentsMd: { type: 'string', enum: ['skip', 'overwrite', 'sidefile'], description: 'AGENTS.md 的处理方式，默认 skip' },
        attachments: { type: 'boolean', description: '是否恢复附件' },
        allowNoSnapshot: { type: 'boolean', description: '快照失败时是否仍然继续（默认 false，即停止）' },
      },
      required: ['kitDir', 'workspaces'],
      additionalProperties: false,
    },
    output: output(anyObject),
    async execute(args, exec) {
      if (!args?.kitDir) throw new Error('缺少 kitDir');
      const sessionId = exec.agent?.id ?? null;
      const roles = await readRoles();
      if (sessionId && roles.sessions?.[sessionId]?.role !== 'restore') {
        throw new Error('当前会话还没有认定为恢复工作区。请先调用 ninth_path_bind_role(role="restore")。');
      }
      const result = await applyRestore({
        kitDir: args.kitDir,
        dshHome: dshHome(),
        currentVersion: hostVersion(),
        mapping: {
          sessionFormat: sessionFormat(),
          workspaces: args.workspaces ?? [],
          agentsMd: args.agentsMd ?? 'skip',
          layers: { attachments: args.attachments === true },
          excludeSessionIds: sessionId ? [sessionId] : [],
          allowNoSnapshot: args.allowNoSnapshot === true,
        },
      });
      return {
        summary: `恢复完成：${result.restored.reduce((sum, item) => sum + item.sessions, 0)} 条会话。报告 ${result.reportPath}。请重启客户端。`,
        ...result,
      };
    },
  });
}
