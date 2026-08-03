import type {
  AnalysisDepth,
  GraphEdge,
  GraphNode,
  GraphRole,
  GraphUnresolvedReference,
  LanguageFileCount,
  NodeKind,
  RegionCapability,
  RepositoryCapabilities,
  RepositoryGraphApi,
} from '@traceiq/graph-api';
import type { SourceRange } from '@traceiq/ir';
import type { ConfidenceLevel, NodeId, RelationshipType, Role } from '@traceiq/types';
import Database from 'better-sqlite3';

import { summariseCapabilities } from './capabilities.js';

type Connection = Database.Database;

interface RegionRow {
  readonly path: string;
  readonly primary_language: string | null;
  readonly file_count: number;
  readonly source_file_count: number;
  readonly analysis_depth: string;
  readonly depth_reason: string;
}

export class GraphApiError extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`Cannot read the repository graph: ${reason}`, options);
    this.name = 'GraphApiError';
  }
}

interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly file_id: string | null;
  readonly container_chain: string | null;
  readonly visibility: string | null;
  readonly is_exported: number;
  readonly is_static: number;
  readonly is_abstract: number;
  readonly is_readonly: number;
  readonly is_optional: number;
  readonly is_async: number;
  readonly is_declaration_file: number | null;
  readonly has_symbol: number | null;
  readonly is_exported_from_module: number | null;
  readonly external_kind: string | null;
  readonly language: string | null;
  readonly file_role: string | null;
  readonly category: string | null;
  readonly artifact_kind: string | null;
  readonly external_name: string | null;
  readonly confidence: string;
  readonly provenance_producer: string;
  readonly provenance_file_id: string | null;
  readonly provenance_evidence: string;
}

interface LocationRow {
  readonly node_id: string;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
}

interface RoleRow {
  readonly node_id: string;
  readonly role: string;
  readonly confidence: string;
  readonly evidence: string;
}

interface UnresolvedRow {
  readonly id: string;
  readonly type: string;
  readonly source_id: string;
  readonly name: string | null;
  readonly reason: string;
  readonly text: string;
  readonly provenance_resolver: string;
  readonly provenance_file_id: string;
  readonly provenance_evidence: string;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
}

interface EdgeRow {
  readonly id: string;
  readonly type: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly name: string | null;
  readonly confidence: string;
  readonly candidate_group: string | null;
  readonly ordinal: number | null;
  readonly provenance_resolver: string;
  readonly provenance_file_id: string;
  readonly provenance_evidence: string;
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
}

const NODE_COLUMNS = `id, kind, name, file_id, container_chain, visibility,
  is_exported, is_static, is_abstract, is_readonly, is_optional, is_async,
  is_declaration_file, has_symbol, is_exported_from_module,
  external_kind, external_name, language, file_role, category, artifact_kind, confidence,
  provenance_producer, provenance_file_id, provenance_evidence`;

const EDGE_COLUMNS = `id, type, source_id, target_id, name, confidence, candidate_group,
  ordinal, provenance_resolver, provenance_file_id, provenance_evidence,
  start_line, start_column, end_line, end_column`;

const UNRESOLVED_COLUMNS = `id, type, source_id, name, reason, text,
  provenance_resolver, provenance_file_id, provenance_evidence,
  start_line, start_column, end_line, end_column`;

/**
 * The SQLite-backed Graph API.
 *
 * Every statement lives in this one file, which is what makes "no SQL outside the Graph
 * API" checkable: nothing above it knows a table name, and the `RepositoryGraphApi`
 * interface it satisfies mentions no storage concept at all.
 *
 * Read-only by construction — the connection is opened `readonly`, so a bug here cannot
 * corrupt a graph.
 *
 * It performs no traversal. `getOutgoing` returns one step; following those edges is the
 * Query Engine's work. Nothing is ranked, filtered by relevance or inferred.
 */
export class SqliteGraphApi implements RepositoryGraphApi {
  readonly #connection: Connection;
  readonly #statements: {
    readonly node: Database.Statement<[string], NodeRow>;
    readonly exists: Database.Statement<[string], { one: number }>;
    readonly outgoing: Database.Statement<[string], EdgeRow>;
    readonly incoming: Database.Statement<[string], EdgeRow>;
    readonly edgesByType: Database.Statement<[string], EdgeRow>;
    readonly nodesByKind: Database.Statement<[string], NodeRow>;
    readonly locations: Database.Statement<[string], LocationRow>;
    readonly locationsByKind: Database.Statement<[string], LocationRow>;
    readonly outgoingByType: Database.Statement<[string, string], EdgeRow>;
    readonly incomingByType: Database.Statement<[string, string], EdgeRow>;
    readonly roles: Database.Statement<[string], RoleRow>;
    readonly unresolved: Database.Statement<[], UnresolvedRow>;
  };

  private constructor(connection: Connection) {
    this.#connection = connection;

    // Prepared once and reused. Each read is a single indexed lookup, and ordering by
    // identifier is what makes the API deterministic without a caller sorting.
    this.#statements = {
      node: connection.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`),
      exists: connection.prepare('SELECT 1 AS one FROM nodes WHERE id = ?'),
      outgoing: connection.prepare(
        `SELECT ${EDGE_COLUMNS} FROM edges WHERE source_id = ? ORDER BY id`,
      ),
      incoming: connection.prepare(
        `SELECT ${EDGE_COLUMNS} FROM edges WHERE target_id = ? ORDER BY id`,
      ),
      edgesByType: connection.prepare(
        `SELECT ${EDGE_COLUMNS} FROM edges WHERE type = ? ORDER BY id`,
      ),
      nodesByKind: connection.prepare(
        `SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = ? ORDER BY id`,
      ),
      locations: connection.prepare(
        `SELECT node_id, start_line, start_column, end_line, end_column
         FROM node_locations WHERE node_id = ? ORDER BY ordinal`,
      ),
      locationsByKind: connection.prepare(
        `SELECT l.node_id, l.start_line, l.start_column, l.end_line, l.end_column
         FROM node_locations l JOIN nodes n ON n.id = l.node_id
         WHERE n.kind = ? ORDER BY l.node_id, l.ordinal`,
      ),
      // Separate statements rather than a nullable predicate, so each stays a plain
      // indexed lookup that SQLite can plan once.
      outgoingByType: connection.prepare(
        `SELECT ${EDGE_COLUMNS} FROM edges WHERE source_id = ? AND type = ? ORDER BY id`,
      ),
      incomingByType: connection.prepare(
        `SELECT ${EDGE_COLUMNS} FROM edges WHERE target_id = ? AND type = ? ORDER BY id`,
      ),
      roles: connection.prepare(
        `SELECT node_id, role, confidence, evidence FROM node_roles
         WHERE node_id = ? ORDER BY role`,
      ),
      unresolved: connection.prepare(
        `SELECT ${UNRESOLVED_COLUMNS} FROM unresolved_references ORDER BY id`,
      ),
    };
  }

  static open(filePath: string): SqliteGraphApi {
    try {
      return new SqliteGraphApi(new Database(filePath, { readonly: true, fileMustExist: true }));
    } catch (cause) {
      throw new GraphApiError(`the graph at ${filePath} could not be opened`, { cause });
    }
  }

  getNode(id: NodeId): GraphNode | null {
    const row = this.#statements.node.get(id);

    if (row === undefined) {
      return null;
    }

    return toNode(row, this.#statements.locations.all(id).map(toRange));
  }

  exists(id: NodeId): boolean {
    return this.#statements.exists.get(id) !== undefined;
  }

  getOutgoing(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    return type === undefined
      ? this.#statements.outgoing.all(id).map(toEdge)
      : this.#statements.outgoingByType.all(id, type).map(toEdge);
  }

  getIncoming(id: NodeId, type?: RelationshipType): readonly GraphEdge[] {
    return type === undefined
      ? this.#statements.incoming.all(id).map(toEdge)
      : this.#statements.incomingByType.all(id, type).map(toEdge);
  }

  getRoles(nodeId: NodeId): readonly GraphRole[] {
    return this.#statements.roles.all(nodeId).map((row) => ({
      nodeId: row.node_id as NodeId,
      role: row.role as Role,
      confidence: row.confidence as ConfidenceLevel,
      evidence: row.evidence,
    }));
  }

  /**
   * Reads the capability record written with the graph.
   *
   * Three small queries against tables that hold at most a few dozen rows, so it is not
   * cached here — `CachingGraph` above this memoises it for consumers that ask repeatedly.
   */
  getCapabilities(): RepositoryCapabilities {
    const languagesByRegion = new Map<string, LanguageFileCount[]>();

    for (const row of this.#connection
      .prepare(
        `SELECT region_path, language, files FROM region_languages
         ORDER BY files DESC, language ASC`,
      )
      .all() as readonly { region_path: string; language: string; files: number }[]) {
      const bucket = languagesByRegion.get(row.region_path) ?? [];

      bucket.push({ language: row.language, files: row.files });
      languagesByRegion.set(row.region_path, bucket);
    }

    const ecosystemsByRegion = new Map<string, string[]>();

    for (const row of this.#connection
      .prepare(`SELECT region_path, ecosystem FROM region_ecosystems ORDER BY ecosystem ASC`)
      .all() as readonly { region_path: string; ecosystem: string }[]) {
      const bucket = ecosystemsByRegion.get(row.region_path) ?? [];

      bucket.push(row.ecosystem);
      ecosystemsByRegion.set(row.region_path, bucket);
    }

    const regions = (
      this.#connection
        .prepare(
          `SELECT path, primary_language, file_count, source_file_count, analysis_depth, depth_reason
           FROM regions ORDER BY path ASC`,
        )
        .all() as readonly RegionRow[]
    ).map(
      (row): RegionCapability => ({
        path: row.path,
        primaryLanguage: row.primary_language,
        languages: languagesByRegion.get(row.path) ?? [],
        ecosystems: ecosystemsByRegion.get(row.path) ?? [],
        fileCount: row.file_count,
        sourceFileCount: row.source_file_count,
        depth: row.analysis_depth as AnalysisDepth,
        reason: row.depth_reason,
      }),
    );

    return summariseCapabilities(regions);
  }

  getUnresolved(): readonly GraphUnresolvedReference[] {
    return this.#statements.unresolved.all().map((row) => ({
      id: row.id,
      type: row.type as RelationshipType,
      sourceId: row.source_id as NodeId,
      name: row.name,
      reason: row.reason,
      text: row.text,
      provenance: {
        producer: row.provenance_resolver,
        fileId: row.provenance_file_id as NodeId,
        evidence: row.provenance_evidence,
      },
      location: toRange(row),
    }));
  }

  getEdges(type: RelationshipType): readonly GraphEdge[] {
    return this.#statements.edgesByType.all(type).map(toEdge);
  }

  /**
   * Locations are fetched in one query rather than one per node, so asking for a kind
   * costs two statements regardless of how many nodes it returns.
   */
  getNodes(kind: NodeKind): readonly GraphNode[] {
    const locations = new Map<string, SourceRange[]>();

    for (const row of this.#statements.locationsByKind.all(kind)) {
      const existing = locations.get(row.node_id);

      if (existing === undefined) {
        locations.set(row.node_id, [toRange(row)]);
      } else {
        existing.push(toRange(row));
      }
    }

    return this.#statements.nodesByKind.all(kind).map((row) => toNode(row, locations.get(row.id) ?? []));
  }

  close(): void {
    this.#connection.close();
  }
}

function toNode(row: NodeRow, locations: readonly SourceRange[]): GraphNode {
  return {
    id: row.id as NodeId,
    kind: row.kind as NodeKind,
    name: row.name,
    fileId: row.file_id as NodeId | null,
    containerChain: row.container_chain,
    visibility: row.visibility as GraphNode['visibility'],
    isExported: bool(row.is_exported) === true,
    isStatic: bool(row.is_static) === true,
    isAbstract: bool(row.is_abstract) === true,
    isReadonly: bool(row.is_readonly) === true,
    isOptional: bool(row.is_optional) === true,
    isAsync: bool(row.is_async) === true,
    isDeclarationFile: bool(row.is_declaration_file),
    hasSymbol: bool(row.has_symbol),
    isExportedFromModule: bool(row.is_exported_from_module),
    externalKind: row.external_kind as GraphNode['externalKind'],
    language: row.language,
    fileRole: row.file_role,
    category: row.category,
    artifactKind: row.artifact_kind,
    externalName: row.external_name,
    confidence: row.confidence as ConfidenceLevel,
    provenance: {
      producer: row.provenance_producer,
      fileId: row.provenance_file_id as NodeId | null,
      evidence: row.provenance_evidence,
    },
    locations,
  };
}

function toEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    type: row.type as RelationshipType,
    sourceId: row.source_id as NodeId,
    targetId: row.target_id as NodeId,
    name: row.name,
    confidence: row.confidence as ConfidenceLevel,
    candidateGroup: row.candidate_group,
    ordinal: row.ordinal,
    provenance: {
      producer: row.provenance_resolver,
      fileId: row.provenance_file_id as NodeId,
      evidence: row.provenance_evidence,
    },
    location: toRange(row),
  };
}

function toRange(row: {
  readonly start_line: number;
  readonly start_column: number;
  readonly end_line: number;
  readonly end_column: number;
}): SourceRange {
  return {
    startLine: row.start_line,
    startColumn: row.start_column,
    endLine: row.end_line,
    endColumn: row.end_column,
  };
}

/** SQLite has no boolean; `null` stays `null`, meaning not established. */
function bool(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}
