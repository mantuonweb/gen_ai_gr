import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';

@Injectable()
export class OpenAiEmbeddingProvider {
  readonly model = 'text-embedding-3-small';
  private readonly client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required');
    this.client = new OpenAI({ apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const response = await this.client.embeddings.create({ model: this.model, input: texts });
    return response.data
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }
}