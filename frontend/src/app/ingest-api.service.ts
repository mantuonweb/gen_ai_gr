import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface SubmitDocument {
  tenantId: string;
  documentId: string;
  version: number;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IngestOperation {
  operationId: string;
  tenantId: string;
  documentId: string;
  version: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  errorCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  documentId: string;
  version: number;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

@Injectable({ providedIn: 'root' })
export class IngestApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api';

  health(): Observable<{ status: string }> {
    return this.http.get<{ status: string }>(`${this.baseUrl}/health`);
  }

  submit(document: SubmitDocument, idempotencyKey: string): Observable<IngestOperation> {
    return this.http.post<IngestOperation>(`${this.baseUrl}/v1/documents`, document, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  upload(document: SubmitDocument, file: File, idempotencyKey: string): Observable<IngestOperation> {
    const formData = new FormData();
    formData.set('file', file);
    formData.set('tenantId', document.tenantId);
    formData.set('documentId', document.documentId);
    formData.set('version', String(document.version));
    formData.set('title', document.title || file.name);
    if (document.metadata) formData.set('metadata', JSON.stringify(document.metadata));

    return this.http.post<IngestOperation>(`${this.baseUrl}/v1/documents/upload`, formData, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  search(tenantId: string, query: string, limit = 5): Observable<{ query: string; results: SearchResult[] }> {
    const params = new URLSearchParams({ tenantId, query, limit: String(limit) });
    return this.http.get<{ query: string; results: SearchResult[] }>(
      `${this.baseUrl}/v1/documents/search?${params.toString()}`,
    );
  }

  getOperation(operationId: string, tenantId: string): Observable<IngestOperation> {
    const query = new URLSearchParams({ tenantId });
    return this.http.get<IngestOperation>(
      `${this.baseUrl}/v1/operations/${encodeURIComponent(operationId)}?${query.toString()}`,
    );
  }
}