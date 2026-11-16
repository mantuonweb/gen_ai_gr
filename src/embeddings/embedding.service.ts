import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingCacheService } from '../cache/embedding-cache.service';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly meter = metrics.getMeter('gen-ai-ingest');
  private readonly cacheHits = this.meter.createCounter('embedding_cache_hits');
  private readonly cacheMisses = this.meter.createCounter('embedding_cache_misses');
  private readonly cacheErrors = this.meter.createCounter('embedding_cache_errors');
  private readonly requestDuration = this.meter.createHistogram('embedding_request_duration_ms');
  private readonly tracer = trace.getTracer('gen-ai-ingest');

  constructor(
    private readonly cache: EmbeddingCacheService,
    private readonly provider: OpenAiEmbeddingProvider,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    return this.tracer.startActiveSpan('embeddings.create', async (span) => {
      const startedAt = performance.now();
      span.setAttribute('gen_ai.request.model', this.provider.model);
      span.setAttribute('embedding.input_count', texts.length);

      try {
        const groupedInputs = new Map<string, number[]>();
        texts.forEach((text, index) => {
          const indexes = groupedInputs.get(text) ?? [];
          indexes.push(index);
          groupedInputs.set(text, indexes);
        });

        const uniqueTexts = [...groupedInputs.keys()];
        const cached: Array<number[] | undefined> = new Array(uniqueTexts.length).fill(undefined);
        try {
          const cacheResults = await this.cache.getMany(this.provider.model, uniqueTexts);
          cacheResults.forEach((embedding, index) => {
            if (this.isValidEmbedding(embedding)) cached[index] = embedding;
          });
        } catch {
          this.cacheErrors.add(1, { model: this.provider.model });
          span.addEvent('embedding.cache.read_error');
          this.logger.warn('Redis embedding cache read failed; using OpenAI directly');
        }

        const result: Array<number[] | undefined> = new Array(texts.length).fill(undefined);
        const missingTexts: string[] = [];
        const missingIndexes: number[][] = [];

        uniqueTexts.forEach((text, index) => {
          const originalIndexes = groupedInputs.get(text) ?? [];
          if (cached[index]) {
            this.cacheHits.add(1, { model: this.provider.model });
            originalIndexes.forEach((originalIndex) => {
              result[originalIndex] = cached[index];
            });
          } else {
            this.cacheMisses.add(1, { model: this.provider.model });
            missingTexts.push(text);
            missingIndexes.push(originalIndexes);
          }
        });

        if (missingTexts.length) {
          const generated = await this.provider.embed(missingTexts);
          if (
            generated.length !== missingTexts.length ||
            generated.some((embedding) => !this.isValidEmbedding(embedding))
          ) {
            throw new Error('Embedding provider returned an unexpected response shape');
          }

          generated.forEach((embedding, index) => {
            missingIndexes[index].forEach((originalIndex) => {
              result[originalIndex] = embedding;
            });
          });

          try {
            await this.cache.setMany(this.provider.model, missingTexts, generated);
          } catch {
            this.cacheErrors.add(1, { model: this.provider.model });
            span.addEvent('embedding.cache.write_error');
            this.logger.warn('Redis embedding cache write failed');
          }
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result as number[][];
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        this.requestDuration.record(performance.now() - startedAt, {
          model: this.provider.model,
        });
        span.end();
      }
    });
  }

  private isValidEmbedding(value: number[] | undefined): value is number[] {
    return (
      Array.isArray(value) &&
      value.length === 1536 &&
      value.every((component) => Number.isFinite(component))
    );
  }
}