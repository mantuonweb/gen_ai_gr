import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { EmbeddingService } from '../embeddings/embedding.service';
import { CandidateRankingService } from './candidate-ranking.service';
import { SearchDocumentsDto } from './search-documents.dto';
import { SubmitDocumentDto } from './submit-document.dto';

interface OperationRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version: number;
  request_hash: string;
  status: string;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
    private readonly candidateRanking: CandidateRankingService,
  ) {}

  async submit(dto: SubmitDocumentDto, idempotencyKey?: string) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }

    const requestHash = createHash('sha256')
      .update(this.canonicalize(dto))
      .digest('hex');
    const operationId = randomUUID();

    try {
      return await this.database.transaction(async (client) => {
        const existing = await client.query<OperationRow>(
          `SELECT id, tenant_id, document_id, version, request_hash, status,
                  error_code, created_at, updated_at
             FROM ingest_operations
            WHERE tenant_id = $1 AND idempotency_key = $2
            FOR UPDATE`,
          [dto.tenantId, idempotencyKey],
        );

        if (existing.rowCount) {
          const operation = existing.rows[0];
          if (operation.request_hash !== requestHash) {
            throw new ConflictException('Idempotency key was already used with a different request');
          }
          return this.toResponse(operation);
        }

        await client.query(
          `INSERT INTO documents
             (tenant_id, document_id, version, title, status)
           VALUES ($1, $2, $3, $4, 'queued')`,
          [
            dto.tenantId,
            dto.documentId,
            dto.version,
            dto.title,
          ],
        );

        await client.query(
          `INSERT INTO resume_details
             (tenant_id, document_id, version, resume_text, candidate_details)
           VALUES ($1, $2, $3, $4, $5)`,
          [dto.tenantId, dto.documentId, dto.version, dto.content, dto.metadata ?? {}],
        );

        const operationResult = await client.query<OperationRow>(
          `INSERT INTO ingest_operations
             (id, tenant_id, document_id, version, idempotency_key, request_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued')
           RETURNING id, tenant_id, document_id, version, request_hash, status,
                     error_code, created_at, updated_at`,
          [operationId, dto.tenantId, dto.documentId, dto.version, idempotencyKey, requestHash],
        );

        await client.query(
          `INSERT INTO outbox_events (event_type, payload)
           VALUES ('DocumentIngestRequested', $1)`,
          [{ operationId }],
        );

        return this.toResponse(operationResult.rows[0]);
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException('Document version or idempotency key already exists');
      }
      throw error;
    }
  }

  async getOperation(operationId: string, tenantId: string) {
    if (!tenantId?.trim()) throw new BadRequestException('tenantId query parameter is required');

    const result = await this.database.query<OperationRow>(
      `SELECT id, tenant_id, document_id, version, request_hash, status,
              error_code, created_at, updated_at
         FROM ingest_operations
        WHERE id = $1 AND tenant_id = $2`,
      [operationId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundException('Operation not found');
    return this.toResponse(result.rows[0]);
  }

  async getDocument(documentId: string, tenantId: string) {
    if (!tenantId?.trim()) throw new BadRequestException('tenantId query parameter is required');

    const result = await this.database.query<{
      document_id: string;
      version: number;
      title: string;
      resume_text: string;
      candidate_details: Record<string, unknown>;
    }>(
      `SELECT d.document_id, d.version, d.title, rd.resume_text, rd.candidate_details
         FROM documents d
         JOIN resume_details rd
           ON rd.tenant_id = d.tenant_id
          AND rd.document_id = d.document_id
          AND rd.version = d.version
        WHERE d.tenant_id = $1 AND d.document_id = $2 AND d.is_active = true`,
      [tenantId, documentId],
    );
    if (!result.rowCount) throw new NotFoundException('Resume not found');

    const document = result.rows[0];
    return {
      documentId: document.document_id,
      version: document.version,
      title: document.title,
      content: document.resume_text,
      metadata: document.candidate_details,
    };
  }

  async search(query: SearchDocumentsDto) {
    const [embedding] = await this.embeddings.embed([query.query]);
    const limit = query.limit ?? 5;
    const shortlistLimit = Math.max(limit, 20);
    const result = await this.database.query<{
      document_id: string;
      document_version: number;
      title: string;
      content: string;
      metadata: Record<string, unknown>;
      score: number;
    }>(
      `WITH ranked_chunks AS (
          SELECT c.document_id, c.document_version, d.title, c.content,
            rd.candidate_details AS metadata,
                1 - (c.embedding <=> $1::vector) AS score,
                ROW_NUMBER() OVER (
                  PARTITION BY c.tenant_id, c.document_id, c.document_version
                  ORDER BY c.embedding <=> $1::vector
                ) AS resume_rank
           FROM document_chunks c
           JOIN documents d
             ON d.tenant_id = c.tenant_id
            AND d.document_id = c.document_id
            AND d.version = c.document_version
           JOIN resume_details rd
             ON rd.tenant_id = d.tenant_id
            AND rd.document_id = d.document_id
            AND rd.version = d.version
          WHERE c.tenant_id = $2 AND d.is_active = true
       )
       SELECT document_id, document_version, title, content, metadata, score
         FROM ranked_chunks
        WHERE resume_rank = 1
        ORDER BY score DESC
        LIMIT $3`,
      [`[${embedding.join(',')}]`, query.tenantId, shortlistLimit],
    );
    const ranked = await this.candidateRanking.rank(query.query, result.rows.map((row) => ({
      documentId: row.document_id,
      version: row.document_version,
      title: row.title,
      content: row.content,
      metadata: row.metadata,
      score: Number(row.score),
    })));

    return {
      query: query.query,
      rankingMethod: ranked.method,
      results: ranked.results.slice(0, limit),
    };
  }

  private toResponse(operation: OperationRow) {
    return {
      operationId: operation.id,
      tenantId: operation.tenant_id,
      documentId: operation.document_id,
      version: operation.version,
      status: operation.status,
      errorCode: operation.error_code,
      createdAt: operation.created_at,
      updatedAt: operation.updated_at,
    };
  }

  private canonicalize(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalize(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${this.canonicalize(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }
}