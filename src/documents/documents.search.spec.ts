import { DatabaseService } from '../database/database.service';
import { EmbeddingService } from '../embeddings/embedding.service';
import { CandidateSearchResult } from './candidate-ranking.service';
import { DocumentsService } from './documents.service';

describe('DocumentsService.search', () => {
  it('embeds a query and filters ranked matches by tenant', async () => {
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536);
    const embeddings = { embed: jest.fn().mockResolvedValue([vector]) };
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          document_id: 'guide',
          document_version: 3,
          title: 'Guide',
          content: 'Relevant passage',
          metadata: { section: 'intro' },
          score: '0.91',
        }],
        rowCount: 1,
      }),
    };
    const candidateRanking = {
      rank: jest.fn().mockImplementation(async (_query: string, candidates: CandidateSearchResult[]) => ({
        method: 'llm',
        results: candidates.map((candidate, index) => ({
          ...candidate,
          rank: index + 1,
          matchReason: 'Relevant experience matches the query.',
        })),
      })),
    };
    const service = new DocumentsService(
      database as unknown as DatabaseService,
      embeddings as unknown as EmbeddingService,
      candidateRanking as unknown as import('./candidate-ranking.service').CandidateRankingService,
    );

    await expect(service.search({ tenantId: 'tenant-a', query: 'how does search work', limit: 3 }))
      .resolves.toEqual({
        query: 'how does search work',
        rankingMethod: 'llm',
        results: [{
          documentId: 'guide',
          version: 3,
          title: 'Guide',
          content: 'Relevant passage',
          metadata: { section: 'intro' },
          score: 0.91,
          rank: 1,
          matchReason: 'Relevant experience matches the query.',
        }],
      });

    expect(embeddings.embed).toHaveBeenCalledWith(['how does search work']);
    expect(database.query.mock.calls[0][0]).toContain('c.tenant_id = $2');
    expect(database.query.mock.calls[0][0]).toContain('ROW_NUMBER() OVER');
    expect(database.query.mock.calls[0][0]).toContain('rd.candidate_details AS metadata');
    expect(database.query.mock.calls[0][0]).toContain('JOIN resume_details rd');
    expect(database.query.mock.calls[0][0]).toContain('ORDER BY score DESC');
    expect(database.query.mock.calls[0][1][1]).toBe('tenant-a');
    expect(database.query.mock.calls[0][1][2]).toBe(20);
    expect(candidateRanking.rank).toHaveBeenCalledWith('how does search work', [expect.objectContaining({
      documentId: 'guide',
      score: 0.91,
    })]);
  });

  it('loads full resume details from the dedicated table within the tenant', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          document_id: 'resume-1',
          version: 2,
          title: 'Jordan Lee resume',
          resume_text: 'Full resume text',
          candidate_details: { candidateName: 'Jordan Lee' },
        }],
        rowCount: 1,
      }),
    };
    const service = new DocumentsService(
      database as unknown as DatabaseService,
      {} as EmbeddingService,
      {} as import('./candidate-ranking.service').CandidateRankingService,
    );

    await expect(service.getDocument('resume-1', 'tenant-a')).resolves.toEqual({
      documentId: 'resume-1',
      version: 2,
      title: 'Jordan Lee resume',
      content: 'Full resume text',
      metadata: { candidateName: 'Jordan Lee' },
    });
    expect(database.query.mock.calls[0][0]).toContain('JOIN resume_details rd');
    expect(database.query.mock.calls[0][0]).toContain('d.is_active = true');
    expect(database.query.mock.calls[0][1]).toEqual(['tenant-a', 'resume-1']);
  });
});