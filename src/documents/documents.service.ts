import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { EmbeddingService } from '../embeddings/embedding.service';
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
             (tenant_id, document_id, version, title, source_text, metadata, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'queued')`,
          [
            dto.tenantId,
            dto.documentId,
            dto.version,
            dto.title,
            dto.content,
            dto.metadata ?? {},
          ],
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

  async search(query: SearchDocumentsDto) {
    const [embedding] = await this.embeddings.embed([query.query]);
    const limit = query.limit ?? 5;
    const result = await this.database.query<{
      document_id: string;
      document_version: number;
      title: string;
      content: string;
      metadata: Record<string, unknown>;
      score: number;
    }>(
      `SELECT c.document_id, c.document_version, d.title, c.content, c.metadata,
              1 - (c.embedding <=> $1::vector) AS score
         FROM document_chunks c
         JOIN documents d
           ON d.tenant_id = c.tenant_id
          AND d.document_id = c.document_id
          AND d.version = c.document_version
        WHERE c.tenant_id = $2 AND d.is_active = true
        ORDER BY c.embedding <=> $1::vector
        LIMIT $3`,
      [`[${embedding.join(',')}]`, query.tenantId, limit],
    );

    return {
      query: query.query,
      results: result.rows.map((row) => ({
        documentId: row.document_id,
        version: row.document_version,
        title: row.title,
        content: row.content,
        metadata: row.metadata,
        score: Number(row.score),
      })),
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