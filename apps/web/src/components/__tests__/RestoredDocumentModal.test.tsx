// Стандарт згортання картки документа у вкладку: кожна картка, що вміє згортатись
// (наряд, рахунок, замовлення постачальнику, складський документ), відновлюється кліком по
// вкладці. До 2026-10-14 відновлювався лише наряд: решта карток лишали вкладку, клік по якій
// нічого не відкривав.
//
// Mutation-verify: прибрати запис із RESTORABLE_MODALS → кейс цього типу падає; прибрати
// `minimizingRef` → кейс «повторне згортання лишає вкладку» падає; прибрати
// 'stockDocumentId' з IDENTITY_KEYS у TabBarContext → кейс про дублікати падає.

import { Suspense, lazy, type ComponentType } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<ComponentType<Record<string, unknown>>>) => {
    const Lazy = lazy(() => loader().then(C => ({ default: C })));
    return function Dynamic(props: Record<string, unknown>) {
      return (
        <Suspense fallback={null}>
          <Lazy {...props} />
        </Suspense>
      );
    };
  },
}));

interface StubProps {
  onClose: () => void;
  onMinimize?: () => void;
  [key: string]: unknown;
}

// Заглушка картки: показує, який документ відкрито, і дає «закрити» та «згорнути».
const stub = (testId: string, idProp: string) =>
  function CardStub(props: StubProps) {
    return (
      <div data-testid={testId} data-doc-id={String(props[idProp])}>
        <button onClick={props.onClose}>закрити</button>
        <button
          onClick={() => {
            props.onMinimize?.();
            props.onClose();
          }}
        >
          згорнути знову
        </button>
      </div>
    );
  };

vi.mock('@/components/ui/CreateWorkOrderModal', () => ({
  CreateWorkOrderModal: stub('card-work-order', 'workOrderId'),
}));
vi.mock('@/components/ui/InvoiceCreateModal', () => ({
  InvoiceCreateModal: stub('card-invoice', 'invoiceId'),
}));
vi.mock('@/components/ui/PurchaseOrderCreateModal', () => ({
  PurchaseOrderCreateModal: stub('card-purchase-order', 'purchaseOrderId'),
}));
vi.mock('@/components/ui/StockDocumentCreateModal', () => ({
  StockDocumentCreateModal: stub('card-stock-document', 'stockDocumentId'),
}));

import { TabBarProvider, useTabBarContext } from '@/contexts/TabBarContext';
import { RestoredDocumentModal } from '../RestoredDocumentModal';

// Замість справжньої панелі вкладок: кнопка «згорнути» кладе вкладку, клік по вкладці
// ставить pendingRestore — те саме, що робить useTabBar.activateTab.
function Harness({ modalKey, idProp }: { modalKey: string; idProp: string }) {
  const { tabs, minimizeModal, restoreModal, setPendingRestore } = useTabBarContext();
  return (
    <>
      <button
        onClick={() =>
          minimizeModal({
            kind: 'modal',
            label: 'ДОК-1',
            modalKey,
            restoreProps: { [idProp]: 'doc-1' },
          })
        }
      >
        згорнути
      </button>
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => setPendingRestore(restoreModal(tab.id))}>
          вкладка {tab.label}
        </button>
      ))}
      <RestoredDocumentModal />
    </>
  );
}

function renderHarness(modalKey: string, idProp: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TabBarProvider>
        <Harness modalKey={modalKey} idProp={idProp} />
      </TabBarProvider>
    </QueryClientProvider>,
  );
}

const tabs = () => screen.queryAllByRole('button', { name: 'вкладка ДОК-1' });
const click = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });

const CARDS = [
  ['work-order', 'workOrderId'],
  ['invoice', 'invoiceId'],
  ['purchase-order', 'purchaseOrderId'],
  ['stock-document', 'stockDocumentId'],
] as const;

describe('Згорнута у вкладку картка документа відновлюється кліком по вкладці', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(CARDS)('%s: клік по вкладці відкриває картку цього документа', async (key, idProp) => {
    renderHarness(key, idProp);
    await click('згорнути');
    expect(tabs()).toHaveLength(1);

    await click('вкладка ДОК-1');

    const card = await screen.findByTestId(`card-${key}`);
    expect(card).toHaveAttribute('data-doc-id', 'doc-1');
  });

  it.each(CARDS)('%s: закриття відновленої картки прибирає вкладку', async (key, idProp) => {
    renderHarness(key, idProp);
    await click('згорнути');
    await click('вкладка ДОК-1');
    await screen.findByTestId(`card-${key}`);

    await click('закрити');

    expect(screen.queryByTestId(`card-${key}`)).not.toBeInTheDocument();
    expect(tabs()).toHaveLength(0);
  });

  it.each(CARDS)(
    '%s: повторне згортання лишає вкладку, і вона відкривається ще раз',
    async (key, idProp) => {
      renderHarness(key, idProp);
      await click('згорнути');
      await click('вкладка ДОК-1');
      await screen.findByTestId(`card-${key}`);

      await click('згорнути знову');

      expect(screen.queryByTestId(`card-${key}`)).not.toBeInTheDocument();
      expect(tabs()).toHaveLength(1);

      await click('вкладка ДОК-1');
      expect(await screen.findByTestId(`card-${key}`)).toBeInTheDocument();
    },
  );

  it.each(CARDS)(
    '%s: той самий документ, згорнутий двічі, дає одну вкладку',
    async (key, idProp) => {
      renderHarness(key, idProp);
      await click('згорнути');
      await click('згорнути');

      expect(tabs()).toHaveLength(1);
    },
  );

  it('вкладка невідомого типу нічого не відкриває і не блокує наступні відкриття', async () => {
    renderHarness('no-such-card', 'someId');
    await click('згорнути');
    await click('вкладка ДОК-1');
    await click('вкладка ДОК-1');

    expect(screen.queryByTestId(/^card-/)).not.toBeInTheDocument();
    expect(tabs()).toHaveLength(1);
  });
});
