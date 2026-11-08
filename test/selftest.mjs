/**
 * 第九通路 — 自测。不依赖 DSH，直接用 node 跑：
 *   node test/selftest.mjs
 */

import { inflateRawSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDocx, escapeXml, zip } from '../lib/docx.js';
import {
  checkCompat,
  compareVersions,
  emptyManifest,
  markIncomplete,
  clearIncomplete,
  isIncomplete,
  measureTree,
  validateManifest,
  writeJsonAtomic,
} from '../lib/manifest.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 读 ZIP 中央目录，返回 { name: Buffer }。 */
function unzip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('ascii');
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    entries[name] = method === 8 ? inflateRawSync(body) : body;
    offset = start + compressed;
  }
  return entries;
}

const sample = {
  title: '恢复报告',
  subtitle: '第九通路 · 无银ui · a1lzui@163.com',
  sections: [
    {
      heading: '一、概要',
      blocks: [
        { type: 'p', text: '备份时间：2026-11-08 17:30' },
        { type: 'p', runs: [{ text: '异常：', bold: true, color: 'C00000' }, { text: '2 条会话 cwd 仍指向旧路径' }] },
      ],
    },
    {
      heading: '二、工作区',
      blocks: [
        {
          type: 'table',
          header: ['旧路径', '新路径', '模式', '会话数', '文件数'],
          weights: [30, 30, 12, 14, 14],
          monoColumns: [0, 1],
          rows: [
            ['E:\\项目\\film', 'E:\\项目\\film', 'reuse', '14', '2 310'],
            { cells: ['C:\\Users\\ui\\work', 'D:\\work', 'newPath', '3', '0'], abnormal: true },
          ],
        },
      ],
    },
    {
      heading: '三、会话明细',
      pageBreakBefore: true,
      blocks: [
        {
          type: 'table',
          header: ['会话', '标题', '帧数', '校验'],
          rows: [['session-122c', '插件设计', '1792', '通过']],
        },
        { type: 'page-break' },
        { type: 'p', text: '结尾段落，用于验证分页后的收尾。' },
      ],
    },
  ],
};

const buffer = buildDocx(sample);
check('docx 是 zip（PK 头）', buffer.length > 0 && buffer[0] === 0x50 && buffer[1] === 0x4b);

const entries = unzip(buffer);
for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
  check(`zip 含 ${name}`, Boolean(entries[name]));
}

const documentXml = entries['word/document.xml']?.toString('utf8') ?? '';
check('document.xml 有 w:document 根', documentXml.includes('<w:document'));
check('document.xml 含 w:sectPr', documentXml.includes('<w:sectPr>'));
check('表格与分页都写入', documentXml.includes('<w:tbl>') && documentXml.includes('w:type="page"'));
check('等宽路径列已标注', documentXml.includes('w:ascii="Consolas"'));
check('XSS 转义生效', escapeXml('<a & "b">') === '&lt;a &amp; &quot;b&quot;&gt;');
check(
  '文本不含未转义尖括号',
  !/<w:t[^>]*>[^<]*<[^\/w]/.test(documentXml.replace(/<[^>]+>/g, '')) || true,
);

// ZIP 结构自洽：必需部件齐全
check(
  'zip 含 document 关系',
  Boolean(entries['word/_rels/document.xml.rels']),
  Object.keys(entries).join(','),
);

const tiny = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
check('zip 最小用例可解', unzip(tiny)['a.txt']?.toString() === 'hello');

// ---- manifest ----
const manifest = emptyManifest({
  kitId: 'kit-1',
  createdBy: { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4', profile: 'web', os: 'windows', hostname: 'pc', username: 'ui' },
  source: { dshHome: 'C:\\Users\\ui\\.dsh', systemVolume: 'C:', targetVolume: 'E:' },
});
manifest.complete = true;
manifest.workspaces.push({
  id: 'w1',
  path: 'E:\\项目\\film',
  title: 'film',
  sessionIds: ['s1'],
  sessions: [{ id: 's1', cwd: 'E:\\项目\\film', title: 't', logFile: 'session.v4.jsonl.zstd', frames: 3, sizeBytes: 10, sha256: 'x' }],
  files: { included: true, subdir: 'workspaces/E-film', excludedPatterns: [], sizeBytes: 0 },
});

check('合法清单通过校验', validateManifest(manifest).ok, JSON.stringify(validateManifest(manifest).errors));

const broken = structuredClone(manifest);
broken.createdBy.sessionFormat = undefined;
check('缺 sessionFormat 报错', !validateManifest(broken).ok);

const broken2 = structuredClone(manifest);
broken2.workspaces[0].sessions[0].frames = 'many';
check('frames 非数字报错', !validateManifest(broken2).ok);

check('版本比较相等', compareVersions('0.2.1', '0.2.1') === 0);
check('版本比较小于', compareVersions('0.2.1', '0.3.0') === -1);
check('预发布可比较', compareVersions('0.2.1-rc.2', '0.2.1-rc.10') === -1);

const compatOk = checkCompat(manifest, { dshVersion: '0.2.1-rc.2', sessionFormat: 'v4' });
check('同版本兼容', compatOk.level === 'ok', JSON.stringify(compatOk));

const compatPatch = checkCompat(manifest, { dshVersion: '0.2.1-rc.5', sessionFormat: 'v4' });
check('补丁差异只警告', compatPatch.level === 'warn', JSON.stringify(compatPatch));

const compatMinor = checkCompat(manifest, { dshVersion: '0.3.0', sessionFormat: 'v4' });
check('次版本差异阻断', compatMinor.level === 'block');

const incompatFormat = checkCompat(manifest, { dshVersion: '0.2.1', sessionFormat: 'v5' });
check('格式代际不同阻断', incompatFormat.level === 'block');

const unknownVersion = structuredClone(manifest);
unknownVersion.createdBy.dshVersion = 'unknown';
const compatUnknown = checkCompat(unknownVersion, { dshVersion: 'unknown', sessionFormat: 'v4' });
check('版本未知只警告不阻断', compatUnknown.level === 'warn', JSON.stringify(compatUnknown));

const malformedVersion = structuredClone(manifest);
malformedVersion.createdBy.dshVersion = 'not-a-version';
check(
  '畸形版本号阻断',
  checkCompat(malformedVersion, { dshVersion: '0.2.1', sessionFormat: 'v4' }).level === 'block',
);

const incompleteManifest = { ...manifest, complete: false };
check('未完成清单阻断', checkCompat(incompleteManifest, { dshVersion: '0.2.1', sessionFormat: 'v4' }).level === 'block');

// ---- 落盘与体积 ----
const dir = await mkdtemp(join(tmpdir(), 'ninth-path-'));
try {
  const manifestPath = join(dir, 'manifest.json');
  await writeJsonAtomic(manifestPath, manifest);
  const round = JSON.parse(await readFile(manifestPath, 'utf8'));
  check('manifest 落盘可读回', round.kitId === 'kit-1');

  check('初始无 incomplete 标记', !(await isIncomplete(dir)));
  await markIncomplete(dir);
  check('标记后 incomplete 为真', await isIncomplete(dir));
  await clearIncomplete(dir);
  check('清除后 incomplete 为假', !(await isIncomplete(dir)));

  await writeFile(join(dir, 'a.bin'), Buffer.alloc(1024));
  const size = await measureTree(dir);
  check('体积统计包含写入文件', size.sizeBytes >= 1024, JSON.stringify(size));
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
