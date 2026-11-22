import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, OnInit, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { IngestApiService } from './ingest-api.service';

@Component({
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  selector: 'app-root',
  encapsulation: ViewEncapsulation.None,
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly api = inject(IngestApiService);

  protected readonly apiOnline = signal(false);

  ngOnInit(): void {
    this.refreshHealth();
  }

  private refreshHealth(): void {
    this.api.health().subscribe({
      next: () => this.apiOnline.set(true),
      error: () => this.apiOnline.set(false),
    });
  }
}
