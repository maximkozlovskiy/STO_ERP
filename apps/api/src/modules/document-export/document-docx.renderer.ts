import {
  DOCX_TEXT_WIDTH,
  buildDocx,
  docxPara,
  docxParagraph,
  docxRun,
  docxTable,
  docxTableRow,
} from '../../common/office/docx';
import type { OrgPrintInfo } from '../pdf/org-print-info.types';
import {
  DELETED_MARK,
  cellText,
  columnLabel,
  currencySuffix,
  fmtPrintMoney,
  orgDetailLines,
  type PrintableDocument,
} from './printable-document';

/** Ширини колонок у twip: числові вужчі, решту забирає перша (назва). */
function gridColumns(doc: PrintableDocument): number[] {
  const fixed = doc.columns.map((c, i): number =>
    i === 0 ? 0 : c.kind === 'money' ? 1500 : c.kind === 'qty' ? 1100 : 800,
  );
  const rest = DOCX_TEXT_WIDTH - fixed.reduce((s, w) => s + w, 0);
  return fixed.map((w, i) => (i === 0 ? Math.max(rest, 2000) : w));
}

/** DOCX друкованого документа — та сама модель, що PDF і XLSX. */
export function renderDocumentDocx(org: OrgPrintInfo, doc: PrintableDocument): Buffer {
  const body: string[] = [docxPara(org.name, true, 24)];
  for (const l of orgDetailLines(org)) body.push(docxPara(l, false, 16, '666666'));
  body.push(docxPara(''));
  body.push(docxPara(`${doc.title} № ${doc.number}`, true, 28));
  if (doc.deleted) body.push(docxPara(DELETED_MARK, true, 24, 'C00000'));
  body.push(docxPara(`Дата: ${doc.date}`, false, 20));
  for (const f of doc.fields) body.push(docxPara(`${f.label}: ${f.value}`, false, 20));
  for (const p of doc.parties) {
    body.push(docxPara(`${p.label}:`, true, 18));
    p.lines.forEach((l, i) => body.push(docxPara(l, false, i === 0 ? 20 : 18)));
  }
  body.push(docxPara(''));

  const align = (i: number) => (doc.columns[i]?.kind === 'text' ? 'left' : 'right');
  body.push(
    docxTable(
      [
        docxTableRow(
          doc.columns.map(c => columnLabel(c, doc.currencyCode)),
          true,
          'D9E1F2',
          align,
        ),
        ...doc.rows.map(r =>
          docxTableRow(
            doc.columns.map((c, i) => cellText(c.kind, r[i] ?? null)),
            false,
            undefined,
            align,
          ),
        ),
      ],
      gridColumns(doc),
    ),
  );
  body.push(docxPara(''));

  const suffix = currencySuffix(doc.currencyCode);
  for (const t of doc.totals)
    body.push(
      docxParagraph(
        docxRun(`${t.label}: ${fmtPrintMoney(t.value)} ${suffix}`, {
          bold: !!t.strong,
          size: t.strong ? 24 : 20,
        }),
        'right',
      ),
    );
  if (doc.notes) {
    body.push(docxPara(''));
    body.push(docxPara(`Примітка: ${doc.notes}`, false, 18));
  }
  return buildDocx(body, `${doc.title} ${doc.number}`);
}
