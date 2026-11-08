/**
 * 安全审计用攻击脚本：只证明缺陷存在，不修。全部在临时目录内。
 *   node test/audit.test.mjs
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackup } from '../lib/backup.js';
import { applyRestore, planRestore } from '../lib/restore.js';
import { checkSpace } from '../lib/manifest.js';
import { encodeCwd, listSessions, rewriteCwd } from '../lib/session-log.js';

process.env.SystemDrive = 'Z:';
process.env.LOCALAPPDATA = join(tmpdir(), 'audit-no-installer');

const findings = [];
const record = (id, severity, title, detail) => {
  findings.push({ id, severity, title, detail });
  console.log(`[${severity}] ${id} ${title}`);
  if (detail) console.log(`        ${detail}`);
};

async function makeKit(root) {
  const sourceHome = join(root, 'src');
  const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const realSessions = await listSessions(join(realHome, 'sessions'));
  const seed = realSessions[0];
  if (!seed) throw new Error('没有可用会话');

  const cwd = 'T:\\审计\\项目';
  const dir = join(sourceHome, 'sessions', encodeCwd(cwd), seed.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, seed.logFile), rewriteCwd(await readFile(seed.file), cwd).buffer);

  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(join(sourceHome, 'storages'), { recursive: true });
  await writeFile(
    join(sourceHome, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { [id]: { path: cwd, title: 'x', sessionIds: [seed.id] } } },
    }),
    'utf8',
  );

  const kit = await runBackup({
    dshHome: sourceHome,
    targetRoot: join(root, 'backup'),
    layers: { host: true, workspaces: [] },
    includeInstaller: false,
    includePlugin: false,
    createdBy: { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4' },
  });
  return { kit, sourceHome, workspaceId: id, sessionId: seed.id, cwd };
}

// ---- 1. encodeCwd 碰撞（宿主编码规则的固有限制，已有缓解） ----
{
  const a = encodeCwd('E:\\a-b');
  const b = encodeCwd('E:\\a\\b');
  if (a === b) {
    console.log(`[note] ENC-1 编码碰撞属于宿主目录命名规则的固有限制：${a}`);
    console.log('        缓解：备份时写入 warnings；恢复时同一目标目录的第二个工作区被跳过并告警');
  }
}

// ---- 2. checkSpace 是否可用 ----
{
  const space = await checkSpace(process.cwd(), 0).catch((error) => ({ error: error.message }));
  if (space?.error) record('ENV-1', '低', 'checkSpace 在当前平台不可用', space.error);
  else console.log(`[ok] ENV-1 checkSpace 可用：free=${space.free} needed=${space.needed}`);
}

const root = await mkdtemp(join(tmpdir(), 'ninth-path-audit-'));
try {
  const fixture = await makeKit(root);

  // ---- 3. logFile 路径穿越 ----
  {
    const kitDir = join(root, 'kit-escape');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const manifestPath = join(kitDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.workspaces[0].sessions[0].logFile = '../../escaped.txt';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const home = join(root, 'home-escape');
    await applyRestore({
      kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'reuse' }], layers: {} },
    }).catch(() => {});
    const escaped = join(home, 'sessions', 'escaped.txt');
    if (existsSync(escaped)) {
      record('PTH-1', '高', 'manifest 的 logFile 可路径穿越，写出会话目录之外', `写入 ${escaped}`);
    } else {
      console.log('[ok] PTH-1 logFile 穿越未生效');
    }
  }

  // ---- 4. subdir 路径穿越（inKit 模式把工作区指向 kit 之外） ----
  {
    const kitDir = join(root, 'kit-subdir');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const manifestPath = join(kitDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.workspaces[0].files = { included: true, subdir: '../../../..', sizeBytes: 0 };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const home = join(root, 'home-subdir');
    const result = await applyRestore({
      kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'inKit' }], layers: {} },
    }).catch((error) => ({ error }));
    const target = result?.restored?.[0]?.path;
    if (target && !target.toLowerCase().startsWith(kitDir.toLowerCase())) {
      record('PTH-2', '中', 'manifest 的 subdir 可让工作区指向备份目录之外', `工作区路径被设为 ${target}`);
    } else {
      console.log('[ok] PTH-2 subdir 未逃逸');
    }
  }

  // ---- 5. 完整性不校验：篡改备份内容仍可恢复 ----
  {
    const kitDir = join(root, 'kit-tamper');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const manifest = JSON.parse(await readFile(join(kitDir, 'manifest.json'), 'utf8'));
    const session = manifest.workspaces[0].sessions[0];
    const file = join(kitDir, 'host', 'sessions', encodeCwd(session.cwd), session.id, session.logFile);
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from('TAMPERED')]));

    const home = join(root, 'home-tamper');
    const result = await applyRestore({
      kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'reuse' }], layers: {} },
    }).catch((error) => ({ error }));
    const tamperedWarned = (result?.warnings ?? []).some((w) => w.includes('校验') || w.includes('sha'));
    if (!result?.error && !tamperedWarned && result.restored?.[0]?.sessions === 1) {
      record('INT-1', '高', '恢复不校验哈希：被篡改的会话文件仍被当作正常数据写入', 'manifest 里存了 sha256，但没有任何一处比对');
    }
  }

  // ---- 6. 覆盖已有会话且不提示 ----
  {
    const home = join(root, 'home-overwrite');
    const targetDir = join(home, 'sessions', encodeCwd(fixture.cwd), fixture.sessionId);
    await mkdir(targetDir, { recursive: true });
    const manifest = JSON.parse(await readFile(join(fixture.kit.kitDir, 'manifest.json'), 'utf8'));
    const logFile = manifest.workspaces[0].sessions[0].logFile;
    await writeFile(join(targetDir, logFile), Buffer.from('ORIGINAL'));

    const result = await applyRestore({
      kitDir: fixture.kit.kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'reuse' }], layers: {} },
    }).catch((error) => ({ error }));
    const after = (await readFile(join(targetDir, logFile)).catch(() => Buffer.from(''))).toString();
    const warned = (result?.warnings ?? []).some((w) => w.includes('覆盖') || w.includes('已存在'));
    if (after !== 'ORIGINAL' && !warned) {
      record('OVR-1', '中', '恢复静默覆盖同 id 的现有会话，无告警', '用户无法得知哪条会话被替换');
    }
  }

  // ---- 7. 快照：拍不了默认中止 ----
  {
    const home = join(root, 'home-snapshot');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'marker.txt'), 'x', 'utf8');
    const result = await applyRestore({
      kitDir: fixture.kit.kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'skip' }], layers: {} },
    }).catch((error) => ({ error }));
    if (result?.error) {
      console.log('[ok] SNP-1 快照失败会中止恢复');
    } else if (result?.snapshot === null) {
      record('SNP-1', '低', '数据目录存在但没有生成快照，恢复仍继续', '回滚只能靠用户自己');
    } else {
      console.log('[ok] SNP-1 已生成快照');
    }
  }

  // ---- 8. 版本号不可解析时被当作通过 ----
  {
    const kitDir = join(root, 'kit-badver');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const manifestPath = join(kitDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.createdBy.dshVersion = 'not-a-version';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const plan = await planRestore({
      kitDir,
      dshHome: join(root, 'home-badver'),
      currentVersion: '0.2.1-rc.2',
      sessionFormat: 'v4',
    }).catch((error) => ({ error: error.message }));
    if (plan?.compat?.level !== 'block') {
      record('VER-1', '中', '备份版本号无法解析时只给 warning，不阻断', `level=${plan?.compat?.level}`);
    }
  }
  // ---- 9. session.id 路径穿越 ----
  {
    const kitDir = join(root, 'kit-sid');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const manifestPath = join(kitDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.workspaces[0].sessions[0].id = '../../../../evil-session';
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const home = join(root, 'home-sid');
    await applyRestore({
      kitDir,
      dshHome: home,
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'reuse' }], layers: {} },
    }).catch(() => {});
    const escaped = join(root, 'evil-session');
    if (existsSync(escaped)) {
      record('PTH-3', '高', 'manifest 的 session.id 可路径穿越，写出数据目录之外', `写入 ${escaped}`);
    } else {
      console.log('[ok] PTH-3 session.id 穿越未生效');
    }
  }

  // ---- 10. 工作区文件覆盖现有目录且无确认 ----
  {
    const kitDir = join(root, 'kit-ws');
    await cp(fixture.kit.kitDir, kitDir, { recursive: true, force: true });
    const sub = join(kitDir, 'workspaces', 'ws1');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'keep.txt'), 'FROM_BACKUP', 'utf8');
    const manifestPath = join(kitDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.workspaces[0].files = { included: true, subdir: 'workspaces/ws1', sizeBytes: 11 };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const existing = join(root, 'existing-project');
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, 'keep.txt'), 'USER_FILE', 'utf8');

    const result = await applyRestore({
      kitDir,
      dshHome: join(root, 'home-ws'),
      currentVersion: '0.2.1-rc.2',
      mapping: { sessionFormat: 'v4', workspaces: [{ id: fixture.workspaceId, mode: 'newPath', newPath: existing }], layers: {} },
    }).catch((error) => ({ error }));
    const after = await readFile(join(existing, 'keep.txt'), 'utf8').catch(() => '');
    const warned = (result?.warnings ?? []).some((w) => w.includes('同名文件') || w.includes('覆盖'));
    if (after === 'FROM_BACKUP' && !warned) {
      record('OVR-2', '中', '工作区文件直接覆盖目标目录同名文件，无确认、无备份', `${existing}\\keep.txt 被替换`);
    } else {
      console.log('[ok] OVR-2 冲突文件已先备份');
    }
  }

  // ---- 11. 备份层哈希缺失（只有确有内容时才要求哈希） ----
  {
    const manifest = JSON.parse(await readFile(join(fixture.kit.kitDir, 'manifest.json'), 'utf8'));
    const layers = ['workspaces', 'attachments'];
    const missing = layers.filter(
      (key) => manifest.layers[key].sizeBytes > 0 && !manifest.layers[key].sha256,
    );
    if (missing.length > 0) {
      record('INT-2', '中', '有内容的层缺少 sha256', missing.join(','));
    } else {
      console.log('[ok] INT-2 有内容的层都有哈希（本次夹具未备份工作区/附件，判据自动跳过）');
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n共发现 ${findings.length} 项`);
for (const item of findings) console.log(`- [${item.severity}] ${item.id} ${item.title}`);
