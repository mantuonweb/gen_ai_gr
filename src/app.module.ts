import { Module } from '@nestjs/common';
import { EmbeddingCacheService } from './cache/embedding-cache.service';
import { DatabaseService } from './database/database.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsService } from './documents/documents.service';
import { CandidateRankingService } from './documents/candidate-ranking.service';
import { DocumentTextExtractorService } from './documents/document-text-extractor.service';
import { HealthController } from './health.controller';
import { EmbeddingService } from './embeddings/embedding.service';
import { OpenAiEmbeddingProvider } from './embeddings/openai-embedding.provider';
import { IngestionProcessorService } from './documents/ingestion-processor.service';
import { IngestWorkerService } from './queue/ingest-worker.service';
import { RootController } from './root.controller';

@Module({
  controllers: [RootController, HealthController, DocumentsController],
  providers: [
    DatabaseService,
    EmbeddingCacheService,
    DocumentsService,
    CandidateRankingService,
    DocumentTextExtractorService,
    EmbeddingService,
    OpenAiEmbeddingProvider,
    IngestionProcessorService,
    IngestWorkerService,
  ],
})
export class AppModule {}