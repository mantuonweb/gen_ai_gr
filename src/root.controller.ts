import { Controller, Get } from '@nestjs/common';

@Controller()
export class RootController {
  @Get()
  getServiceInfo() {
    return {
      service: 'gen-ai-ingest-service',
      status: 'running',
      routes: {
        health: 'GET /health',
        submitDocument: 'POST /v1/documents',
        operationStatus: 'GET /v1/operations/:id?tenantId=<tenantId>',
      },
    };
  }
}