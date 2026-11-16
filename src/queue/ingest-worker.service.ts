import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqp from 'amqplib';
import { DatabaseService } from '../database/database.service';
import { IngestionProcessorService } from '../documents/ingestion-processor.service';

interface OutboxRecord {
  id: string;
  payload: { operationId: string };
}

const INGEST_QUEUE = 'document.ingest';
const RETRY_QUEUE = 'document.ingest.retry';
const DEAD_LETTER_QUEUE = 'document.ingest.dlq';
const RETRY_DELAYS = [5000, 30000, 120000];

@Injectable()
export class IngestWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestWorkerService.name);
  private connection?: amqp.ChannelModel;
  private channel?: amqp.ConfirmChannel;
  private publishTimer?: NodeJS.Timeout;
  private publishing = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly processor: IngestionProcessorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.processor.recoverInterruptedOperations();
    const connection = await amqp.connect({
      protocol: 'amqp',
      hostname: process.env.RABBITMQ_HOST ?? 'localhost',
      port: Number(process.env.RABBITMQ_PORT ?? 5672),
      username: process.env.RABBITMQ_USER ?? 'ingest',
      password: process.env.RABBITMQ_PASSWORD ?? 'local_dev_password',
      vhost: '/',
    });
    this.connection = connection;
    const channel = await connection.createConfirmChannel();
    this.channel = channel;

    await channel.assertQueue(INGEST_QUEUE, { durable: true });
    await channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': INGEST_QUEUE,
      },
    });
    await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await channel.prefetch(1);
    await channel.consume(INGEST_QUEUE, (message) => {
      if (message) {
        void this.handleMessage(message).catch(() => {
          this.logger.error('Worker could not settle a queue message');
        });
      }
    });

    this.publishTimer = setInterval(() => void this.publishOutbox(), 1000);
    void this.publishOutbox();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    await this.channel?.close();
    await this.connection?.close();
  }

  private async publishOutbox(): Promise<void> {
    if (!this.channel || this.publishing) return;
    this.publishing = true;
    let claimedIds: string[] = [];

    try {
      const claimed = await this.database.query<OutboxRecord>(
        `WITH pending AS (
           SELECT id
             FROM outbox_events
            WHERE published_at IS NULL
              AND (locked_until IS NULL OR locked_until < now())
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 20
         )
         UPDATE outbox_events event
            SET locked_until = now() + interval '60 seconds',
                attempts = attempts + 1
           FROM pending
          WHERE event.id = pending.id
         RETURNING event.id, event.payload`,
      );
      claimedIds = claimed.rows.map((event) => event.id);

      for (const event of claimed.rows) {
        this.channel.sendToQueue(INGEST_QUEUE, Buffer.from(JSON.stringify(event.payload)), {
          persistent: true,
          messageId: event.id,
          contentType: 'application/json',
        });
        await this.channel.waitForConfirms();
        await this.database.query(
          `UPDATE outbox_events
              SET published_at = now(), locked_until = NULL
            WHERE id = $1`,
          [event.id],
        );
      }
    } catch (error) {
      this.logger.error('Outbox publishing failed');
      if (claimedIds.length) {
        await this.database.query(
          `UPDATE outbox_events SET locked_until = NULL
            WHERE id = ANY($1::bigint[]) AND published_at IS NULL`,
          [claimedIds],
        ).catch(() => undefined);
      }
    } finally {
      this.publishing = false;
    }
  }

  private async handleMessage(message: amqp.ConsumeMessage): Promise<void> {
    if (!this.channel) return;

    let operationId: string | undefined;
    try {
      const event = JSON.parse(message.content.toString()) as { operationId?: unknown };
      if (typeof event.operationId !== 'string') throw new Error('Invalid event payload');
      operationId = event.operationId;
      await this.processor.processOperation(operationId);
      this.channel.ack(message);
    } catch {
      const retryCount = Number(message.properties.headers?.['x-retry-count'] ?? 0);
      if (retryCount < RETRY_DELAYS.length) {
        this.channel.sendToQueue(RETRY_QUEUE, message.content, {
          persistent: true,
          contentType: 'application/json',
          expiration: String(RETRY_DELAYS[retryCount]),
          headers: { ...message.properties.headers, 'x-retry-count': retryCount + 1 },
        });
        await this.channel.waitForConfirms();
        this.channel.ack(message);
        return;
      }

      if (operationId) await this.processor.markFailed(operationId);
      this.channel.sendToQueue(DEAD_LETTER_QUEUE, message.content, {
        persistent: true,
        contentType: 'application/json',
        headers: {
          ...message.properties.headers,
          'x-error-code': 'PROCESSING_FAILED',
        },
      });
      await this.channel.waitForConfirms();
      this.channel.ack(message);
      this.logger.error('Ingestion message moved to dead-letter queue');
    }
  }
}