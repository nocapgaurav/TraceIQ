import { apiClient } from './api-client';
import type { AnalysisJob, AnalysisList, StartAnalysis } from '@/types/api';

/**
 * Repository Analysis, over the REST surface.
 *
 * Two calls and no logic: start one, read one. The polling that follows a running analysis lives in the
 * hook, and the stages come from the server — this file invents nothing about progress.
 */
export const analysisService = {
  start: (url: string): Promise<StartAnalysis> => apiClient.post('/analysis', { url }),

  get: (id: string): Promise<AnalysisJob> => apiClient.get(`/analysis/${encodeURIComponent(id)}`),

  list: (): Promise<AnalysisList> => apiClient.get('/analysis'),
};
