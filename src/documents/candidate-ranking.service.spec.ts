import OpenAI from 'openai';
import { CandidateRankingService, CandidateSearchResult } from './candidate-ranking.service';

jest.mock('@stackone/defender', () => ({
  createPromptDefense: jest.fn(() => ({
    warmupTier2: jest.fn().mockResolvedValue(undefined),
    defendToolResults: jest.fn(),
  })),
}));

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
    defense: { warmupTier2: jest.Mock; defendToolResults: jest.Mock };
    cache: { getJson: jest.Mock; setJson: jest.Mock };
  } {
    process.env.OPENAI_API_KEY ??= 'test-key';
    const values = new Map<string, unknown>();
    const cache = {
      getJson: jest.fn(async (_namespace: string, key: string) => values.get(key)),
      setJson: jest.fn(async (_namespace: string, key: string, value: unknown) => {
        values.set(key, value);
      }),
    };
    const service = new CandidateRankingService(cache as never);
    const create = jest.fn().mockResolvedValue(completion);
    const rerank = jest.fn().mockResolvedValue({
      result: ['candidate-b', 'candidate-a'],
      usage: [],
    });
    const defense = {
      warmupTier2: jest.fn().mockResolvedValue(undefined),
      defendToolResults: jest.fn().mockImplementation(async (items: Array<{ value: unknown }>) =>
        items.map((item) => ({
          allowed: true,
          sanitized: item.value,
          coverageDegraded: false,
          tier2Available: true,
        })),
      ),
    };
    Object.defineProperty(service, 'client', {
      value: { chat: { completions: { create } } },
    });
    Object.defineProperty(service, 'reranker', { value: { rerank } });
    Object.defineProperty(service, 'defense', { value: defense });
    return { service, rerank, create, defense, cache };
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

    const result = await service.rank('tenant-a', 'Senior backend engineer', candidates);

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

    const result = await service.rank('tenant-a', 'Senior backend engineer', candidates);

    expect(result.method).toBe('llm');
    expect(result.results.map((candidate) => candidate.documentId)).toEqual([
      'candidate-b',
      'candidate-a',
    ]);
    expect(result.results[0].matchReason).toContain('specific explanation could not be generated');
  });

  it('excludes flagged resume text from the LLM while retaining the candidate for review', async () => {
    const { service, rerank, defense } = createService({
      choices: [{
        message: {
          content: JSON.stringify({
            reasons: [{ documentId: 'candidate-b', reason: 'Relevant distributed systems experience.' }],
          }),
        },
      }],
    });
    defense.defendToolResults.mockResolvedValue([
      {
        allowed: false,
        sanitized: candidates[0],
        coverageDegraded: false,
        tier2Available: true,
      },
      {
        allowed: true,
        sanitized: { content: 'Node.js, Kafka\nSeven years building distributed backend systems.' },
        coverageDegraded: false,
        tier2Available: true,
      },
    ]);

    const result = await service.rank('tenant-a', 'Senior backend engineer', candidates);

    expect(rerank.mock.calls[0][0]).toEqual([
      expect.objectContaining({ documentId: 'candidate-b' }),
    ]);
    expect(result.results.map((candidate) => [candidate.documentId, candidate.rankingStatus])).toEqual([
      ['candidate-b', 'ranked'],
      ['candidate-a', 'review'],
    ]);
    expect(result.results[1].matchReason).toContain('excluded from LLM ranking');
  });

  it('does not send resumes to the LLM when the local safety scan fails', async () => {
    const { service, rerank, create, defense } = createService({ choices: [] });
    defense.warmupTier2.mockRejectedValue(new Error('classifier unavailable'));

    const result = await service.rank('tenant-a', 'Senior backend engineer', candidates);

    expect(result.method).toBe('semantic');
    expect(result.results.every((candidate) => candidate.rankingStatus === 'review')).toBe(true);
    expect(rerank).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('serves repeated searches from cache and isolates tenant keys', async () => {
    const { service, rerank, create, defense, cache } = createService({
      choices: [{
        message: {
          content: JSON.stringify({
            reasons: [
              { documentId: 'candidate-b', reason: 'More years of relevant experience.' },
              { documentId: 'candidate-a', reason: 'Relevant backend experience.' },
            ],
          }),
        },
      }],
    });

    const first = await service.rank('tenant-a', 'Senior backend engineer', candidates);
    const repeated = await service.rank('tenant-a', 'Senior backend engineer', candidates);

    expect(repeated).toEqual(first);
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(defense.defendToolResults).toHaveBeenCalledTimes(1);
    expect(cache.getJson).toHaveBeenCalledTimes(2);
    expect(cache.setJson).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cache.setJson.mock.calls[0][2])).not.toContain('a@example.com');
    expect(JSON.stringify(cache.setJson.mock.calls[0][2])).not.toContain(candidates[0].content);
    expect(cache.setJson.mock.calls[0][3]).toBe(3600);

    await service.rank('tenant-b', 'Senior backend engineer', candidates);
    expect(cache.getJson.mock.calls[0][1]).not.toBe(cache.getJson.mock.calls[2][1]);
    expect(rerank).toHaveBeenCalledTimes(2);

    const updatedCandidates = [
      { ...candidates[0], content: 'Updated: eight years of backend development with Node.js.' },
      candidates[1],
    ];
    await service.rank('tenant-a', 'Senior backend engineer', updatedCandidates);
    expect(cache.getJson.mock.calls[0][1]).not.toBe(cache.getJson.mock.calls[3][1]);
    expect(rerank).toHaveBeenCalledTimes(3);
  });
});