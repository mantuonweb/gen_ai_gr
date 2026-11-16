import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME ?? 'gen-ai-ingest-service',
    'service.version': process.env.npm_package_version ?? '1.0.0',
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation(),
    new AmqplibInstrumentation(),
    new IORedisInstrumentation(),
  ],
  ...(endpoint
    ? {
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          exportIntervalMillis: 10000,
        }),
      }
    : {}),
});

sdk.start();

const shutdownTelemetry = (): void => {
  void sdk.shutdown();
};

process.once('SIGTERM', shutdownTelemetry);
process.once('SIGINT', shutdownTelemetry);