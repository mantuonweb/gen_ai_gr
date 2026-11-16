import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

@Injectable()
export class EmbeddingCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingCacheService.name);
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private lastConnectionWarning = 0;

  constructor() {
    const configuredTtl = Number(process.env.EMBEDDING_CACHE_TTL_SECONDS ?? 604800);
    this.ttlSeconds = Number.isSafeInteger(configuredTtl) && configuredTtl > 0
      ? configuredTtl
      : 604800;
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      retryStrategy: (attempt) => (attempt > 3 ? null : attempt * 200),
    });
    this.redis.on('error', () => this.logConnectionWarning());
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch {
      this.logConnectionWarning();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  async getMany(model: string, texts: string[]): Promise<Array<number[] | undefined>> {
    if (!texts.length) return [];
    await this.ensureConnected();
    const values = await this.redis.mget(...texts.map((text) => this.key(model, text)));
    return values.map((value) => this.parseEmbedding(value));
  }

  async setMany(model: string, texts: string[], embeddings: number[][]): Promise<void> {
    if (texts.length !== embeddings.length) throw new Error('Cache input/output count mismatch');
    if (!texts.length) return;

    await this.ensureConnected();
    const pipeline = this.redis.pipeline();
    texts.forEach((text, index) => {
      pipeline.set(
        this.key(model, text),
        JSON.stringify(embeddings[index]),
        'EX',
        this.ttlSeconds,
      );
    });
    const results = await pipeline.exec();
    const failure = results?.find((result) => result?.[0]);
    if (failure?.[0]) throw failure[0];
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
    }
  }

  private key(model: string, text: string): string {
    const digest = createHash('sha256').update(model).update('\0').update(text).digest('hex');
    return `genai:embedding:v1:${digest}`;
  }

  private parseEmbedding(value: string | null): number[] | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        Array.isArray(parsed) &&
        parsed.length === 1536 &&
        parsed.every((component) => typeof component === 'number' && Number.isFinite(component))
      ) {
        return parsed;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private logConnectionWarning(): void {
    const now = Date.now();
    if (now - this.lastConnectionWarning < 30000) return;
    this.lastConnectionWarning = now;
    this.logger.warn('Redis embedding cache is unavailable; embedding requests will bypass cache');
  }
}