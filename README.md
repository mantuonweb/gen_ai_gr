# Generative AI Ingest Service

A NestJS document-ingestion microservice with an Angular operations console, PostgreSQL/pgvector, RabbitMQ, Redis embedding caching, OpenAI embeddings, and OpenTelemetry.

## Prerequisites

- Docker Desktop with the Compose plugin
- An OpenAI API key set as `OPENAI_API_KEY` in the local `.env` file

Keep `.env` local. It is excluded from Git and the Docker build context.

## Start the stack

From this directory, build and start all services in the background:

```sh
docker compose up -d --build
```

For subsequent starts, use `docker compose up -d`. Check service health with:

```sh
docker compose ps
curl http://localhost:3000/health
```

The stack contains the Angular console, NestJS API/worker, PostgreSQL with pgvector, RabbitMQ, Redis, an OpenTelemetry Collector, Prometheus, Tempo, and Grafana. Data is stored in named Docker volumes. SQL initialization scripts run only when PostgreSQL initializes a new data volume.

Open the console at `http://localhost:4200`. It accepts pasted text or `.txt`, `.pdf`, `.doc`, and `.docx` files, submits them through the local frontend proxy, and polls operation status. Uploads are limited to 10 MB; extracted text is limited to 1,000,000 characters.

## Local credentials

These are development-only defaults. Compose `.env` values override them:

| Service | Username | Password / authentication | Override variables |
| --- | --- | --- | --- |
| Grafana (`http://localhost:3001`) | `admin` | local_grafana_password | `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` |
| PostgreSQL (`localhost:5432`) | `ingest` | `local_dev_password` | `POSTGRES_USER`, `POSTGRES_PASSWORD`; database: `POSTGRES_DB` (default `ingest`) |
| RabbitMQ (`localhost:5672`, management UI `:15672`) | `ingest` | `local_dev_password` | `RABBITMQ_USER`, `RABBITMQ_PASSWORD` |
| Redis (`localhost:6379`) | None | No password configured | Not configured in this local stack |
| Prometheus, Tempo, OTLP Collector, and ingest API | None | No authentication configured; ports are loopback-only | Port overrides are listed below |
| OpenAI embeddings | N/A | Your own API key is required | `OPENAI_API_KEY` |

Put `OPENAI_API_KEY` in the ignored local `.env` file. Do not paste the actual key into this README, commit it, or expose this development stack to an untrusted network. Compose may use a changed password only when a service initializes a new data volume; changing `.env` does not automatically reset credentials stored in existing PostgreSQL, RabbitMQ, Grafana, or Redis volumes.

## API

Submit plain text for asynchronous ingestion:

```sh
curl -X POST http://localhost:3000/v1/documents \
  -H 'content-type: application/json' \
  -H 'idempotency-key: example-doc-v1' \
  --data '{
    "tenantId": "example-tenant",
    "documentId": "example-doc",
    "version": 1,
    "title": "Example document",
    "content": "Text to chunk and embed.",
    "metadata": {"source": "example"}
  }'
```

The endpoint returns `202 Accepted` with an `operationId`. Check its status with:

```sh
curl 'http://localhost:3000/v1/operations/<operationId>?tenantId=example-tenant'
```

Upload a `.txt`, `.pdf`, `.doc`, or `.docx` file using multipart form data:

```sh
curl -X POST http://localhost:3000/v1/documents/upload \
  -H 'idempotency-key: example-pdf-v1' \
  -F 'file=@./example.pdf' \
  -F 'tenantId=example-tenant' \
  -F 'documentId=example-pdf' \
  -F 'version=1' \
  -F 'title=Example PDF' \
  -F 'metadata={"source":"upload"}'
```

The API validates file signatures, extracts text, then runs the same asynchronous chunking and embedding pipeline. Scanned/image-only PDFs need OCR and are not currently supported.

Search active indexed documents semantically within a tenant:

```sh
curl -G http://localhost:3000/v1/documents/search \
  --data-urlencode 'tenantId=example-tenant' \
  --data-urlencode 'query=How do I submit a reimbursement?' \
  --data-urlencode 'limit=5'
```

Search embeds the query using OpenAI (or returns the cached query embedding) and returns ranked matching chunks. Each search can incur embedding usage when the query is not cached.

Submitting a valid document calls the OpenAI embeddings API and may incur usage charges. The example request is illustrative; it is not run automatically.

## Cache and telemetry

Embeddings are cached in Redis by model and a SHA-256 hash of the chunk text. The default TTL is 7 days and can be changed with `EMBEDDING_CACHE_TTL_SECONDS`. Redis failures bypass the cache and continue through OpenAI.

OpenTelemetry exports traces and metrics over OTLP/HTTP to the collector. Traces are stored in Tempo and metrics are scraped by Prometheus. Grafana is provisioned with both datasources and an **Ingest Service Overview** dashboard. Open `http://localhost:3001` with the local credentials `admin` / `local_grafana_password` (override with `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` in `.env`). Change the default password before using the stack beyond local development.

Useful telemetry links:

```sh
http://localhost:3001/d/ingest-service-overview/ingest-service-overview
http://localhost:9090
docker compose logs -f otel-collector
```

Useful service logs:

```sh
docker compose logs -f ingest
```

## Local ports

- Ingest API: `http://localhost:3000`
- Angular console: `http://localhost:4200`
- Grafana dashboards: `http://localhost:3001`
- Prometheus: `http://localhost:9090`
- Tempo query API: `http://localhost:3200`
- PostgreSQL: `localhost:5432`
- RabbitMQ AMQP: `localhost:5672`
- RabbitMQ management UI: `http://localhost:15672`
- Redis: `localhost:6379`
- OTLP/HTTP receiver: `localhost:4318`

Ports are bound to loopback. The API does not implement authentication; do not expose this stack to other users or networks without an authenticated, tenant-aware gateway. Local default database, RabbitMQ, and Grafana credentials are for development only.

## Stop

Stop containers while preserving named-volume data:

```sh
docker compose down
```