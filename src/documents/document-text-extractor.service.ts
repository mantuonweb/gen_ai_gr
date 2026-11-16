import { BadRequestException, Injectable } from '@nestjs/common';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import WordExtractor from 'word-extractor';

const MAX_EXTRACTED_CHARACTERS = 1_000_000;
const PDF_SIGNATURE = Buffer.from('%PDF-');
const DOC_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

@Injectable()
export class DocumentTextExtractorService {
  async extract(file: Express.Multer.File): Promise<string> {
    const extension = file.originalname.split('.').pop()?.toLowerCase();
    let text: string;

    if (extension === 'txt') {
      if (file.buffer.includes(0)) {
        throw new BadRequestException('The selected .txt file is not valid UTF-8 text');
      }
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
      } catch {
        throw new BadRequestException('The selected .txt file is not valid UTF-8 text');
      }
    } else if (extension === 'pdf') {
      if (!this.hasPdfSignature(file.buffer)) {
        throw new BadRequestException('The uploaded file does not have a valid PDF signature');
      }
      const parsed = await pdfParse(file.buffer);
      text = parsed.text;
    } else if (extension === 'docx') {
      if (!this.hasZipSignature(file.buffer)) {
        throw new BadRequestException('The uploaded file does not have a valid DOCX signature');
      }
      const parsed = await mammoth.extractRawText({ buffer: file.buffer });
      text = parsed.value;
    } else if (extension === 'doc') {
      if (!file.buffer.subarray(0, DOC_SIGNATURE.length).equals(DOC_SIGNATURE)) {
        throw new BadRequestException('The uploaded file does not have a valid DOC signature');
      }
      const extractor = new WordExtractor();
      const parsed = await extractor.extract(file.buffer);
      text = parsed.getBody();
    } else {
      throw new BadRequestException('Supported file types are .txt, .pdf, .doc, and .docx');
    }

    const normalized = text.replace(/\0/g, '').trim();
    if (!normalized) throw new BadRequestException('No readable text was found in the document');
    if (normalized.length > MAX_EXTRACTED_CHARACTERS) {
      throw new BadRequestException('Extracted text exceeds the 1,000,000 character limit');
    }
    return normalized;
  }

  private hasPdfSignature(buffer: Buffer): boolean {
    return buffer.subarray(0, 1024).includes(PDF_SIGNATURE);
  }

  private hasZipSignature(buffer: Buffer): boolean {
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  }
}