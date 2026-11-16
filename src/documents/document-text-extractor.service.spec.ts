import { BadRequestException } from '@nestjs/common';
import { DocumentTextExtractorService } from './document-text-extractor.service';

function makeFile(name: string, content: Buffer): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    size: content.length,
    buffer: content,
    destination: '',
    filename: name,
    path: '',
    stream: undefined as never,
  };
}

describe('DocumentTextExtractorService', () => {
  const service = new DocumentTextExtractorService();

  it('extracts UTF-8 plain text', async () => {
    await expect(service.extract(makeFile('notes.txt', Buffer.from('  searchable notes  '))))
      .resolves.toBe('searchable notes');
  });

  it('rejects a PDF extension with non-PDF content', async () => {
    await expect(service.extract(makeFile('fake.pdf', Buffer.from('not a pdf'))))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsupported formats', async () => {
    await expect(service.extract(makeFile('notes.rtf', Buffer.from('text'))))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects empty extracted text', async () => {
    await expect(service.extract(makeFile('empty.txt', Buffer.from('  \n'))))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});