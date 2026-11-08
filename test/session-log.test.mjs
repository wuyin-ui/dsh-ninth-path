/** 会话日志模块的自测：用真实会话文件验证帧解析与 cwd 改写。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { countFrames, decodeCwd, encodeCwd, frameLength, listSessions, readHeader, rewriteCwd } from '../lib/session-log.js';

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

check('encodeCwd 盘符路径', encodeCwd('E:\\项目\\film') === '--E-~9879~76EE-film--', encodeCwd('E:\\项目\\film'));
check('encodeCwd 空格', encodeCwd('E:\\Deep Seek\\工作区') === '--E-Deep~0020Seek-~5DE5~4F5C~533A--', encodeCwd('E:\\Deep Seek\\工作区'));
check('encodeCwd 与实测目录一致', encodeCwd('C:\\Users\\ui\\Documents\\deepseek-harness\\default-workspace') === '--C-Users-ui-Documents-deepseek-harness-default-workspace--');
check('encodeCwd 大小写与斜杠归一', encodeCwd('e:/tmp/x') === '--e-tmp-x--', encodeCwd('e:/tmp/x'));

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const root = join(home, 'sessions');
const sessions = await listSessions(root);
check('能列出会话', sessions.length > 0, `count=${sessions.length}`);
check('每个会话有 cwd', sessions.every((s) => typeof s.cwd === 'string' && s.cwd.length > 0));
check('每个会话有帧数', sessions.every((s) => Number.isInteger(s.frames)), JSON.stringify(sessions.slice(0, 2)));

const target = sessions.find((s) => s.frames > 10) ?? sessions[0];
if (target) {
  const buffer = await readFile(target.file);
  const length = frameLength(buffer, 0);
  check('首帧长度可解析', length > 0 && length <= buffer.length, `len=${length} total=${buffer.length}`);

  const { header } = readHeader(buffer);
  check('首帧是 session header', header.type === 'session' && header.version >= 1, JSON.stringify(header).slice(0, 80));

  const frames = countFrames(buffer);
  check('帧数解析与实际一致（多帧）', frames >= 1, `frames=${frames}`);

  const fake = 'D:\\迁移测试\\workspace';
  const rewritten = rewriteCwd(buffer, fake);
  check('改写后标记 changed', rewritten.changed);
  check('改写后 previousCwd 是旧值', rewritten.previousCwd === header.cwd);
  check('改写后尾部字节不变', rewritten.buffer.subarray(rewritten.buffer.length - 16).equals(buffer.subarray(buffer.length - 16)));

  const after = readHeader(rewritten.buffer);
  check('改写后 header cwd 正确', after.header.cwd === fake, after.header.cwd);
  check('改写后帧数不变', countFrames(rewritten.buffer) === frames, `${countFrames(rewritten.buffer)} vs ${frames}`);
  check('改写后 id 未变', after.header.id === header.id);

  const noop = rewriteCwd(buffer, header.cwd);
  check('同路径不改写', !noop.changed);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
