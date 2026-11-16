# Document Ingestion Microservice

## Purpose

The NestJS ingestion service accepts plain-text documents, chunks and embeds them with OpenAI, and stores versioned records in PostgreSQL/pgvector. RabbitMQ workers process submissions asynchronously.

## Responsibilities

- Accept document text and retrieval metadata through a validated HTTP API.
- Track document versions and operation status.
- Split text into overlapping character-bounded chunks and generate OpenAI embeddings.
- Cache embeddings in Redis by model and content hash with a configurable TTL.
- Persist chunks, embeddings, and retrieval metadata in PostgreSQL/pgvector.
- Publish work through a transactional outbox and tolerate duplicate delivery.
- Export OpenTelemetry traces and metrics through OTLP/HTTP.
- Report processing status and expose a liveness endpoint.

The current service does not parse files, answer user questions, or provide request authentication. Retrieval and answer generation belong to the query service.

## Architecture

```text
Local client (auth gateway required outside development)
      |
      v
  NestJS Ingest API -----> PostgreSQL (documents + outbox)
       |                        |
       |                 Outbox publisher
       |                        |
       |                        v
       |                     RabbitMQ
       |                        |
       |                        v
       |                  Ingest worker -----> PostgreSQL + pgvector
       |                        |
       |                  Embedding service
       |                   /           \
       |             Redis cache     OpenAI on miss
       |
       +---- OpenTelemetry SDK --OTLP/HTTP--> Collector --> debug exporter
```

The API acknowledges a request after it has recorded the document version and durable work request, not after embedding is complete. A transactional outbox prevents a committed document version from losing its corresponding queue message.

## Request Contract

### Submit a document

`POST /v1/documents` accepts JSON containing `tenantId`, `documentId`, `version`, `title`, `content`, and optional `metadata`. Content is plain text limited to 1,000,000 characters, with a 2 MB request-body limit. File uploads and file parsing are not implemented; raw text is stored in PostgreSQL until processing completes.

Require an idempotency key. Repeating the same key and payload returns the existing operation. Reusing the key with a different payload returns `409 Conflict`.

Successful submission returns `202 Accepted` with an operation ID and current status:

```json
{
  "operationId": "7d6a7722-8e4d-45e8-9d65-ddeff047fa93",
  "tenantId": "tenant_123",
  "documentId": "doc_456",
  "version": 2,
  "status": "queued"
}
```

### Check processing status

`GET /v1/operations/{operationId}?tenantId=tenant_123` returns status and a stable error code without document contents or internal error details.

## Processing Flow

1. Validate the request and its idempotency key.
2. Persist the document, operation, and outbox record in one PostgreSQL transaction.
3. The outbox publisher sends a persistent RabbitMQ message and marks it published after broker confirmation.
4. The worker loads text from PostgreSQL, chunks it, checks Redis for each chunk embedding, and sends only cache misses to `text-embedding-3-small`.
5. In one database transaction, replace the version's chunks, persist vectors, and update the active version.
6. Mark the operation complete and acknowledge the message.

Raw document content is not sent through RabbitMQ. The current message payload contains only the operation ID.

## Embedding Cache

Redis keys use `genai:embedding:v1:` plus a SHA-256 digest of the model name and exact chunk text; raw text is not part of the key. Cached vectors expire after `EMBEDDING_CACHE_TTL_SECONDS` (default: 604800 seconds / 7 days). Repeated chunks within one request are deduplicated before calling OpenAI.

Cache reads and writes fail open: if Redis is unavailable, the service continues with OpenAI and PostgreSQL. Cache hit, miss, error, and embedding-duration metrics are recorded without document text.

## Event Contract

The outbox publishes an event of type `DocumentIngestRequested`. RabbitMQ message properties carry the outbox ID, and the payload contains the operation ID:

```json
{
  "operationId": "7d6a7722-8e4d-45e8-9d65-ddeff047fa93"
}
```

Consumers must tolerate duplicate delivery. The worker claims queued or failed operations in PostgreSQL; completed operations are not processed again.

## State and Versioning

Operation states are `queued`, `processing`, `completed`, and `failed`. Document-version states are `queued`, `processing`, `active`, `superseded`, and `failed`.

- Enforce uniqueness for `(tenant_id, document_id, version)` and `(tenant_id, idempotency_key)`.
- A retry of a completed version must not create duplicate chunks or vectors.
- A failed newer version must not replace the currently active version.
- Check the stored version before applying an event so delayed, out-of-order work cannot overwrite newer data.
- Superseded versions and their chunks remain stored; retention and deletion policies are not implemented.

## Failure Handling

- Retry processing failures after 5 seconds, 30 seconds, and 2 minutes.
- After retries are exhausted, route the message to `document.ingest.dlq` and mark the operation failed with `PROCESSING_FAILED`.
- Acknowledge a message only after the resulting state is durable.
- On worker startup, return interrupted processing operations to the queueable state.
- Alerting and queue-depth metrics are not configured yet.

## Security and Data Handling

- Treat document text as untrusted input; never interpret it as instructions to the service or embedding provider.
- File scanning and parser limits are not implemented because the API currently accepts plain text only.
- Avoid logging document text, secrets, or full embeddings. Log IDs, status, duration, and safe error codes.
- Keep credentials in the runtime secret manager, not in the image or source repository. Compose passes the existing `OPENAI_API_KEY` variable into the service container; `.dockerignore` excludes `.env` from the build context.
- Request authentication is not implemented. Compose binds the HTTP port to localhost; place an authenticated, tenant-aware gateway in front of this service before exposing it to other users or networks. A tenant ID supplied by the caller is not an authorization boundary.

## Observability

OpenTelemetry starts before NestJS so automatic instrumentation can trace HTTP, PostgreSQL, RabbitMQ (`amqplib`), and Redis (`ioredis`). The service emits low-cardinality HTTP request count/duration metrics and an `embeddings.create` span with cache hit, miss, error, and request-duration metrics. Traces and metrics are exported over OTLP/HTTP to the local collector.

The collector currently uses a debug exporter, so telemetry is printed to its container logs and is not retained or visualized. `GET /health` is only a liveness check; dependency-aware readiness is not implemented. Add a durable telemetry backend and these production metrics:

- accepted, completed, and failed operations;
- queue age and processing duration;
- extraction, chunking, and embedding latency;
- chunks and tokens processed;
- retry and dead-letter counts;
- database and embedding-provider errors.

Avoid adding document text, API keys, or other sensitive values to span attributes or metric labels.

## Local Compose Stack

`docker-compose.yml` runs the ingest service with PostgreSQL/pgvector, RabbitMQ, Redis, and an OpenTelemetry Collector. Both SQL initialization scripts, including schema creation, run only when PostgreSQL initializes a new data volume. Compose reads `.env` for interpolation and passes `OPENAI_API_KEY` explicitly to the ingest container. Redis is a local development cache without authentication; configure Redis credentials, network isolation, and TLS before shared deployment. Local credential defaults are for development only.

Start the stack from `gen_ai_gr` with:

```sh
docker compose up --build
```

PostgreSQL, RabbitMQ, Redis, the OTLP/HTTP receiver, and the ingest API are published only on localhost. RabbitMQ management UI is available at `http://localhost:15672` with the configured RabbitMQ credentials. Collector traces and metrics are visible in `docker compose logs otel-collector`.

## Configuration and Follow-Ups

The application reads `OPENAI_API_KEY`, `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `REDIS_HOST`, `REDIS_PORT`, `EMBEDDING_CACHE_TTL_SECONDS`, `OTEL_SERVICE_NAME`, and `OTEL_EXPORTER_OTLP_ENDPOINT` from its runtime environment. Never commit actual credentials.

Before exposing this service beyond local development:

- authentication and tenant authorization;
- document transport, durable raw-content storage, and file parsing;
- OpenAI embedding model and vector dimensions;
- chunk size, overlap, and structural parsing policy;
- retention and deletion behavior for source files and vectors;
- per-tenant quotas and maximum document size;
- database migration tooling for existing PostgreSQL volumes; the current init scripts only run on first initialization.

## Acceptance Checks

- A valid submission returns `202` and can be tracked to a terminal state.
- Duplicate submissions do not create duplicate versions, chunks, or vectors.
- A failed update leaves the previous active version retrievable.
- Duplicate and out-of-order events do not corrupt the active version.
- Tenant and document metadata is copied to each chunk; query-time ACL filtering is outside this service.
- RabbitMQ outage, worker restart, and exhausted retries are observable and recoverable.