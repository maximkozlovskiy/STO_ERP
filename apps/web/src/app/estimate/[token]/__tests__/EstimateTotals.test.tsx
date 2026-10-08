// Публічний кошторис: коли ПДВ у плановій сумі є — три рядки, інакше одна «Загальна сума».
//
// Mutation-verify: завжди рендерити гілку без ПДВ → кейс «три рядки» падає; завжди гілку з
// ПДВ → кейс «одна сума» падає.
import { render, screen } from '@testing-library/react';
import { it, expect, describe } from 'vitest';
import { EstimateTotals } from '../EstimateTotals';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

// guards: BR-WO-007
describe('EstimateTotals — підсумок публічного кошторису', () => {
  it('ПДВ є: «Сума без ПДВ», «ПДВ», «Разом до сплати»', () => {
    render(<EstimateTotals totalAmount={1440} totalNet={1200} />);

    const text = norm(screen.getByTestId('estimate-vat-totals').textContent);
    expect(text).toContain('Сума без ПДВ:1 200,00 ₴');
    expect(text).toContain('ПДВ:240,00 ₴');
    expect(text).toContain('Разом до сплати:1 440,00 ₴');
    expect(screen.queryByText('Загальна сума:')).toBeNull();
  });

  it('ПДВ немає: одна «Загальна сума»', () => {
    render(<EstimateTotals totalAmount={1200} totalNet={1200} />);

    expect(screen.queryByTestId('estimate-vat-totals')).toBeNull();
    expect(screen.getByText('Загальна сума:')).toBeTruthy();
    expect(norm(document.body.textContent)).toContain('1 200,00 ₴');
    expect(screen.queryByText('ПДВ:')).toBeNull();
  });

  it('стара відповідь без totalNet: одна сума, без NaN', () => {
    render(<EstimateTotals totalAmount={1200} />);
    expect(norm(document.body.textContent)).toContain('1 200,00 ₴');
    expect(document.body.textContent).not.toContain('NaN');
  });
});
