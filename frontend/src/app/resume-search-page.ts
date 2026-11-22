import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IngestApiService, ResumeDetails, SearchResult } from './ingest-api.service';

@Component({
  imports: [FormsModule],
  selector: 'app-resume-search-page',
  templateUrl: './resume-search-page.html',
})
export class ResumeSearchPage {
  private readonly api = inject(IngestApiService);

  protected readonly isSearching = signal(false);
  protected readonly searchError = signal('');
  protected readonly searchQuery = signal('');
  protected readonly searchResults = signal<SearchResult[]>([]);
  protected readonly rankingMethod = signal<'llm' | 'semantic'>('llm');
  protected readonly expandedResumeId = signal<string | null>(null);
  protected readonly resumeDetails = signal<Record<string, ResumeDetails>>({});
  protected readonly loadingResumeId = signal<string | null>(null);
  protected readonly detailsError = signal('');

  protected searchDocuments(): void {
    if (this.isSearching()) return;
    this.searchError.set('');
    this.isSearching.set(true);
    this.api.search('demo-tenant', this.searchQuery()).subscribe({
      next: (response) => {
        this.searchResults.set(response.results);
        this.rankingMethod.set(response.rankingMethod);
        this.isSearching.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.searchError.set(error.status === 0
          ? 'Cannot reach the ingest API.'
          : error.error?.message ?? 'Search failed. Try again.');
        this.isSearching.set(false);
      },
    });
  }

  protected metadataText(metadata: Record<string, unknown>, key: string): string {
    const value = metadata[key];
    if (typeof value === 'string') return value;
    return Array.isArray(value) ? value.join(', ') : '';
  }

  protected toggleResume(result: SearchResult): void {
    if (this.expandedResumeId() === result.documentId) {
      this.expandedResumeId.set(null);
      return;
    }
    this.expandedResumeId.set(result.documentId);
    if (this.resumeDetails()[result.documentId]) return;

    this.detailsError.set('');
    this.loadingResumeId.set(result.documentId);
    this.api.getResume(result.documentId, 'demo-tenant').subscribe({
      next: (details) => {
        this.resumeDetails.update((current) => ({ ...current, [result.documentId]: details }));
        this.loadingResumeId.set(null);
      },
      error: (error: HttpErrorResponse) => {
        this.detailsError.set(error.error?.message ?? 'Could not load this resume. Try again.');
        this.loadingResumeId.set(null);
      },
    });
  }
}