import { apiClient, encodeSegment } from './api-client';
import type {
  ArchitectureNavigation,
  CycleReport,
  DependencyNavigation,
  FileView,
  HealthReport,
  HotspotReport,
  ImpactAnalysis,
  Listing,
  Overview,
  PackageSummary,
  PackageView,
  RouteExplanationView,
  RouteSummary,
  ScanSummary,
  SearchResults,
  SymbolView,
  VersionInfo,
} from '@/types/api';

/**
 * One function per endpoint. Nothing else in the app knows a URL.
 *
 * A service **only** shapes a request and returns the payload. It holds no state, does no caching and
 * makes no decision about what to render — caching belongs to TanStack Query and rendering to a
 * component, so this layer stays a thin, testable description of the REST surface.
 */
export const repositoryService = {
  ping: (): Promise<{ status: string }> => apiClient.get('/ping'),

  version: (): Promise<VersionInfo> => apiClient.get('/version'),

  scan: (repository: string): Promise<ScanSummary> => apiClient.post('/scan', { repository }),

  overview: (): Promise<Overview> => apiClient.get('/overview'),

  architecture: (): Promise<ArchitectureNavigation> => apiClient.get('/architecture'),

  packages: (): Promise<Listing<PackageSummary>> => apiClient.get('/packages'),

  packageByName: (name: string): Promise<PackageView> =>
    apiClient.get(`/packages/${encodeSegment(name)}`),

  file: (path: string): Promise<FileView> => apiClient.get(`/files/${encodeSegment(path)}`),

  symbol: (id: string): Promise<SymbolView> => apiClient.get(`/symbol/${encodeSegment(id)}`),

  impact: (id: string): Promise<ImpactAnalysis> => apiClient.get(`/impact/${encodeSegment(id)}`),

  routes: (): Promise<Listing<RouteSummary>> => apiClient.get('/routes'),

  route: (method: string, path: string): Promise<RouteExplanationView> =>
    apiClient.get(`/route?method=${encodeURIComponent(method)}&path=${encodeURIComponent(path)}`),

  health: (): Promise<HealthReport> => apiClient.get('/health'),

  search: (query: { text: string; kind?: string; path?: string; match?: 'prefix' | 'exact' }): Promise<SearchResults> => {
    const params = new URLSearchParams({ q: query.text });

    if (query.kind !== undefined && query.kind !== '') {
      params.set('kind', query.kind);
    }

    if (query.path !== undefined && query.path !== '') {
      params.set('path', query.path);
    }

    if (query.match !== undefined) {
      params.set('match', query.match);
    }

    return apiClient.get(`/search?${params.toString()}`);
  },

  dependencies: (subject: string): Promise<DependencyNavigation> =>
    apiClient.get(`/dependencies/${encodeSegment(subject)}`),

  cycles: (): Promise<CycleReport> => apiClient.get('/cycles'),

  hotspots: (): Promise<HotspotReport> => apiClient.get('/hotspots'),
};
