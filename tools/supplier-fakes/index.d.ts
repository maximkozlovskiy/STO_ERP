/** Типи для `index.js` — фейкові сервери API постачальників (див. коментар у index.js). */
export type FakeProvider = 'avd' | 'bm' | 'tehnomir' | 'utr' | 'ad';
export type FakeScenarioMode =
  'ok' | '401' | '429' | '500' | '503' | 'timeout' | 'notFound' | 'partial';

export interface FakeRequestLog {
  provider: FakeProvider;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  at: string;
}

export interface SupplierFakes {
  url: string;
  port: number;
  providers: FakeProvider[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- стан фейку для перевірок у тестах
  state: {
    requests: FakeRequestLog[];
    scenarios: Record<string, unknown>;
    data: Record<string, any>;
  };
  reset(): void;
  setScenario(
    provider: FakeProvider,
    mode: FakeScenarioMode,
    extra?: { times?: number; path?: string; retryAfter?: number },
  ): void;
  requests(provider?: FakeProvider): FakeRequestLog[];
  close(): Promise<void>;
}

export function startSupplierFakes(opts?: { port?: number; host?: string }): Promise<SupplierFakes>;
export const PROVIDER_FILES: Record<FakeProvider, string>;
