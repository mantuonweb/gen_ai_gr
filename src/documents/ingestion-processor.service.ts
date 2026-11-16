import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EmbeddingService } from '../embeddings/embedding.service';
import { splitTextIntoChunks } from './chunking';

interface ProcessingRecord {
  id: string;
  tenant_id: string;
  document_id: string;
  version: number;
  title: string;
  source_text: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class IngestionProcessorService {
  private readonly logger = new Logger(IngestionProcessorService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly embeddings: EmbeddingService,
  ) {}

  async recoverInterruptedOperations(): Promise<void> {
    await this.database.query(
      `WITH interrupted AS (
         UPDATE ingest_operations
            SET status = 'queued', updated_at = now()
          WHERE status = 'processing'
          RETURNING tenant_id, document_id, version
       )
       UPDATE documents d
          SET status = 'queued', updated_at = now()
         FROM interrupted i
        WHERE d.tenant_id = i.tenant_id
          AND d.document_id = i.document_id
          AND d.version = i.version
          AND d.is_active = false`,
    );
  }

  async processOperation(operationId: string): Promise<void> {
    const claim = await this.database.query<ProcessingRecord>(
      `WITH claimed AS (
         UPDATE ingest_operations
            SET status = 'processing', error_code = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'failed')
          RETURNING id, tenant_id, document_id, version
       )
       SELECT c.id, c.tenant_id, c.document_id, c.version,
              d.title, d.source_text, d.metadata
         FROM claimed c
         JOIN documents d
           ON d.tenant_id = c.tenant_id
          AND d.document_id = c.document_id
          AND d.version = c.version`,
      [operationId],
    );
    if (!claim.rowCount) return;

    const record = claim.rows[0];
    await this.database.query(
      `UPDATE documents
          SET status = 'processing', updated_at = now()
        WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND is_active = false`,
      [record.tenant_id, record.document_id, record.version],
    );

    try {
      const chunks = splitTextIntoChunks(record.source_text);
      if (!chunks.length) throw new Error('Document has no extractable text');

      const vectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += 64) {
        vectors.push(...(await this.embeddings.embed(chunks.slice(offset, offset + 64))));
      }
      if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== 1536)) {
        throw new Error('Embedding response has an unexpected shape');
      }

      await this.database.transaction(async (client) => {
        await client.query(
          `DELETE FROM document_chunks
            WHERE tenant_id = $1 AND document_id = $2 AND document_version = $3`,
          [record.tenant_id, record.document_id, record.version],
        );

        for (let index = 0; index < chunks.length; index += 1) {
          const metadata = {
            ...record.metadata,
            tenantId: record.tenant_id,
            documentId: record.document_id,
            version: record.version,
            title: record.title,
            chunkIndex: index,
          };
          await client.query(
            `INSERT INTO document_chunks
               (tenant_id, document_id, document_version, chunk_index, content, metadata, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [
              record.tenant_id,
              record.document_id,
              record.version,
              index,
              chunks[index],
              metadata,
              `[${vectors[index].join(',')}]`,
            ],
          );
        }

        const newerActiveVersion = await client.query(
          `SELECT 1
             FROM documents
            WHERE tenant_id = $1 AND document_id = $2
              AND is_active = true AND version > $3
            LIMIT 1`,
          [record.tenant_id, record.document_id, record.version],
        );

        if (newerActiveVersion.rowCount) {
          await client.query(
            `UPDATE documents
                SET status = 'superseded', is_active = false, updated_at = now()
              WHERE tenant_id = $1 AND document_id = $2 AND version = $3`,
            [record.tenant_id, record.document_id, record.version],
          );
        } else {
          await client.query(
            `UPDATE documents
                SET status = 'superseded', is_active = false, updated_at = now()
              WHERE tenant_id = $1 AND document_id = $2
                AND is_active = true AND version < $3`,
            [record.tenant_id, record.document_id, record.version],
          );
          await client.query(
            `UPDATE documents
                SET status = 'active', is_active = true, updated_at = now()
              WHERE tenant_id = $1 AND document_id = $2 AND version = $3`,
            [record.tenant_id, record.document_id, record.version],
          );
        }

        await client.query(
          `UPDATE ingest_operations
              SET status = 'completed', error_code = NULL, updated_at = now()
            WHERE id = $1`,
          [operationId],
        );
      });
    } catch (error) {
      await this.database.query(
        `UPDATE ingest_operations
            SET status = 'failed', error_code = 'PROCESSING_FAILED', updated_at = now()
          WHERE id = $1`,
        [operationId],
      );
      await this.database.query(
        `UPDATE documents
            SET status = 'failed', updated_at = now()
          WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND is_active = false`,
        [record.tenant_id, record.document_id, record.version],
      );
      this.logger.error(`Ingestion failed for operation ${operationId}`);
      throw error;
    }
  }

  async markFailed(operationId: string): Promise<void> {
    await this.database.query(
      `UPDATE ingest_operations
          SET status = 'failed', error_code = 'PROCESSING_FAILED', updated_at = now()
        WHERE id = $1 AND status <> 'completed'`,
      [operationId],
    );
  }
}