import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DocumentTextExtractorService } from './document-text-extractor.service';
import { DocumentsService } from './documents.service';
import { SearchDocumentsDto } from './search-documents.dto';
import { SubmitDocumentDto } from './submit-document.dto';

@Controller('v1')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly textExtractor: DocumentTextExtractorService,
  ) {}

  @Post('documents')
  @HttpCode(HttpStatus.ACCEPTED)
  submitDocument(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitDocumentDto,
  ) {
    if (!dto.content?.trim()) {
      throw new HttpException('Provide content or upload a supported document file', HttpStatus.BAD_REQUEST);
    }
    return this.documentsService.submit(dto, idempotencyKey);
  }

  @Post('documents/upload')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  async uploadDocument(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: SubmitDocumentDto,
  ) {
    if (!file) throw new HttpException('A file is required', HttpStatus.BAD_REQUEST);
    const content = await this.textExtractor.extract(file);
    return this.documentsService.submit(
      {
        ...dto,
        content,
        title: dto.title || file.originalname,
        metadata: { ...(dto.metadata ?? {}), filename: file.originalname },
      },
      idempotencyKey,
    );
  }

  @Get('documents/search')
  searchDocuments(@Query() query: SearchDocumentsDto) {
    return this.documentsService.search(query);
  }

  @Get('documents/:documentId')
  getDocument(
    @Param('documentId') documentId: string,
    @Query('tenantId') tenantId: string,
  ) {
    return this.documentsService.getDocument(documentId, tenantId);
  }

  @Get('operations/:id')
  getOperation(
    @Param('id', ParseUUIDPipe) operationId: string,
    @Query('tenantId') tenantId: string,
  ) {
    return this.documentsService.getOperation(operationId, tenantId);
  }
}