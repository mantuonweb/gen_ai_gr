CREATE TABLE IF NOT EXISTS documents (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  source_text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'active', 'superseded', 'failed')),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_one_active_version_idx
  ON documents (tenant_id, document_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS ingest_operations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES documents (tenant_id, document_id, version)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS document_chunks (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  document_version integer NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_id, document_version, chunk_index),
  FOREIGN KEY (tenant_id, document_id, document_version)
    REFERENCES documents (tenant_id, document_id, version)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS document_chunks_tenant_document_idx
  ON document_chunks (tenant_id, document_id, document_version);