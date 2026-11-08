/**
 * 第九通路 — 零依赖 Word (.docx) 生成器。
 *
 * 只支持：标题 H1/H2、段落、带表头的表格、分页符、加粗与颜色。
 * 不引入第三方库：ZIP 容器用 node:zlib 的 deflateRaw 手写，OOXML 直接拼字符串。
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** entries: [{ name, data: Buffer }] → Buffer */
export function zip(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const ascii = !/[^\x00-\x7F]/.test(entry.name);
    const name = Buffer.from(entry.name, ascii ? 'ascii' : 'utf8');
    const flags = ascii ? 0 : 0x0800; // bit 11：文件名按 UTF-8 解释
    const raw = entry.data;
    const body = deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeXml(text) {
  return String(text ?? '').replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

function runsToXml(runs) {
  return runs
    .map((run) => {
      const props = [];
      if (run.bold) props.push('<w:b/>');
      if (run.italic) props.push('<w:i/>');
      if (run.color) props.push(`<w:color w:val="${escapeXml(run.color)}"/>`);
      if (run.size) props.push(`<w:sz w:val="${Math.round(run.size)}"/><w:szCs w:val="${Math.round(run.size)}"/>`);
      if (run.mono) {
        props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
      }
      const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
      const lines = String(run.text ?? '').split('\n');
      const body = lines
        .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
        .join('<w:br/>');
      return `<w:r>${rPr}${body}</w:r>`;
    })
    .join('');
}

function paragraph(value, options = {}) {
  const runs = Array.isArray(value) ? value : [{ text: value, ...options }];
  const spacing = options.spacing ?? 80;
  const pPr =
    `<w:pPr><w:spacing w:before="${spacing}" w:after="${spacing}" w:line="300" w:lineRule="auto"/>` +
    (options.align ? `<w:jc w:val="${options.align}"/>` : '') +
    '</w:pPr>';
  return `<w:p>${pPr}${runsToXml(runs)}</w:p>`;
}

function heading(text, level) {
  const size = level === 1 ? 36 : 28;
  const color = level === 1 ? '101828' : '344054';
  return (
    `<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr>` +
    runsToXml([{ text, bold: true, size, color }]) +
    '</w:p>'
  );
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function cell(text, widthTwips, options = {}) {
  const fill = options.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>` : '';
  const run = { text: String(text ?? ''), bold: options.bold, mono: options.mono, size: 18 };
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/>${fill}` +
    `<w:vAlign w:val="center"/></w:tcPr>` +
    `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${runsToXml([run])}</w:p></w:tc>`
  );
}

const PAGE_WIDTH = 9638; // A4 可用宽度（twips）

function table(header, rows, options = {}) {
  const columns = header.length;
  const ratio = options.weights ?? header.map(() => 1);
  const total = ratio.reduce((a, b) => a + b, 0);
  const widths = ratio.map((r) => Math.round((PAGE_WIDTH * r) / total));

  const border = (side) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D0D5DD"/>`;

  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header
    .map((text, i) => cell(text, widths[i], { bold: true, fill: 'F2F4F7' }))
    .join('')}</w:tr>`;

  const body = rows
    .map((row) => {
      const abnormal = row.abnormal === true;
      return `<w:tr>${row.cells
        .map((text, i) =>
          cell(text, widths[i], {
            mono: options.monoColumns?.includes(i) ?? false,
            fill: abnormal ? 'FEF3F2' : undefined,
          }),
        )
        .join('')}</w:tr>`;
    })
    .join('');

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${PAGE_WIDTH}" w:type="dxa"/>` +
    `<w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map(border)
      .join('')}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    `${head}${body}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`
  );
}

/**
 * 文档模型：{ title, subtitle?, sections: [{ heading, blocks: Block[] }] }
 * Block: { type:'h2', text } | { type:'p', runs|text } | { type:'table', header, rows, weights?, monoColumns? } | { type:'page-break' }
 */
export function buildDocx(doc) {
  const parts = [];
  parts.push(heading(doc.title ?? '恢复报告', 1));
  if (doc.subtitle) parts.push(paragraph([{ text: doc.subtitle, color: '667085', size: 18 }]));

  for (const section of doc.sections ?? []) {
    if (section.pageBreakBefore) parts.push(pageBreak());
    if (section.heading) parts.push(heading(section.heading, 2));
    for (const block of section.blocks ?? []) {
      if (block.type === 'h2') parts.push(heading(block.text, 2));
      else if (block.type === 'page-break') parts.push(pageBreak());
      else if (block.type === 'table') {
        const rows = (block.rows ?? []).map((row) =>
          Array.isArray(row) ? { cells: row } : { cells: row.cells, abnormal: row.abnormal },
        );
        parts.push(table(block.header, rows, block));
      } else parts.push(paragraph(block.runs ?? block.text ?? '', block));
    }
  }

  const sectPr =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
    'w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${parts.join('')}${sectPr}</w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="word/document.xml"/></Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') },
  ]);
}
