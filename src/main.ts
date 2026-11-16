import 'dotenv/config';
import './instrumentation';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HttpMetricsInterceptor } from './telemetry/http-metrics.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '2mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new HttpMetricsInterceptor());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();