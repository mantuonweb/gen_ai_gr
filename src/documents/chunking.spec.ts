import { splitTextIntoChunks } from './chunking';

describe('splitTextIntoChunks', () => {
  it('returns no chunks for blank input', () => {
    expect(splitTextIntoChunks('  \n\t ')).toEqual([]);
  });

  it('keeps short text in a single chunk', () => {
    expect(splitTextIntoChunks('one paragraph', 20, 2)).toEqual(['one paragraph']);
  });

  it('bounds chunks and retains overlap', () => {
    const chunks = splitTextIntoChunks('alpha beta gamma delta epsilon zeta eta theta', 20, 5);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks[0].slice(-5)).toBe(chunks[1].slice(0, 5));
  });

  it('rejects invalid limits', () => {
    expect(() => splitTextIntoChunks('text', 0, 0)).toThrow(RangeError);
    expect(() => splitTextIntoChunks('text', 10, 10)).toThrow(RangeError);
  });
});