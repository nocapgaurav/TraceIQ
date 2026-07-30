export { dependencyNavigationOf } from './dependency-navigation.js';
export { LIMITATION_DETAIL } from './limitations.js';
export {
  NavigationContext,
  limitationsOf,
  mapListing,
  packageOfNode,
  roleGroupsOf,
  treeRef,
} from './navigation-context.js';
export { RepositoryNavigator } from './repository-navigator.js';
export { explainRouteOf, routeIdOf, routeSummariesOf } from './route-explanation.js';
export {
  architectureNavigationOf,
  architectureTreeOf,
  dependencyTreeOf,
  packageTreeOf,
  roleTreeOf,
} from './trees.js';
export {
  CHAIN_POSITIONS,
  GROUP_CATEGORIES,
  LIMITATION_CODES,
  NAVIGATION_LIMIT,
  SUBJECT_KINDS,
  type ArchitectureGroup,
  type ArchitectureNavigation,
  type ChainPosition,
  type DependencyHealthSummary,
  type DependencyNavigation,
  type DependencySubject,
  type DependencySubjectRef,
  type DependencyTreeEdge,
  type DependencyTreeNode,
  type FileTreeNode,
  type GroupCategory,
  type HandlerStep,
  type Limitation,
  type LimitationCode,
  type OperationProfile,
  type PackageTreeNode,
  type Profiled,
  type ReachedRef,
  type RelationshipGraph,
  type RoleTreeNode,
  type RoleTreePackage,
  type RouteCallGraphSummary,
  type RouteExplanationView,
  type RouteHealthSummary,
  type RouteImpactSummary,
  type RouteSelector,
  type RouteSummary,
  type SubjectKind,
  type TreeRef,
} from './types.js';

// Depends only on repository intelligence packages: Repository Explorer, Explain Symbol, Impact
// Analysis, Repository Health, the Query Engine, the Graph API read model and the shared vocabulary.
// No SQLite, no Graph Builder, no Project Host, no Resolver, no ts-morph — and no AI: nothing here
// predicts, ranks, scores or generates language.
