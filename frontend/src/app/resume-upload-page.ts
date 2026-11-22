import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, interval, of, startWith, switchMap, takeWhile } from 'rxjs';
import { IngestApiService, IngestOperation, SubmitDocument } from './ingest-api.service';

@Component({
  imports: [DatePipe, FormsModule],
  selector: 'app-resume-upload-page',
  templateUrl: './resume-upload-page.html',
})
export class ResumeUploadPage implements OnInit {
  private readonly api = inject(IngestApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isSubmitting = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly selectedFile = signal<File | null>(null);
  protected readonly operations = signal<IngestOperation[]>([]);
  protected candidateName = '';
  protected candidateEmail = '';
  protected candidateSkills = '';
  protected readonly form: SubmitDocument = {
    tenantId: 'demo-tenant',
    documentId: '',
    version: 1,
    title: '',
    content: '',
    metadata: { source: 'resume-search' },
  };

  ngOnInit(): void {
    this.restoreOperations();
  }

  protected submitDocument(): void {
    if (this.isSubmitting()) return;
    this.errorMessage.set('');
    this.isSubmitting.set(true);
    this.form.title = `${this.candidateName.trim()} resume`;
    this.form.metadata = {
      source: 'resume-search',
      candidateName: this.candidateName.trim(),
      email: this.candidateEmail.trim(),
      skills: this.candidateSkills.split(',').map((skill) => skill.trim()).filter(Boolean),
    };
    const request = this.selectedFile()
      ? this.api.upload(this.form, this.selectedFile()!, crypto.randomUUID())
      : this.api.submit(this.form, crypto.randomUUID());
    request.subscribe({
      next: (operation) => {
        this.isSubmitting.set(false);
        this.form.documentId = '';
        this.form.title = '';
        this.form.content = '';
        this.candidateName = '';
        this.candidateEmail = '';
        this.candidateSkills = '';
        this.selectedFile.set(null);
        const fileInput = document.querySelector<HTMLInputElement>('#document-file');
        if (fileInput) fileInput.value = '';
        this.upsertOperation(operation);
        this.watchOperation(operation);
      },
      error: (error: HttpErrorResponse) => {
        this.isSubmitting.set(false);
        this.errorMessage.set(this.describeError(error));
      },
    });
  }

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      this.selectedFile.set(null);
      this.errorMessage.set('Please choose a PDF resume.');
      input.value = '';
      return;
    }
    this.errorMessage.set('');
    this.selectedFile.set(file);
    if (file) {
      this.form.title = this.form.title.trim() || file.name;
      this.form.documentId = crypto.randomUUID();
      this.form.content = '';
    }
  }

  protected clearSelectedFile(): void {
    this.selectedFile.set(null);
    const fileInput = document.querySelector<HTMLInputElement>('#document-file');
    if (fileInput) fileInput.value = '';
  }

  protected statusClass(status: string): string {
    return `status-${status}`;
  }

  protected trackOperation(_index: number, operation: IngestOperation): string {
    return operation.operationId;
  }

  private watchOperation(initial: IngestOperation): void {
    interval(2500)
      .pipe(
        startWith(0),
        switchMap(() => this.api.getOperation(initial.operationId, initial.tenantId).pipe(
          catchError(() => of(null)),
        )),
        takeWhile((operation) =>
          operation === null || (operation.status !== 'completed' && operation.status !== 'failed'),
          true,
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((operation) => {
        if (operation) this.upsertOperation(operation);
      });
  }

  private upsertOperation(operation: IngestOperation): void {
    const updated = [
      operation,
      ...this.operations().filter((item) => item.operationId !== operation.operationId),
    ].slice(0, 20);
    this.operations.set(updated);
    localStorage.setItem('ingest-console.operations', JSON.stringify(updated));
  }

  private restoreOperations(): void {
    try {
      const saved = localStorage.getItem('ingest-console.operations');
      if (saved) this.operations.set(JSON.parse(saved) as IngestOperation[]);
    } catch {
      localStorage.removeItem('ingest-console.operations');
    }
  }

  private describeError(error: HttpErrorResponse): string {
    if (error.status === 0) return 'Cannot reach the ingest API. Check that the backend is running.';
    if (error.status === 409) return 'That idempotency key was already used with a different request.';
    if (error.status === 400) return 'Check the required fields and try again.';
    return error.error?.message ?? 'Resume submission failed. Try again.';
  }
}