import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Міряє тривалість HTTP-запитів у гістограму.
 *
 * `route`, а НЕ `request.url`: шлях містить UUID-и (`/work-orders/<uuid>`), і мітка за
 * сирим URL дала б тисячі унікальних серій — класичний cardinality explosion, який
 * з'їдає пам'ять процесу. Беремо шаблон маршруту Fastify (`/api/v1/work-orders/:id`).
 *
 * `tap` із обома гілками: без error-гілки запити, що впали, не потрапляли б у метрики —
 * а саме вони найцікавіші при скарзі «гальмує/падає».
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & { routeOptions?: { url?: string } }>();
    const res = http.getResponse<FastifyReply>();
    const started = process.hrtime.bigint();

    const observe = (status: number): void => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.httpDuration.observe(
        {
          method: req.method,
          // routeOptions.url — шаблон («/api/v1/goods/:id»); fallback «unknown» краще за
          // сирий URL: невідомий маршрут не повинен плодити серії.
          route: req.routeOptions?.url ?? 'unknown',
          status: String(status),
        },
        seconds,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => observe(res.statusCode),
        error: (err: { status?: number; statusCode?: number }) =>
          observe(err?.status ?? err?.statusCode ?? 500),
      }),
    );
  }
}
