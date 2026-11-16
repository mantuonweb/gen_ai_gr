import { DatabaseService } from '../database/database.service';
import { EmbeddingService } from '../embeddings/embedding.service';
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
    const service = new DocumentsService(
      database as unknown as DatabaseService,
      embeddings as unknown as EmbeddingService,
    );

    await expect(service.search({ tenantId: 'tenant-a', query: 'how does search work', limit: 3 }))
      .resolves.toEqual({
        query: 'how does search work',
        results: [{
          documentId: 'guide',
          version: 3,
          title: 'Guide',
          content: 'Relevant passage',
          metadata: { section: 'intro' },
          score: 0.91,
        }],
      });

    expect(embeddings.embed).toHaveBeenCalledWith(['how does search work']);
    expect(database.query.mock.calls[0][0]).toContain('c.tenant_id = $2');
    expect(database.query.mock.calls[0][1][1]).toBe('tenant-a');
    expect(database.query.mock.calls[0][1][2]).toBe(3);
  });
});