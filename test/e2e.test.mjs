/**
 * 端到端自测：假数据目录 → 备份 → 恢复 → 校验。
 * 不触碰真实 ~/.dsh。
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { runBackup } from '../lib/backup.js';
import { applyRestore, planRestore } from '../lib/restore.js';
import { encodeCwd, readHeader, rewriteCwd, listSessions } from '../lib/session-log.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 让 C 盘不被判成系统卷
process.env.SystemDrive = 'Z:';
process.env.LOCALAPPDATA = join(tmpdir(), 'ninth-path-no-installer');

const root = await mkdtemp(join(tmpdir(), 'ninth-path-e2e-'));
const sourceHome = join(root, 'dshA');
const restoredHome = join(root, 'dshB');
const backupRoot = join(root, 'backup');

try {
  // ---- 构造源数据目录 ----
  const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const realSessions = await listSessions(join(realHome, 'sessions'));
  const seeds = realSessions.slice(0, 2);
  if (seeds.length < 1) throw new Error('没有可用的真实会话，无法构造夹具');

  const oldCwd = 'T:\\迁移前\\项目';
  for (const seed of seeds) {
    const dir = join(sourceHome, 'sessions', encodeCwd(oldCwd), seed.id);
    await mkdir(dir, { recursive: true });
    const buffer = await readFile(seed.file);
    const rewritten = seed.cwd === oldCwd ? buffer : rewriteCwd(buffer, oldCwd).buffer;
    await writeFile(join(dir, seed.logFile), rewritten);
  }

  const workspaceId = '11111111-2222-3333-4444-555555555555';
  await mkdir(join(sourceHome, 'storages'), { recursive: true });
  await writeFile(
    join(sourceHome, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: {
          workspaces: {
            [workspaceId]: {
              path: oldCwd,
              title: '迁移测试',
              sessionIds: seeds.map((s) => s.id),
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-02T00:00:00.000Z',
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(join(sourceHome, 'AGENTS.md'), '# 测试偏好\n\n- 用中文\n', 'utf8');
  await writeFile(join(sourceHome, 'AGENTS.md.v1.bak'), '# 更早的偏好\n', 'utf8');

  // ---- 备份 ----
  const backup = await runBackup({
    dshHome: sourceHome,
    targetRoot: backupRoot,
    layers: { host: true, workspaceIds: [workspaceId], attachments: false },
    excludeSessionIds: [],
    includeInstaller: false,
    includePlugin: true,
    pluginDir: join(import.meta.dirname, '..'),
    createdBy: { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4', profile: 'web', os: 'win32', hostname: 'fixture', username: 'ui' },
  });

  check('备份目录已创建', existsSync(backup.kitDir));
  check('manifest 已写入', existsSync(join(backup.kitDir, 'manifest.json')));
  check('恢复提示词已写入', existsSync(join(backup.kitDir, '恢复说明.txt')));
  check('使用说明书已写入', existsSync(join(backup.kitDir, '使用说明书.txt')));
  check('哈希清单已写入', existsSync(join(backup.kitDir, 'SHA256SUMS.txt')));
  check('宿主数据已复制', existsSync(join(backup.kitDir, 'host', 'sessions')));
  check('AGENTS.md 历史版本一并带上', existsSync(join(backup.kitDir, 'host', 'AGENTS.md.v1.bak')));
  check('插件包已复制', existsSync(join(backup.kitDir, 'plugin', 'index.js')));

  const manifest = JSON.parse(await readFile(join(backup.kitDir, 'manifest.json'), 'utf8'));
  check('manifest.complete 为真', manifest.complete === true);
  check('manifest 记录了工作区', manifest.workspaces.length === 1);
  check('manifest 记录了会话', manifest.workspaces[0].sessions.length === seeds.length);
  check('会话有 sha256', manifest.workspaces[0].sessions.every((s) => typeof s.sha256 === 'string'));
  check('宿主层有哈希', typeof manifest.layers.host.sha256 === 'string' && manifest.layers.host.sha256.length === 64);
  check('未找到安装包时如实记录', manifest.installer.present === false);

  const promptText = await readFile(join(backup.kitDir, '恢复说明.txt'), 'utf8');
  check('提示词带 BOM', promptText.charCodeAt(0) === 0xfeff);
  check('提示词含作者信息', promptText.includes('无银ui') && promptText.includes('a1lzui@163.com'));
  check('提示词声明 AI 参与生成', promptText.includes('由 AI 参与生成'));

  // ---- 恢复计划 ----
  const plan = await planRestore({
    kitDir: backup.kitDir,
    dshHome: restoredHome,
    currentVersion: '0.2.1-rc.2',
    sessionFormat: 'v4',
  });
  check('计划兼容性 ok', plan.compat.level === 'ok', JSON.stringify(plan.compat));
  check('旧路径不存在时要求提问', plan.needQuestions.length === 1, JSON.stringify(plan.needQuestions));
  check('检测到 AGENTS.md', plan.hasAgents === true);

  // ---- 恢复执行 ----
  const newPath = join(root, 'work', 'proj');
  const result = await applyRestore({
    kitDir: backup.kitDir,
    dshHome: restoredHome,
    currentVersion: '0.2.1-rc.2',
    mapping: {
      sessionFormat: 'v4',
      workspaces: [{ id: workspaceId, mode: 'newPath', newPath }],
      agentsMd: 'sidefile',
      layers: { attachments: false },
      excludeSessionIds: [],
    },
  });

  // 夹具的工作区目录本就不存在，因此「工作区文件复制失败」是预期告警；这里只排除硬性失败
  check(
    '恢复没有硬性失败',
    !result.warnings.some((w) => w.includes('哈希不符') || w.includes('越出') || w.includes('快照失败')),
    JSON.stringify(result.warnings),
  );
  check('恢复了预期会话数', result.restored[0].sessions === seeds.length, JSON.stringify(result.restored[0]));
  check('目标会话目录存在', existsSync(join(restoredHome, 'sessions', encodeCwd(newPath))));
  check('Word 报告已生成', existsSync(result.reportPath) && result.reportPath.endsWith('.docx'));

  const restoredSessions = await listSessions(join(restoredHome, 'sessions'));
  check('恢复后能列出会话', restoredSessions.length === seeds.length, `count=${restoredSessions.length}`);
  check('恢复后 cwd 已改写', restoredSessions.every((s) => s.cwd === newPath), JSON.stringify(restoredSessions.map((s) => s.cwd)));
  check('恢复后 header 可解析', restoredSessions.every((s) => s.frames > 0));

  const table = JSON.parse(await readFile(join(restoredHome, 'storages', 'workspace.json'), 'utf8'));
  const records = Object.values(table.tables.workspaces);
  check('workspace.json 有新路径记录', records.some((r) => r.path === newPath), JSON.stringify(records.map((r) => r.path)));
  check('workspace.json 记录了会话', records.some((r) => r.sessionIds.length === seeds.length));
  check('AGENTS.md 并存写入', existsSync(join(restoredHome, 'AGENTS.md.from-backup')));
  check('原 AGENTS.md 未被覆盖', !existsSync(join(restoredHome, 'AGENTS.md')));

  // ---- 跳过模式 ----
  const skipPlan = await planRestore({
    kitDir: backup.kitDir,
    dshHome: join(root, 'dshC'),
    currentVersion: '0.2.1-rc.2',
    sessionFormat: 'v4',
  });
  void skipPlan;
  const skipResult = await applyRestore({
    kitDir: backup.kitDir,
    dshHome: join(root, 'dshC'),
    currentVersion: '0.2.1-rc.2',
    mapping: { sessionFormat: 'v4', workspaces: [{ id: workspaceId, mode: 'skip' }], agentsMd: 'skip', layers: {} },
  });
  check('跳过模式不写会话', skipResult.restored[0].sessions === 0);
  check('跳过模式报告仍生成', existsSync(skipResult.reportPath));

  // ---- 未完成备份拒收 ----
  const badKit = join(root, 'bad-kit');
  await mkdir(badKit, { recursive: true });
  await cp(join(backup.kitDir, 'manifest.json'), join(badKit, 'manifest.json'));
  await writeFile(join(badKit, '.incomplete'), 'x', 'utf8');
  let rejected = false;
  await planRestore({ kitDir: badKit, dshHome: join(root, 'dshD'), currentVersion: '0.2.1-rc.2', sessionFormat: 'v4' }).catch(() => {
    rejected = true;
  });
  check('未完成备份被拒收', rejected);

  // ---- 工作区文件复制 + 冲突保护 ----
  {
    const kitDir = join(root, 'kit-files');
    await cp(backup.kitDir, kitDir, { recursive: true, force: true });
    const sub = join(kitDir, 'workspaces', 'real-ws');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'keep.txt'), 'FROM_BACKUP', 'utf8');
    await writeFile(join(sub, 'new.txt'), 'NEW', 'utf8');

    const manifestPath = join(kitDir, 'manifest.json');
    const local = JSON.parse(await readFile(manifestPath, 'utf8'));
    local.workspaces[0].files = { included: true, subdir: 'workspaces/real-ws', excludedPatterns: [], sizeBytes: 20 };
    await writeFile(manifestPath, JSON.stringify(local, null, 2), 'utf8');

    const existing = join(root, 'existing-project');
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, 'keep.txt'), 'USER_FILE', 'utf8');

    const out = await applyRestore({
      kitDir,
      dshHome: join(root, 'home-files'),
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: workspaceId, mode: 'newPath', newPath: existing }], layers: {} },
    });
    check('工作区文件已复制', (await readFile(join(existing, 'keep.txt'), 'utf8')) === 'FROM_BACKUP');
    check('新文件也写入', (await readFile(join(existing, 'new.txt'), 'utf8')) === 'NEW');
    check('冲突文件先备份', out.warnings.some((w) => w.includes('同名文件')), JSON.stringify(out.warnings));
    const kept = await readdir(root).then((names) => names.find((n) => n.startsWith('existing-project.pre-restore-')));
    check('冲突备份内容正确', Boolean(kept) && (await readFile(join(root, kept, 'keep.txt'), 'utf8')) === 'USER_FILE');
  }

  // ---- 哈希不符拒绝 ----
  {
    const kitDir = join(root, 'kit-hash');
    await cp(backup.kitDir, kitDir, { recursive: true, force: true });
    const local = JSON.parse(await readFile(join(kitDir, 'manifest.json'), 'utf8'));
    const session = local.workspaces[0].sessions[0];
    const file = join(kitDir, 'host', 'sessions', encodeCwd(session.cwd), session.id, session.logFile);
    const before = (await stat(file)).size;
    await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('TAMPER')]));
    const after = (await stat(file)).size;
    check('篡改确实写入了文件', after === before + 6, `${before} -> ${after}`);

    const out = await applyRestore({
      kitDir,
      dshHome: join(root, 'home-hash'),
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: workspaceId, mode: 'reuse' }], layers: {} },
    });
    check('哈希不符的会话被跳过', out.restored[0].sessions === seeds.length - 1, JSON.stringify(out.restored[0]));
    check('哈希不符有告警', out.warnings.some((w) => w.includes('哈希不符')), JSON.stringify(out.warnings));
  }

  // ---- 路径穿越拒绝 ----
  {
    const kitDir = join(root, 'kit-trav');
    await cp(backup.kitDir, kitDir, { recursive: true, force: true });
    const manifestPath = join(kitDir, 'manifest.json');
    const local = JSON.parse(await readFile(manifestPath, 'utf8'));
    local.workspaces[0].sessions[0].id = '../../../../evil';
    await writeFile(manifestPath, JSON.stringify(local, null, 2), 'utf8');

    const out = await applyRestore({
      kitDir,
      dshHome: join(root, 'home-trav'),
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: workspaceId, mode: 'reuse' }], layers: {} },
    });
    check('穿越路径未写入', !existsSync(join(root, 'evil')));
    check('穿越被记录告警', out.warnings.some((w) => w.includes('越出')), JSON.stringify(out.warnings));
  }

  // ---- 未归属工作区的会话要如实报出 ----
  {
    const { planBackup } = await import('../lib/backup.js');
    const home = join(root, 'dsh-unassigned');
    const cwd = 'T:\\孤儿\\目录';
    const dir = join(home, 'sessions', encodeCwd(cwd), seeds[0].id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, seeds[0].logFile), rewriteCwd(await readFile(seeds[0].file), cwd).buffer);
    await mkdir(join(home, 'storages'), { recursive: true });
    await writeFile(
      join(home, 'storages', 'workspace.json'),
      JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { workspaceIds: [] }, tables: { workspaces: {} } }),
      'utf8',
    );

    const plan = await planBackup({ dshHome: home, targetRoot: join(root, 'backup-unassigned'), layers: { host: true } });
    check('预检把未归属会话单独报出', plan.sessionCount === 0 && plan.unassignedSessions.count === 1, JSON.stringify(plan.unassignedSessions));

    const result = await runBackup({
      dshHome: home,
      targetRoot: join(root, 'backup-unassigned'),
      layers: { host: true, workspaceIds: [], attachments: false },
      includeInstaller: false,
      includePlugin: false,
      createdBy: { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4' },
    });
    check('清单记录未归属会话', result.manifest.excluded.unassignedSessions.count === 1);
    check(
      '未归属记录带体积',
      typeof result.manifest.excluded.unassignedSessions.sizeBytes === 'number' &&
        result.manifest.excluded.unassignedSessions.sizeBytes > 0,
    );
    check('摘要带未归属数量', result.summary.unassigned === 1);
  }

  // ---- 系统卷拒收 ----
  process.env.SystemDrive = 'C:';
  let blocked = false;
  await runBackup({
    dshHome: sourceHome,
    targetRoot: 'C:\\ninth-path-should-fail',
    layers: { host: true },
    excludeSessionIds: [],
    includeInstaller: false,
    includePlugin: false,
    createdBy: { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4' },
  }).catch((error) => {
    blocked = String(error.message).includes('系统卷');
  });
  check('系统卷目标被拒绝', blocked);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
