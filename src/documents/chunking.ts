export function splitTextIntoChunks(
  input: string,
  maxCharacters = 4000,
  overlapCharacters = 400,
): string[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new RangeError('maxCharacters must be a positive integer');
  }
  if (
    !Number.isInteger(overlapCharacters) ||
    overlapCharacters < 0 ||
    overlapCharacters >= maxCharacters
  ) {
    throw new RangeError('overlapCharacters must be a non-negative integer smaller than maxCharacters');
  }

  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxCharacters, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(maxCharacters / 2)) end = boundary;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;

    start = Math.max(end - overlapCharacters, start + 1);
    while (text[start] === ' ') start += 1;
  }

  return chunks;
}