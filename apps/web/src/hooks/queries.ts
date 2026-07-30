'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { ApiError } from '@/services/api-client';
import { repositoryService } from '@/services/repository-service';
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
  SearchResults,
  SymbolView,
  VersionInfo,
} from '@/types/api';

/**
 * Every read the app performs, as a hook.
 *
 * A component calls a hook and renders; it never assembles a request, builds a URL or decides when to
 * refetch. That keeps components free of logic and means the whole data layer is one file to audit.
 *
 * **Query keys are declared once** in `queryKeys` so an invalidation cannot miss a key by spelling it
 * differently at the call site.
 */
export const queryKeys = {
  version: () => ['version'] as const,
  overview: () => ['overview'] as const,
  architecture: () => ['architecture'] as const,
  packages: () => ['packages'] as const,
  package: (name: string) => ['package', name] as const,
  file: (path: string) => ['file', path] as const,
  symbol: (id: string) => ['symbol', id] as const,
  impact: (id: string) => ['impact', id] as const,
  routes: () => ['routes'] as const,
  route: (method: string, path: string) => ['route', method, path] as const,
  health: () => ['health'] as const,
  search: (text: string, kind: string, match: string) => ['search', text, kind, match] as const,
  dependencies: (subject: string) => ['dependencies', subject] as const,
  cycles: () => ['cycles'] as const,
  hotspots: () => ['hotspots'] as const,
};

/**
 * A graph is one immutable revision until the next scan, so a fetched answer never goes stale on its
 * own. `staleTime: Infinity` says exactly that, and it is why navigating back to a page is instant.
 */
const IMMUTABLE = { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60 * 1000 } as const;

/**
 * Retrying is pointless for a 4xx: the identifier is wrong, and asking again gives the same answer.
 * Only a transport failure or a 5xx is worth a second attempt.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status < 500) {
    return false;
  }

  return failureCount < 2;
}

export function useVersion(): UseQueryResult<VersionInfo, Error> {
  return useQuery({ queryKey: queryKeys.version(), queryFn: repositoryService.version, retry: shouldRetry });
}

export function useOverview(): UseQueryResult<Overview, Error> {
  return useQuery({ queryKey: queryKeys.overview(), queryFn: repositoryService.overview, ...IMMUTABLE });
}

export function useArchitecture(): UseQueryResult<ArchitectureNavigation, Error> {
  return useQuery({ queryKey: queryKeys.architecture(), queryFn: repositoryService.architecture, ...IMMUTABLE });
}

export function usePackages(): UseQueryResult<Listing<PackageSummary>, Error> {
  return useQuery({ queryKey: queryKeys.packages(), queryFn: repositoryService.packages, ...IMMUTABLE });
}

export function usePackage(name: string | null): UseQueryResult<PackageView, Error> {
  return useQuery({
    queryKey: queryKeys.package(name ?? ''),
    queryFn: () => repositoryService.packageByName(name ?? ''),
    enabled: name !== null && name !== '',
    ...IMMUTABLE,
  });
}

export function useFile(path: string | null): UseQueryResult<FileView, Error> {
  return useQuery({
    queryKey: queryKeys.file(path ?? ''),
    queryFn: () => repositoryService.file(path ?? ''),
    enabled: path !== null && path !== '',
    ...IMMUTABLE,
  });
}

export function useSymbol(id: string | null): UseQueryResult<SymbolView, Error> {
  return useQuery({
    queryKey: queryKeys.symbol(id ?? ''),
    queryFn: () => repositoryService.symbol(id ?? ''),
    enabled: id !== null && id !== '',
    retry: shouldRetry,
    ...IMMUTABLE,
  });
}

export function useImpact(id: string | null): UseQueryResult<ImpactAnalysis, Error> {
  return useQuery({
    queryKey: queryKeys.impact(id ?? ''),
    queryFn: () => repositoryService.impact(id ?? ''),
    enabled: id !== null && id !== '',
    retry: shouldRetry,
    ...IMMUTABLE,
  });
}

export function useRoutes(): UseQueryResult<Listing<RouteSummary>, Error> {
  return useQuery({ queryKey: queryKeys.routes(), queryFn: repositoryService.routes, ...IMMUTABLE });
}

export function useRoute(method: string | null, path: string | null): UseQueryResult<RouteExplanationView, Error> {
  return useQuery({
    queryKey: queryKeys.route(method ?? '', path ?? ''),
    queryFn: () => repositoryService.route(method ?? '', path ?? ''),
    enabled: method !== null && method !== '' && path !== null && path !== '',
    retry: shouldRetry,
    ...IMMUTABLE,
  });
}

export function useHealth(): UseQueryResult<HealthReport, Error> {
  return useQuery({ queryKey: queryKeys.health(), queryFn: repositoryService.health, ...IMMUTABLE });
}

export function useCycles(): UseQueryResult<CycleReport, Error> {
  return useQuery({ queryKey: queryKeys.cycles(), queryFn: repositoryService.cycles, ...IMMUTABLE });
}

export function useHotspots(): UseQueryResult<HotspotReport, Error> {
  return useQuery({ queryKey: queryKeys.hotspots(), queryFn: repositoryService.hotspots, ...IMMUTABLE });
}

export function useDependencies(subject: string | null): UseQueryResult<DependencyNavigation, Error> {
  return useQuery({
    queryKey: queryKeys.dependencies(subject ?? ''),
    queryFn: () => repositoryService.dependencies(subject ?? ''),
    enabled: subject !== null && subject !== '',
    retry: shouldRetry,
    ...IMMUTABLE,
  });
}

export interface SearchInput {
  readonly text: string;
  readonly kind?: string;
  readonly match?: 'prefix' | 'exact';
}

export function useSearch(input: SearchInput): UseQueryResult<SearchResults, Error> {
  const text = input.text.trim();

  return useQuery({
    queryKey: queryKeys.search(text, input.kind ?? '', input.match ?? 'prefix'),
    queryFn: () =>
      repositoryService.search({
        text,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.match === undefined ? {} : { match: input.match }),
      }),
    // The API requires a non-empty `q`; asking with an empty box would be a guaranteed 400.
    enabled: text !== '',
    ...IMMUTABLE,
  });
}
