import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { runWithTenant } from './tenant-context';

/**
 * Глобальний interceptor, що входить у tenant-scope (AsyncLocalStorage) на весь час обробки запиту
 * (A1 — tenant-isolation guard).
 *
 * ЧОМУ interceptor, а не middleware/guard:
 *  - middleware виконується ДО guards → `request.user` (populate-иться JwtAuthGuard/passport) ще не готовий;
 *  - guard повертає boolean і не може ОБГОРНУТИ подальший handler у `als.run`;
 *  - лише interceptor отримує `next.handle()` (Observable усього ланцюга handler+service+prisma) і може
 *    обгорнути його підписку в `runWithTenant`. Global interceptor фаєрить ПІСЛЯ global guards, тож
 *    `request.user.orgId` вже наявний для авторизованих роутів.
 *
 * Public/unauth-роути (login, health, share-token, setup) → `orgId=undefined`; guard тоді кине для
 * tenant-моделей, ПОКИ конкретний легітимний глобальний запит не обгорнуто у `runUnscoped`.
 *
 * ALS входимо СИНХРОННО навколо `next.handle().subscribe(...)` (не через `.pipe`), щоб store був
 * активний на момент підписки й лишався активним крізь усі awaited-продовження async-handler-а.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: { orgId?: string } }>();
    const orgId = req?.user?.orgId;

    return new Observable(subscriber => {
      return runWithTenant({ orgId }, () => next.handle().subscribe(subscriber));
    });
  }
}
