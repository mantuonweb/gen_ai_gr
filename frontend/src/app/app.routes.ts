import { Routes } from '@angular/router';
import { DashboardPage } from './dashboard-page';
import { ResumeSearchPage } from './resume-search-page';
import { ResumeUploadPage } from './resume-upload-page';

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'dashboard' },
	{ path: 'dashboard', component: DashboardPage },
	{ path: 'upload', component: ResumeUploadPage },
	{ path: 'search', component: ResumeSearchPage },
	{ path: '**', redirectTo: 'dashboard' },
];
