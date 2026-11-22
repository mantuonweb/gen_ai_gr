import OpenAI from 'openai';
import { CandidateRankingService, CandidateSearchResult } from './candidate-ranking.service';

describe('CandidateRankingService', () => {
  const candidates: CandidateSearchResult[] = [
    {
      documentId: 'candidate-a',
      version: 1,
      title: 'Candidate A resume',
      content: 'Three years of backend development with Node.js.',
      metadata: { candidateName: 'Candidate A', email: 'a@example.com', skills: ['Node.js'] },
      score: 0.9,
    },
    {
      documentId: 'candidate-b',
      version: 1,
      title: 'Candidate B resume',
      content: 'Seven years building distributed backend systems with Node.js.',
      metadata: { candidateName: 'Candidate B', email: 'b@example.com', skills: ['Node.js', 'Kafka'] },
      score: 0.82,
    },
  ];

  function createService(completion: unknown): {
    service: CandidateRankingService;
    rerank: jest.Mock;
    create: jest.Mock;
  } {
    process.env.OPENAI_API_KEY ??= 'test-key';
    const service = new CandidateRankingService();
    const create = jest.fn().mockResolvedValue(completion);
    const rerank = jest.fn().mockResolvedValue({
      result: ['candidate-b', 'candidate-a'],
      usage: [],
    });
    Object.defineProperty(service, 'client', {
      value: { chat: { completions: { create } } },
    });
    Object.defineProperty(service, 'reranker', { value: { rerank } });
    return { service, rerank, create };
  }

  it('uses rerank-ts order and attaches a factual model rationale', async () => {
    const { service, create } = createService({
      choices: [{
        message: {
          content: JSON.stringify({
            reasons: [
              { documentId: 'candidate-b', reason: 'More years of directly relevant backend experience.' },
              { documentId: 'candidate-a', reason: 'Relevant Node.js experience, with fewer years stated.' },
            ],
          }),
        },
      }],
    });

    const result = await service.rank('Senior backend engineer', candidates);

    expect(result.method).toBe('llm');
    expect(result.results.map(({ documentId, rank }) => [documentId, rank])).toEqual([
      ['candidate-b', 1],
      ['candidate-a', 2],
    ]);
    expect(result.results[0].matchReason).toContain('More years');
    const prompt = create.mock.calls[0][0].messages[1].content as string;
    expect(prompt).not.toContain('a@example.com');
    expect(prompt).not.toContain('b@example.com');
  });

  it('keeps the rerank-ts order when rationale generation fails', async () => {
    const { service } = createService({ choices: [{ message: { content: 'not json' } }] });

    const result = await service.rank('Senior backend engineer', candidates);

    expect(result.method).toBe('llm');
    expect(result.results.map((candidate) => candidate.documentId)).toEqual([
      'candidate-b',
      'candidate-a',
    ]);
    expect(result.results[0].matchReason).toContain('specific explanation could not be generated');
  });
});