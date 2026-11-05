import PizZip from 'pizzip';
import { DOCX_MIME } from './mime';

/**
 * Мінімальний DOCX (WordprocessingML) без шаблону: абзаци, таблиці й пакет із обов'язковими
 * частинами. Спільний для кошторису наряду (`EstimateExportService`) і друку документів
 * (`document-export`) — окремі копії розмітки ловить гейт copy-paste.
 */

/** Символи, заборонені в XML 1.0 (керівні, крім TAB/LF/CR): Word відмовляється відкрити файл. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Текст для вузла чи атрибута XML. */
export function xmlEscape(s: string): string {
  return s
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type DocxAlign = 'left' | 'right' | 'center';

export interface DocxRunStyle {
  bold?: boolean;
  /** Розмір у пів-пунктах (22 = 11 pt). */
  size?: number;
  /** Колір RRGGBB. */
  color?: string;
}

/** Фрагмент тексту з оформленням (`<w:r>`). */
export function docxRun(text: string, { bold, size, color }: DocxRunStyle = {}): string {
  const rPr = [
    bold ? '<w:b/>' : '',
    size ? `<w:sz w:val="${size}"/>` : '',
    color ? `<w:color w:val="${color}"/>` : '',
  ].join('');
  return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

/** Абзац з одного або кількох фрагментів. */
export function docxParagraph(runs: string | string[], align?: DocxAlign): string {
  const pPr = align ? `<w:pPr><w:jc w:val="${align}"/></w:pPr>` : '';
  return `<w:p>${pPr}${Array.isArray(runs) ? runs.join('') : runs}</w:p>`;
}

/** Абзац одного тексту. */
export function docxPara(text: string, bold = false, size = 22, color = '000000'): string {
  return docxParagraph(docxRun(text, { bold, size, color }));
}

const CELL_BORDERS = `<w:tcBorders>
        <w:top w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:left w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/>
        <w:right w:val="single" w:sz="4" w:color="CCCCCC"/>
      </w:tcBorders>`;

/**
 * Рядок таблиці. `align(i)` — вирівнювання i-ї комірки; типово перша ліворуч, решта праворуч
 * (назва, далі числа).
 */
export function docxTableRow(
  cells: string[],
  bold = false,
  shade?: string,
  align: (i: number) => DocxAlign = i => (i === 0 ? 'left' : 'right'),
): string {
  const tds = cells.map((c, i) => {
    const fill = shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '';
    return `<w:tc><w:tcPr>${fill}${CELL_BORDERS}</w:tcPr>
      <w:p><w:pPr><w:jc w:val="${align(i)}"/></w:pPr>
      <w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="18"/></w:rPr>
      <w:t xml:space="preserve">${xmlEscape(c)}</w:t></w:r></w:p></w:tc>`;
  });
  return `<w:tr>${tds.join('')}</w:tr>`;
}

/** Таблиця з фіксованими ширинами колонок (у twip, сума — ширина таблиці). */
export function docxTable(rows: string[], gridCols: number[]): string {
  const width = gridCols.reduce((s, w) => s + w, 0);
  const grid = gridCols.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`;
}

/** Ширина тексту сторінки DOCX у twip (A4/Letter з полями `pgMar` нижче). */
export const DOCX_TEXT_WIDTH = 9360;

function documentXml(body: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/package.core-properties+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
</w:styles>`;

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>OneService</Application>
</Properties>`;

function coreXml(title: string): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>OneService</dc:creator>
  <cp:created>${now}</cp:created>
</cp:coreProperties>`;
}

/** Пакет DOCX: тіло документа (абзаци й таблиці) + службові частини. */
export function buildDocx(body: string[], title: string): Buffer {
  const zip = new PizZip();
  zip.file('word/document.xml', documentXml(body));
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('word/_rels/document.xml.rels', DOC_RELS_XML);
  zip.file('word/styles.xml', STYLES_XML);
  zip.file('word/settings.xml', SETTINGS_XML);
  zip.file('docProps/app.xml', APP_XML);
  zip.file('docProps/core.xml', coreXml(title));
  return Buffer.from(zip.generate({ type: 'nodebuffer', mimeType: DOCX_MIME }));
}
