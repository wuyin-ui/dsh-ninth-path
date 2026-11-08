/**
 * 打包整合包：把插件收进 `第九通路/` 目录并压成 zip。
 *
 *   node scripts/pack.mjs
 *
 * 产物：dist/第九通路-v<版本>.zip
 * 解压后得到 `第九通路/`，用 `dsh plugin --profile <名> add "<路径>\第九通路"` 安装。
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zip } from '../lib/docx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const INNER = '第九通路';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'test', 'scripts', '.idea', '.vscode']);
const EXCLUDE_FILES = [/^\./, /\.log$/, /\.tmp$/, /package-lock\.json$/, /^pnpm-lock\.yaml$/];

async function collect(dir, prefix, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await collect(full, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILES.some((pattern) => pattern.test(entry.name))) continue;
    out.push({ name: `${INNER}/${rel}`, data: await readFile(full) });
  }
  return out;
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const files = await collect(ROOT, '', []);

// 安装说明放进包根，方便收到包的人直接看
files.push({
  name: `${INNER}/安装说明.txt`,
  data: Buffer.from(
    [
      '第九通路 · 安装说明',
      '====================',
      '',
      '1. 解压本压缩包，得到一个名为「第九通路」的文件夹。',
      '2. 安装插件，按可用程度选一种：',
      '',
      '   首选：让 agent 装。对 agent 说「把这个目录作为插件安装」，',
      '         它会调用 plugin_manager 的 install_bundle，target 指向本文件夹。',
      '',
      '   次选：打开 设置 → 插件，若界面提供「从本地目录/路径安装」入口，选本文件夹。',
      '',
      '   备选：已安装 dsh 命令行时执行（路径按实际位置替换，含中文要加引号）：',
      '         dsh plugin --profile <profile 名> add "<解压位置>\\第九通路"',
      '         桌面版通常没有 dsh 命令，不要假定它存在。',
      '',
      '3. 重启客户端。插件出现在插件列表里，标题为「第九通路」。',
      '4. 验证：在对话里问「第九通路的当前状态」，应能调用 ninth_path_status。',
      '',
      '卸载：',
      '   让 agent 用 plugin_manager 的 remove_bundle 移除 @wuyinui/dsh-ninth-path；',
      '   或（已装命令行时）dsh plugin --profile <profile 名> remove @wuyinui/dsh-ninth-path',
      '',
      '本插件零第三方运行时依赖，不需要联网安装。',
      '与 PowerShell 版本无关：插件本身不调用任何 shell。',
      '本文件由 AI 参与生成。',
      '',
    ].join('\n'),
    'utf8',
  ),
});

await mkdir(DIST, { recursive: true });
const version = pkg.version ?? '0.0.0';
const target = join(DIST, `第九通路-v${version}.zip`);
await rm(target, { force: true });
await writeFile(target, zip(files));

const total = files.reduce((sum, file) => sum + file.data.length, 0);
console.log(`打包完成：${relative(ROOT, target)}`);
console.log(`  文件数：${files.length}`);
console.log(`  原始体积：${(total / 1024).toFixed(1)} KB`);
console.log(`  压缩体积：${((await readFile(target)).length / 1024).toFixed(1)} KB`);
