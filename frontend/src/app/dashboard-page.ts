import { Component, OnInit, signal } from '@angular/core';
import { IngestOperation } from './ingest-api.service';

@Component({
  selector: 'app-dashboard-page',
  templateUrl: './dashboard-page.html',
})
export class DashboardPage implements OnInit {
  protected readonly operations = signal<IngestOperation[]>([]);

  protected get completedCount(): number {
    return this.operations().filter((operation) => operation.status === 'completed').length;
  }

  protected get processingCount(): number {
    return this.operations().filter((operation) =>
      operation.status === 'queued' || operation.status === 'processing',
    ).length;
  }

  ngOnInit(): void {
    try {
      const saved = localStorage.getItem('ingest-console.operations');
      if (saved) this.operations.set(JSON.parse(saved) as IngestOperation[]);
    } catch {
      localStorage.removeItem('ingest-console.operations');
    }
  }
}