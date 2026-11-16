import { metrics } from '@opentelemetry/api';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, finalize } from 'rxjs';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly meter = metrics.getMeter('gen-ai-ingest');
  private readonly requestCount = this.meter.createCounter('http.server.request.count', {
    unit: '{request}',
  });
  private readonly requestDuration = this.meter.createHistogram('http.server.request.duration', {
    unit: 's',
  });

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();
    const route = request.route?.path ?? 'unmatched';

    return next.handle().pipe(
      finalize(() => {
        const attributes = {
          'http.request.method': request.method,
          'http.route': route,
          'http.response.status_code': response.statusCode,
        };
        this.requestCount.add(1, attributes);
        this.requestDuration.record((performance.now() - startedAt) / 1000, attributes);
      }),
    );
  }
}