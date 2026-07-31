import { RepositoryContextBuilder } from '@traceiq/context';
import { SymbolExplainer } from '@traceiq/explain';
import { RepositoryHealthAnalyzer } from '@traceiq/health';
import { CachingGraph, RepositoryExplorer } from '@traceiq/explorer';
import { ImpactAnalyzer } from '@traceiq/impact';
import { RepositoryNavigator } from '@traceiq/navigation';
import type { RepositorySession } from '@traceiq/pipeline';
import { QueryEngine } from '@traceiq/query';

/**
 * The capabilities one command invocation may use, over one shared graph read.
 *
 * Every capability is constructed over a single `CachingGraph`, so a command that reaches for two of
 * them reads the database once. Each is built **lazily**: a command that needs only the explorer
 * never constructs an impact analyser, and `traceiq routes` never builds a health report.
 *
 * **This owns no global state.** One is created per invocation and discarded with it, so nothing
 * survives a command and two invocations cannot interfere. The CLI has no singleton.
 */
export class CommandSession {
  readonly #graph: CachingGraph;

  #explorer: RepositoryExplorer | null = null;
  #navigator: RepositoryNavigator | null = null;
  #impact: ImpactAnalyzer | null = null;
  #health: RepositoryHealthAnalyzer | null = null;
  #context: RepositoryContextBuilder | null = null;

  constructor(session: RepositorySession) {
    this.#graph = new CachingGraph(session.api);
  }

  explorer(): RepositoryExplorer {
    this.#explorer ??= new RepositoryExplorer(this.#graph);

    return this.#explorer;
  }

  navigator(): RepositoryNavigator {
    this.#navigator ??= new RepositoryNavigator(this.#graph);

    return this.#navigator;
  }

  /**
   * The context builder, over the same shared graph.
   *
   * The **only** thing `chat` receives from this class. It is handed to `RepositoryAnswerer` as a
   * `ContextSource`, which has one method — so the chat mode cannot traverse, query, search or reach a
   * capability directly, and `chat.ts` imports no graph type at all.
   */
  context(): RepositoryContextBuilder {
    if (this.#context === null) {
      const queries = new QueryEngine(this.#graph);

      this.#context = new RepositoryContextBuilder({
        explorer: this.explorer(),
        explain: new SymbolExplainer(queries),
        impact: new ImpactAnalyzer(queries),
        health: this.health(),
        queries,
      });
    }

    return this.#context;
  }

  /** Full Impact Analysis. The explorer carries only a summary. */
  impact(): ImpactAnalyzer {
    this.#impact ??= new ImpactAnalyzer(new QueryEngine(this.#graph));

    return this.#impact;
  }

  /** The full health report. The explorer's overview carries only a summary. */
  health(): RepositoryHealthAnalyzer {
    this.#health ??= new RepositoryHealthAnalyzer(this.#graph);

    return this.#health;
  }

  /**
   * Reads that reached the database.
   *
   * Only the count of distinct reads is reported. A hit rate would be misleading here: each
   * capability keeps its own cache underneath this one, so repeats are absorbed a level down and
   * never reach this counter. What this measures — how much of the database one command touched — is
   * exactly what the shared cache exists to reduce.
   */
  profile(): { readonly graphApiCalls: number } {
    return { graphApiCalls: this.#graph.graphCalls };
  }
}
