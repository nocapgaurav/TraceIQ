/**
 * Architectural roles a declaration can play.
 *
 * Roles are annotations on declaration nodes, never node types of their own.
 * That a symbol is a class is CERTAIN because it is syntax; that the same class
 * is a Service is a heuristic judgement, and one declaration may hold several
 * roles at once. Modelling roles as node types would conflate proven structure
 * with interpretation and make that distinction unrepresentable.
 */
export const ROLES = [
  'Controller',
  'Service',
  'Repository',
  'Middleware',
  'Model',
  'Test',
] as const;

export type Role = (typeof ROLES)[number];
