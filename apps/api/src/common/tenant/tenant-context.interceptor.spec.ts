import { describe, it, expect } from 'vitest';
import { firstValueFrom, of } from 'rxjs';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { getTenantOrgId, isTenantBypassed, runUnscoped } from './tenant-context';

/**
 * A1 — доводимо, що interceptor входить у tenant-scope на час обробки handler-а:
 *  - усередині CallHandler (= handler+service ланцюг) `getTenantOrgId()` === request.user.orgId;
 *  - на public/unauth-роуті (user відсутній) orgId === undefined (не throw — guard вирішує далі);
 *  - поза scope (після/до) ALS порожній.
 */

function makeCtx(user?: { orgId?: string }) {
  const req = { user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  it('усередині handler-а orgId зі scope === request.user.orgId', async () => {
    let seenOrgId: string | undefined = 'NOT-SET';
    let seenBypass = true;
    const next = {
      handle: () => {
        seenOrgId = getTenantOrgId();
        seenBypass = isTenantBypassed();
        return of('ok');
      },
    };

    const result = await firstValueFrom(interceptor.intercept(makeCtx({ orgId: 'org-42' }), next));

    expect(result).toBe('ok');
    expect(seenOrgId).toBe('org-42');
    expect(seenBypass).toBe(false);
  });

  it('public/unauth-роут (user відсутній) → orgId undefined усередині scope', async () => {
    let seenOrgId: string | undefined = 'NOT-SET';
    const next = {
      handle: () => {
        seenOrgId = getTenantOrgId();
        return of('ok');
      },
    };

    await firstValueFrom(interceptor.intercept(makeCtx(undefined), next));

    expect(seenOrgId).toBeUndefined();
  });

  it('поза межами interceptor-а ALS порожній (scope не тече)', async () => {
    const next = { handle: () => of('ok') };
    await firstValueFrom(interceptor.intercept(makeCtx({ orgId: 'org-1' }), next));

    expect(getTenantOrgId()).toBeUndefined();
  });

  it('runUnscoped усередині scope вмикає bypass, зберігаючи orgId', async () => {
    let seenOrgId: string | undefined;
    let seenBypass = false;
    const next = {
      handle: () =>
        runUnscoped(() => {
          seenOrgId = getTenantOrgId();
          seenBypass = isTenantBypassed();
          return of('ok');
        }),
    };

    await firstValueFrom(interceptor.intercept(makeCtx({ orgId: 'org-7' }), next));

    expect(seenBypass).toBe(true);
    expect(seenOrgId).toBe('org-7');
  });
});
