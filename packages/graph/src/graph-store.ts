import Database from 'better-sqlite3';

import { SCHEMA_STATEMENTS, SCHEMA_VERSION, TRUNCATE_STATEMENTS } from './schema.js';
import type { RepositoryGraph } from './types.js';

type Connection = Database.Database;

export class GraphStoreError extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`Cannot write the repository graph: ${reason}`, options);
    this.name = 'GraphStoreError';
  }
}

/**
 * Owns the SQLite database: its schema, its pragmas and its transactions.
 *
 * The only writer of the graph. It contains no translation logic — it is handed a
 * `RepositoryGraph` and persists it — so the schema stays an implementation detail
 * that nothing above this module needs to know.
 *
 * There is no read API. Reading the graph is the Query Engine's responsibility, and
 * providing a shortcut here would let features bypass it.
 */
export class GraphStore {
  readonly #connection: Connection;

  private constructor(connection: Connection) {
    this.#connection = connection;
  }

  /**
   * Opens a database, creating the schema when it is new.
   *
   * `:memory:` is accepted, which is what makes persistence testable without
   * touching the filesystem.
   */
  static open(filePath: string): GraphStore {
    let connection: Connection;

    try {
      connection = new Database(filePath);
    } catch (cause) {
      throw new GraphStoreError(`the database at ${filePath} could not be opened`, { cause });
    }

    // Referential integrity is mandatory (spec §8.1) and SQLite leaves it off by
    // default, so an unenforced database would silently accept a dangling edge.
    connection.pragma('foreign_keys = ON');

    const store = new GraphStore(connection);

    store.#initialise(filePath);

    return store;
  }

  /**
   * Replaces the graph in one transaction.
   *
   * A partially written graph must never be observable, so either every row lands or
   * none does. better-sqlite3's `transaction` rolls back on any thrown error,
   * including a constraint violation.
   *
   * `createdAt` is supplied by the caller rather than read from the clock here. The
   * translated graph is deterministic, and a timestamp minted inside the store would
   * make otherwise identical writes differ — so the one genuinely time-dependent
   * value is the caller's to provide.
   */
  write(graph: RepositoryGraph, createdAt: string): void {
    const run = this.#connection.transaction((value: RepositoryGraph) => {
      this.#replaceAll(value, createdAt);
    });

    try {
      run(graph);
    } catch (cause) {
      throw new GraphStoreError('the transaction was rolled back', { cause });
    }
  }

  close(): void {
    this.#connection.close();
  }

  #initialise(filePath: string): void {
    const existing = this.#connection
      .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE name = 'repository'`)
      .get();

    if (existing === undefined) {
      const create = this.#connection.transaction(() => {
        for (const statement of SCHEMA_STATEMENTS) {
          this.#connection.exec(statement);
        }
      });

      create();

      return;
    }

    const row = this.#connection
      .prepare<[], { schema_version: number }>('SELECT schema_version FROM repository')
      .get();

    // A database from a different schema version is refused rather than
    // misinterpreted. Nothing migrates yet, because nothing has shipped.
    if (row !== undefined && row.schema_version !== SCHEMA_VERSION) {
      throw new GraphStoreError(
        `the database at ${filePath} uses schema version ${row.schema_version}, but this build expects ${SCHEMA_VERSION}`,
      );
    }
  }

  /**
   * Insert order follows the foreign keys: revisions, then `File` nodes, then every
   * other node, then the tables that reference nodes. Nothing is deferred, so a
   * dangling reference fails at the statement that caused it.
   */
  #replaceAll(graph: RepositoryGraph, createdAt: string): void {
    for (const statement of TRUNCATE_STATEMENTS) {
      this.#connection.exec(statement);
    }

    this.#connection
      .prepare(
        `INSERT INTO revisions (id, created_at, source_hash) VALUES (?, ?, NULL)`,
      )
      .run(graph.revisionId, createdAt);

    this.#connection
      .prepare(
        `INSERT INTO repository (id, name, root_path, schema_version) VALUES (1, ?, ?, ?)`,
      )
      .run(graph.repository.name, graph.repository.rootPath, SCHEMA_VERSION);

    const insertNode = this.#connection.prepare(
      `INSERT INTO nodes (
         id, kind, name, file_id, container_chain, visibility,
         is_exported, is_static, is_abstract, is_readonly, is_optional, is_async,
         is_declaration_file, has_symbol, is_exported_from_module,
         external_kind, external_name, confidence,
         provenance_producer, provenance_file_id, provenance_evidence, revision_id
       ) VALUES (
         @id, @kind, @name, @fileId, @containerChain, @visibility,
         @isExported, @isStatic, @isAbstract, @isReadonly, @isOptional, @isAsync,
         @isDeclarationFile, @hasSymbol, @isExportedFromModule,
         @externalKind, @externalName, @confidence,
         @producer, @provenanceFileId, @evidence, @revisionId
       )`,
    );

    const insertLocation = this.#connection.prepare(
      `INSERT INTO node_locations (node_id, ordinal, start_line, start_column, end_line, end_column)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // Files first: every declaration node's file_id references one. Sorted here
    // rather than trusting the builder's order, so the store does not depend on it.
    for (const node of [...graph.nodes].sort(filesFirst)) {
      insertNode.run({
        id: node.id,
        kind: node.kind,
        name: node.name,
        fileId: node.fileId,
        containerChain: node.containerChain,
        visibility: node.visibility,
        isExported: flag(node.isExported),
        isStatic: flag(node.isStatic),
        isAbstract: flag(node.isAbstract),
        isReadonly: flag(node.isReadonly),
        isOptional: flag(node.isOptional),
        isAsync: flag(node.isAsync),
        isDeclarationFile: flag(node.isDeclarationFile),
        hasSymbol: flag(node.hasSymbol),
        isExportedFromModule: flag(node.isExportedFromModule),
        externalKind: node.externalKind,
        externalName: node.externalName,
        confidence: node.confidence,
        producer: node.provenance.producer,
        provenanceFileId: node.provenance.fileId,
        evidence: node.provenance.evidence,
        revisionId: graph.revisionId,
      });

      node.locations.forEach((location, ordinal) => {
        insertLocation.run(
          node.id,
          ordinal,
          location.startLine,
          location.startColumn,
          location.endLine,
          location.endColumn,
        );
      });
    }

    const insertFileRevision = this.#connection.prepare(
      `INSERT INTO file_revisions (revision_id, file_id, content_hash) VALUES (?, ?, NULL)`,
    );

    for (const fileId of graph.fileIds) {
      insertFileRevision.run(graph.revisionId, fileId);
    }

    const insertEdge = this.#connection.prepare(
      `INSERT INTO edges (
         id, type, source_id, target_id, name, confidence, candidate_group, ordinal,
         provenance_resolver, provenance_file_id, provenance_evidence,
         start_line, start_column, end_line, end_column, revision_id
       ) VALUES (
         @id, @type, @sourceId, @targetId, @name, @confidence, @candidateGroup, @ordinal,
         @producer, @provenanceFileId, @evidence,
         @startLine, @startColumn, @endLine, @endColumn, @revisionId
       )`,
    );

    for (const edge of graph.edges) {
      insertEdge.run({
        id: edge.id,
        type: edge.type,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        name: edge.name,
        confidence: edge.confidence,
        candidateGroup: edge.candidateGroup,
        ordinal: edge.ordinal,
        producer: edge.provenance.producer,
        provenanceFileId: edge.provenance.fileId,
        evidence: edge.provenance.evidence,
        startLine: edge.location.startLine,
        startColumn: edge.location.startColumn,
        endLine: edge.location.endLine,
        endColumn: edge.location.endColumn,
        revisionId: graph.revisionId,
      });
    }

    const insertUnresolved = this.#connection.prepare(
      `INSERT INTO unresolved_references (
         id, type, source_id, name, reason, text,
         provenance_resolver, provenance_file_id, provenance_evidence,
         start_line, start_column, end_line, end_column, revision_id
       ) VALUES (
         @id, @type, @sourceId, @name, @reason, @text,
         @producer, @provenanceFileId, @evidence,
         @startLine, @startColumn, @endLine, @endColumn, @revisionId
       )`,
    );

    for (const reference of graph.unresolved) {
      insertUnresolved.run({
        id: reference.id,
        type: reference.type,
        sourceId: reference.sourceId,
        name: reference.name,
        reason: reference.reason,
        text: reference.text,
        producer: reference.provenance.producer,
        provenanceFileId: reference.provenance.fileId,
        evidence: reference.provenance.evidence,
        startLine: reference.location.startLine,
        startColumn: reference.location.startColumn,
        endLine: reference.location.endLine,
        endColumn: reference.location.endColumn,
        revisionId: graph.revisionId,
      });
    }

    const insertRole = this.#connection.prepare(
      `INSERT INTO node_roles (node_id, role, confidence, evidence) VALUES (?, ?, ?, ?)`,
    );

    for (const role of graph.roles) {
      insertRole.run(role.nodeId, role.role, role.confidence, role.evidence);
    }
  }
}

/** SQLite has no boolean type; `null` stays `null`, meaning not established. */
function flag(value: boolean | null): number | null {
  if (value === null) {
    return null;
  }

  return value ? 1 : 0;
}

function filesFirst(left: { kind: string }, right: { kind: string }): number {
  const rank = (kind: string): number => (kind === 'File' ? 0 : 1);

  return rank(left.kind) - rank(right.kind);
}
