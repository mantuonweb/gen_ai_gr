# Resume Search Application Flow

## Algorithm 1: Ingest Resume

**Input:** Resume PDF and candidate profile details.

1. Receive the PDF and profile fields through the NestJS upload API.
2. Extract readable text from the PDF.
3. Store the full resume text and candidate details in `resume_details`.
4. Create an ingestion operation and an outbox event.
5. The ingestion worker reads the resume text and splits it into chunks.
6. For each chunk, check Redis for a cached embedding.
7. If an embedding is missing, request it from OpenAI and cache it in Redis.
8. Store chunks and embeddings in PostgreSQL with pgvector.
9. Mark the processed resume version active for search.

**Output:** An active resume with searchable vector chunks and separately stored full details.

## Algorithm 2: Search Candidates

**Input:** Tenant ID and a role, skills, experience, or qualification query.

1. Embed the search query, using the Redis embedding cache when available.
2. Search active resume chunks in PostgreSQL for the tenant.
3. Keep the highest-similarity chunk for each resume and form a shortlist of up to 20 candidates.
4. Build a ranking-cache key from the tenant, normalized query, candidate versions and content, and model identifiers.
5. If a valid ranking result exists in Redis, return its ranks and rationales without running Defender or the LLM calls.
6. If there is no cache hit, scan shortlisted resume excerpts locally with StackOne Defender.
7. For each allowed, fully scanned candidate, pass only sanitized text to the LLM ranking prompt.
8. Keep flagged or incompletely scanned candidates out of LLM prompts and mark them for manual review.
9. Use `rerank-ts`'s `LLMReranker` with OpenAI to order the safe candidates against the query.
10. Ask OpenAI for a concise, evidence-based match rationale for each LLM-ranked candidate.
11. Combine LLM-ranked candidates with review-only candidates and show the ordered results.
12. Cache the candidate IDs, ranks, rationales, and review statuses in Redis for one hour. Resume text and contact details are not stored in the ranking cache.
13. When the recruiter selects **View resume**, fetch the full resume on demand from `resume_details`.

**Output:** Ranked candidates with match rationales, plus any candidates requiring manual review.

## Database Table Structures

### `documents`

Resume version and lifecycle record. Full resume text and candidate profile data are stored separately.

| Column | Type | Constraints / purpose |
| --- | --- | --- |
| `tenant_id` | `text` | Part of primary key; scopes the resume |
| `document_id` | `text` | Part of primary key; resume identifier |
| `version` | `integer` | Part of primary key; must be greater than zero |
| `title` | `text` | Required resume title |
| `status` | `text` | `queued`, `processing`, `active`, `superseded`, or `failed` |
| `is_active` | `boolean` | Indicates the active version for a resume |
| `created_at` | `timestamptz` | Defaults to current time |
| `updated_at` | `timestamptz` | Defaults to current time |

**Primary key:** (`tenant_id`, `document_id`, `version`). A partial unique index allows one active version per tenant and document.

### `resume_details`

Stores the full extracted resume and candidate profile separately from vector chunks.

| Column | Type | Constraints / purpose |
| --- | --- | --- |
| `tenant_id` | `text` | Part of primary key and foreign key to `documents` |
| `document_id` | `text` | Part of primary key and foreign key to `documents` |
| `version` | `integer` | Part of primary key and foreign key to `documents` |
| `resume_text` | `text` | Required full extracted resume text |
| `candidate_details` | `jsonb` | Candidate metadata; defaults to an empty object |
| `created_at` | `timestamptz` | Defaults to current time |

**Primary key:** (`tenant_id`, `document_id`, `version`). The composite foreign key references `documents` and cascades on delete.

### `ingest_operations`

Tracks asynchronous resume ingestion and idempotent submissions.

| Column | Type | Constraints / purpose |
| --- | --- | --- |
| `id` | `uuid` | Primary key for the operation |
| `tenant_id` | `text` | Tenant scope; participates in idempotency key and document foreign key |
| `document_id` | `text` | Resume identifier; participates in document foreign key |
| `version` | `integer` | Resume version; participates in document foreign key |
| `idempotency_key` | `text` | Required request deduplication key |
| `request_hash` | `text` | Required hash of the submitted request |
| `status` | `text` | `queued`, `processing`, `completed`, or `failed` |
| `error_code` | `text` | Optional failure code |
| `created_at` | `timestamptz` | Defaults to current time |
| `updated_at` | `timestamptz` | Defaults to current time |

**Keys:** `id` is the primary key. (`tenant_id`, `idempotency_key`) is unique. The composite document foreign key references `documents`.

### `outbox_events`

Stores events for reliable asynchronous processing.

| Column | Type | Constraints / purpose |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `event_type` | `text` | Required event name |
| `payload` | `jsonb` | Required event payload |
| `attempts` | `integer` | Retry count; defaults to zero |
| `locked_until` | `timestamptz` | Optional processing lock expiry |
| `created_at` | `timestamptz` | Defaults to current time |
| `published_at` | `timestamptz` | Null until published |

**Index:** Pending events are indexed by `created_at` where `published_at` is null.

### `document_chunks`

Stores searchable resume chunks and their pgvector embeddings. Candidate profile details remain in `resume_details`.

| Column | Type | Constraints / purpose |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `tenant_id` | `text` | Tenant scope and part of the composite foreign key |
| `document_id` | `text` | Resume identifier and part of the composite foreign key |
| `document_version` | `integer` | Resume version and part of the composite foreign key |
| `chunk_index` | `integer` | Chunk order within the resume |
| `content` | `text` | Required chunk text used for retrieval and reranking |
| `metadata` | `jsonb` | Structural chunk metadata; defaults to an empty object |
| `embedding` | `vector(1536)` | Required embedding vector |
| `created_at` | `timestamptz` | Defaults to current time |

**Keys and indexes:** (`tenant_id`, `document_id`, `document_version`, `chunk_index`) is unique. The composite foreign key references `documents` and cascades on delete. HNSW with cosine operators supports vector search; a tenant/document index supports filtering.

## Cache and safety behavior

- Embedding vectors are cached in Redis to avoid repeat embedding requests for identical text.
- Candidate ranking and explanations are cached for one hour. The cache key includes the tenant, normalized query, candidate versions/content, and model identifiers, so changed search inputs or resumes get a fresh ranking.
- The ranking cache stores candidate IDs, ranks, rationales, and review statuses, not resume text or contact details.
- StackOne Defender scans candidate excerpts locally before either LLM call. Flagged or incompletely scanned candidates stay visible for manual review but are excluded from LLM prompts.
- The full resume is fetched from `resume_details` only when the recruiter opens a result.
