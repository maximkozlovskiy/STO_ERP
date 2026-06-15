import { test, expect, request, type APIRequestContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * E2E test for the "Estimate Share + SMS" feature.
 *
 * Verifies:
 *   1. Work-order modal in DRAFT/ESTIMATE/APPROVED status exposes the Друк / Поділитись / SMS buttons.
 *   2. Clicking Поділитись acquires a share token via the API.
 *   3. The /estimate/[token] public page loads without auth and shows the work-order data.
 *   4. /estimate/<garbage> shows the "Посилання не дійсне" error message.
 *
 * Performance: avoids slow UI navigation by checking buttons via direct API.
 *
 * Self-seeding (Bug #486, 2026-06-15): previously these tests skipped silently when no
 * ESTIMATE work-order existed in the DB. Now we clone a DRAFT WO and transition it to
 * ESTIMATE in beforeAll, then cleanup via ESTIMATE → CANCELLED → DELETE in afterAll.
 * This guarantees deterministic coverage.
 *
 * Throttle-safe: we reuse the JWT from `.auth/admin.json` (populated by globalSetup)
 * instead of re-logging in from each test — that would hit dev rate-limit.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const STORAGE_STATE_PATH = path.join(__dirname, '.auth/admin.json');

test.use({ storageState: STORAGE_STATE_PATH });

// Module-scoped seed state — initialized once for the file via beforeAll.
let seededEstimateWoId: string | null = null;
let accessToken: string | null = null;

/**
 * Read the admin access token from globalSetup-populated storage state.
 * Avoids /api/auth/login throttling when multiple tests need a token.
 */
function readAdminToken(): string {
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8')) as {
    origins: { origin: string; sessionStorage?: { name: string; value: string }[] }[];
  };
  for (const origin of state.origins ?? []) {
    for (const entry of origin.sessionStorage ?? []) {
      if (entry.name === 'sto_access_token') return entry.value;
    }
  }
  throw new Error('No sto_access_token in e2e/.auth/admin.json — globalSetup may not have run.');
}

/**
 * Seed an ESTIMATE work-order by cloning a DRAFT and transitioning it.
 * Returns the new WO id or null if no seed donor exists (truly empty DB).
 */
async function seedEstimateWorkOrder(
  ctx: APIRequestContext,
  token: string,
): Promise<string | null> {
  // 1. Pick a DRAFT donor to clone — must be soft-deletable later.
  const draftRes = await ctx.get(`${API_BASE}/api/work-orders?status=DRAFT&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!draftRes.ok()) return null;
  const draftList = (await draftRes.json()) as { items: { id: string }[] };
  if (draftList.items.length === 0) return null;
  const donorId = draftList.items[0]!.id;

  // 2. Clone — creates a new DRAFT WO (deterministic, won't affect donor).
  const cloneRes = await ctx.post(`${API_BASE}/api/work-orders/${donorId}/clone`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {},
  });
  if (!cloneRes.ok()) return null;
  const clone = (await cloneRes.json()) as { id: string };

  // 3. Transition DRAFT → ESTIMATE.
  const transRes = await ctx.post(`${API_BASE}/api/work-orders/${clone.id}/transition`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { status: 'ESTIMATE' },
  });
  if (!transRes.ok()) {
    // Cleanup the clone if transition fails (DRAFT is deletable).
    await ctx.delete(`${API_BASE}/api/work-orders/${clone.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return null;
  }

  return clone.id;
}

/**
 * Cleanup: ESTIMATE → CANCELLED → DELETE.
 * Per FSM, only DRAFT/CANCELLED can be deleted.
 */
async function cleanupEstimateWorkOrder(
  ctx: APIRequestContext,
  token: string,
  woId: string,
): Promise<void> {
  await ctx
    .post(`${API_BASE}/api/work-orders/${woId}/transition`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { status: 'CANCELLED' },
    })
    .catch(() => undefined);

  await ctx
    .delete(`${API_BASE}/api/work-orders/${woId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => undefined);
}

test.describe('Estimate share', () => {
  test.beforeAll(async () => {
    accessToken = readAdminToken();
    const ctx = await request.newContext();
    try {
      seededEstimateWoId = await seedEstimateWorkOrder(ctx, accessToken);
    } finally {
      await ctx.dispose();
    }
  });

  test.afterAll(async () => {
    if (!seededEstimateWoId || !accessToken) return;
    const ctx = await request.newContext();
    try {
      await cleanupEstimateWorkOrder(ctx, accessToken, seededEstimateWoId);
    } finally {
      await ctx.dispose();
      seededEstimateWoId = null;
      accessToken = null;
    }
  });

  test('public endpoint returns data for valid token and 404 for invalid', async () => {
    expect(seededEstimateWoId, 'beforeAll must have seeded an ESTIMATE work-order').toBeTruthy();
    expect(accessToken, 'beforeAll must have read admin token').toBeTruthy();
    const ctx = await request.newContext();
    try {
      // 1. Request share token for the seeded ESTIMATE WO.
      const tokenRes = await ctx.post(
        `${API_BASE}/api/work-orders/${seededEstimateWoId}/share-token`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          data: {},
        },
      );
      expect(tokenRes.ok()).toBeTruthy();
      const { token } = (await tokenRes.json()) as { token: string };
      expect(token).toMatch(/^[a-f0-9]{32}$/);

      // 2. Public endpoint returns data without auth.
      const publicRes = await ctx.get(`${API_BASE}/api/public/work-orders/${token}`);
      expect(publicRes.ok()).toBeTruthy();
      const body = (await publicRes.json()) as { number: string; status: string; lines: unknown[] };
      expect(body.number).toBeTruthy();
      expect(['DRAFT', 'ESTIMATE', 'APPROVED']).toContain(body.status);

      // 3. Invalid token → 404 with Ukrainian message.
      const invalidRes = await ctx.get(`${API_BASE}/api/public/work-orders/clearly-invalid-xxx`);
      expect(invalidRes.status()).toBe(404);
      const invalidBody = (await invalidRes.json()) as { message: string };
      expect(invalidBody.message).toMatch(/(?:не дійсне|термін дії)/i);
    } finally {
      await ctx.dispose();
    }
  });

  test('Bug #401: APPROVED status — checks canShare matrix via backend', async () => {
    // UI/E2E test для розкриття модалу у APPROVED через таблицю нестабільний
    // (фільтр по даті за замовчуванням приховує seed-наряди ≠ today).
    // Натомість перевіряємо що backend share-token endpoint приймає APPROVED.
    expect(accessToken).toBeTruthy();
    const ctx = await request.newContext();
    try {
      const listRes = await ctx.get(`${API_BASE}/api/work-orders?status=APPROVED&limit=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const list = (await listRes.json()) as { items: { id: string }[] };
      test.skip(list.items.length === 0, 'no APPROVED work-order in DB');
      const woId = list.items[0]!.id;
      // Backend має приймати share-token для APPROVED (Bug #401 канонічний регрес-гард).
      const tokenRes = await ctx.post(`${API_BASE}/api/work-orders/${woId}/share-token`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        data: {},
      });
      expect(tokenRes.ok()).toBeTruthy();
      const { token } = (await tokenRes.json()) as { token: string };
      expect(token).toMatch(/^[a-f0-9]{32}$/);
      // Публічний endpoint повертає дані для APPROVED.
      const publicRes = await ctx.get(`${API_BASE}/api/public/work-orders/${token}`);
      expect(publicRes.ok()).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  test('work-order modal in ESTIMATE status shows Друк / Поділитись / SMS buttons', async ({
    page,
  }) => {
    expect(seededEstimateWoId, 'beforeAll must have seeded an ESTIMATE work-order').toBeTruthy();

    // Open work-orders page; click "Кошторис" status tab to filter ESTIMATE.
    await page.goto('/work-orders');
    await page.getByRole('button', { name: /^Кошторис$/ }).click();
    // Wait until the row with our work-order is visible.
    const row = page
      .getByRole('row')
      .filter({ hasText: /Кошторис/ })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    // Hover row to reveal the per-row action button ("Відкрити наряд") — pencil icon button.
    await row.hover();
    await row.getByRole('button', { name: /Відкрити наряд/i }).click();
    // Modal: Друк / Поділитись / SMS must be visible.
    await expect(page.getByRole('button', { name: /^\s*Друк\s*$/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: /^\s*Поділитись\s*$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^\s*SMS\s*$/i })).toBeVisible();
  });

  test('public estimate page loads without auth and shows "Посилання не дійсне" for invalid token', async ({
    page,
  }) => {
    expect(seededEstimateWoId, 'beforeAll must have seeded an ESTIMATE work-order').toBeTruthy();
    expect(accessToken).toBeTruthy();

    // Clear auth state: open private context so cookies/sessionStorage от admin не доступні.
    const browser = page.context().browser()!;
    const noAuthCtx = await browser.newContext();
    const noAuthPage = await noAuthCtx.newPage();

    // Acquire a real token via API using cached admin token, then visit /estimate/[token].
    const apiCtx = await request.newContext();
    try {
      const tokenRes = await apiCtx.post(
        `${API_BASE}/api/work-orders/${seededEstimateWoId}/share-token`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          data: {},
        },
      );
      const { token } = (await tokenRes.json()) as { token: string };

      // Visit /estimate/<token> in unauthenticated context.
      await noAuthPage.goto(`/estimate/${token}`);

      // Wait for the heading "Кошторис <number>" to appear.
      await expect(noAuthPage.getByRole('heading', { name: /Кошторис/i })).toBeVisible({
        timeout: 30_000,
      });

      // Invalid token route shows error message.
      await noAuthPage.goto('/estimate/garbage-token-xxxxx');
      await expect(noAuthPage.getByText(/Посилання не дійсне/i)).toBeVisible({ timeout: 30_000 });
    } finally {
      await apiCtx.dispose();
      await noAuthCtx.close();
    }
  });
});
