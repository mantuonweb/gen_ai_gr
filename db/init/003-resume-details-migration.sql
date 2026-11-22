CREATE TABLE IF NOT EXISTS resume_details (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version integer NOT NULL,
  resume_text text NOT NULL,
  candidate_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id, version),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES documents (tenant_id, document_id, version)
    ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'documents' AND column_name = 'source_text'
  ) THEN
    EXECUTE $backfill$
      INSERT INTO resume_details (tenant_id, document_id, version, resume_text, candidate_details)
      SELECT tenant_id, document_id, version, source_text,
             COALESCE(metadata, '{}'::jsonb)
        FROM documents
      ON CONFLICT (tenant_id, document_id, version) DO NOTHING
    $backfill$;
    ALTER TABLE documents DROP COLUMN source_text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'documents' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE documents DROP COLUMN metadata;
  END IF;
END $$;