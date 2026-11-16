import { EmbeddingCacheService } from '../cache/embedding-cache.service';
import { EmbeddingService } from './embedding.service';
import { OpenAiEmbeddingProvider } from './openai-embedding.provider';

describe('EmbeddingService', () => {
  const vector = Array.from({ length: 1536 }, (_, index) => index / 1536);

  it('uses cached vectors and only embeds cache misses', async () => {
    const values = new Map<string, number[]>();
    const cache = {
      getMany: jest.fn(async (_model: string, texts: string[]) => texts.map((text) => values.get(text))),
      setMany: jest.fn(async (_model: string, texts: string[], vectors: number[][]) => {
        texts.forEach((text, index) => values.set(text, vectors[index]));
      }),
    };
    const provider = { model: 'text-embedding-3-small', embed: jest.fn(async () => [vector]) };
    const service = new EmbeddingService(
      cache as unknown as EmbeddingCacheService,
      provider as unknown as OpenAiEmbeddingProvider,
    );

    const first = await service.embed(['same text']);
    const second = await service.embed(['same text']);

    expect(first).toEqual([vector]);
    expect(second).toEqual([vector]);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it('continues with the provider when Redis is unavailable', async () => {
    const cache = {
      getMany: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
      setMany: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };
    const provider = { model: 'text-embedding-3-small', embed: jest.fn(async () => [vector]) };
    const service = new EmbeddingService(
      cache as unknown as EmbeddingCacheService,
      provider as unknown as OpenAiEmbeddingProvider,
    );

    await expect(service.embed(['uncached text'])).resolves.toEqual([vector]);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated inputs within a batch', async () => {
    const cache = {
      getMany: jest.fn(async (_model: string, texts: string[]) => texts.map(() => undefined)),
      setMany: jest.fn().mockResolvedValue(undefined),
    };
    const provider = { model: 'text-embedding-3-small', embed: jest.fn(async () => [vector]) };
    const service = new EmbeddingService(
      cache as unknown as EmbeddingCacheService,
      provider as unknown as OpenAiEmbeddingProvider,
    );

    await expect(service.embed(['repeat', 'repeat'])).resolves.toEqual([vector, vector]);
    expect(provider.embed).toHaveBeenCalledWith(['repeat']);
  });
});