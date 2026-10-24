// BR-WO-032: панель посилання на кошторис — дата згорання, «Згенерувати нове», «Відкликати»;
// після відкликання — стан «відкликано» без кнопки «Відкликати».
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareLinkPanel } from '../ShareLinkPanel';

const handlers = () => ({
  onCopy: vi.fn(),
  onRegenerate: vi.fn(),
  onRevoke: vi.fn(),
  onClose: vi.fn(),
});

describe('ShareLinkPanel', () => {
  // guards: BR-WO-032
  it('чинне посилання: адреса, «Діє до» за київським часом, обидві дії', async () => {
    const h = handlers();
    render(
      <ShareLinkPanel
        link={{ status: 'active', token: 'tok-1', expiresAt: '2026-11-23T10:00:00.000Z' }}
        loading={false}
        {...h}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Посилання на кошторис для клієнта' })).toHaveValue(
      `${window.location.origin}/estimate/tok-1`,
    );
    // 10:00 UTC 23.11 — зимовий час, Київ +02:00.
    expect(screen.getByTestId('wo-share-expires')).toHaveTextContent('Діє до 23.11.2026, 12:00');

    await userEvent.click(screen.getByRole('button', { name: 'Відкликати' }));
    await userEvent.click(screen.getByRole('button', { name: 'Згенерувати нове' }));
    await userEvent.click(screen.getByRole('button', { name: 'Копіювати' }));
    expect(h.onRevoke).toHaveBeenCalledTimes(1);
    expect(h.onRegenerate).toHaveBeenCalledTimes(1);
    expect(h.onCopy).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-032
  it('відкликане посилання: повідомлення, лише «Згенерувати нове»', () => {
    render(<ShareLinkPanel link={{ status: 'revoked' }} loading={false} {...handlers()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Посилання відкликано');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Відкликати' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Згенерувати нове' })).toBeEnabled();
  });

  it('поки запит у польоті — дії вимкнені', () => {
    render(
      <ShareLinkPanel
        link={{ status: 'active', token: 't', expiresAt: '2026-11-23T10:00:00.000Z' }}
        loading
        {...handlers()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Відкликати' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Згенерувати нове' })).toBeDisabled();
  });

  it('«Закрити» і клік поза панеллю закривають її', async () => {
    const h = handlers();
    const { container } = render(
      <ShareLinkPanel link={{ status: 'revoked' }} loading={false} {...h} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }));
    await userEvent.click(container.querySelector('[role="presentation"]')!);
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });
});
