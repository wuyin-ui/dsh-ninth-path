/** 生成一份样例报告，用于验证 Word/LibreOffice 能正常打开。 */
import { writeFile } from 'node:fs/promises';
import { buildDocx } from '../lib/docx.js';

const doc = {
  title: '恢复报告',
  subtitle: '第九通路 · 无银ui · a1lzui@163.com · 2026-11-08 17:30',
  sections: [
    {
      heading: '一、概要',
      blocks: [
        { type: 'p', runs: [{ text: '宿主版本：', bold: true }, { text: '0.2.1-rc.2（会话格式 v4）' }] },
        { type: 'p', runs: [{ text: '备份来源：', bold: true }, { text: 'desktop-2a91 / ui，2026-11-07 22:10' }] },
        { type: 'p', runs: [{ text: '总量：', bold: true }, { text: '19.4 MB（宿主 18.1 MB / 工作区文件 1.2 MB / 附件 0 B）' }] },
        { type: 'p', runs: [{ text: '异常：', bold: true, color: 'C00000' }, { text: '2 条会话的 cwd 仍指向旧路径，见第三节。' }] },
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
            ['E:\\项目\\film', 'E:\\项目\\film', 'reuse', '14', '2310'],
            ['E:\\资料\\生物', 'E:\\资料\\生物', 'reuse', '6', '812'],
            ['C:\\Users\\ui\\Documents\\deepseek-harness\\default-workspace', 'D:\\work\\dsh', 'newPath', '7', '96'],
          ],
        },
      ],
    },
    {
      pageBreakBefore: true,
      heading: '三、会话明细',
      blocks: [
        {
          type: 'table',
          header: ['会话 ID', '标题', '帧数', '校验'],
          weights: [34, 36, 14, 16],
          monoColumns: [0],
          rows: [
            ['session-68ad263d', '分子动力学笔记', '1792', '通过'],
            ['session-101fee6b', '数学作业整理', '1440', '通过'],
            { cells: ['session-122cb29d', '插件设计（cwd 已失效）', '12', '警告'], abnormal: true },
          ],
        },
        { type: 'p', text: '标红行表示需要人工确认；其余会话可直接打开。' },
      ],
    },
    {
      heading: '四、待办',
      blocks: [
        { type: 'p', text: '1. 重启客户端以加载恢复后的会话列表。' },
        { type: 'p', text: '2. 重新登录账号，并重新填回被脱敏的 API Key。' },
        { type: 'p', text: '3. 若旧版客户端被自动更新，版本会前移；这不影响已恢复的数据。' },
      ],
    },
  ],
};

const out = process.argv[2] ?? 'test/sample-恢复报告.docx';
await writeFile(out, buildDocx(doc));
console.log(`written: ${out}`);
