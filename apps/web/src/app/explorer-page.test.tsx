import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { edge, listing, node, SEARCH, SYMBOL_VIEW } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';
import type { FileView, PackageView } from '@/types/api';

import ExplorerPage from './explorer/page';

/**
 * The Explorer, end to end from `fetch` upwards.
 *
 * The milestone's claim is that this stops feeling like a file browser and starts answering "where should
 * I go?". That is mostly visual, so these tests hold the parts that are not: the navigation groups the
 * repository's own directories, nothing is invented where the API is silent, every empty state explains
 * itself, and a declaration can be read without leaving the page.
 */
const push = vi.fn();
const params = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  usePathname: () => '/explorer',
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => params.current,
}));

const PACKAGES = listing([
  { name: 'apps/api', files: 3, declarations: 40, dependencies: 1, dependents: 0 },
  { name: 'apps/web', files: 5, declarations: 60, dependencies: 0, dependents: 0 },
  { name: 'packages/core', files: 2, declarations: 140, dependencies: 0, dependents: 2 },
]);

const CORE: PackageView = {
  name: 'packages/core',
  files: listing([
    node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null }),
    node({ id: 'file:packages/core/index.ts', kind: 'File', fileId: null }),
  ]),
  dependencies: listing([]),
  dependents: listing([{ name: 'apps/api', edges: listing([edge({ id: 'd1' })], 4) }]),
  externalPackages: listing([]),
  roles: { Controller: [], Service: [], Repository: [], Middleware: [], Model: [], Test: [] },
  statistics: { files: 2, declarations: 140, declarationsByKind: { Function: 120, Class: 20 } },
  limitations: [],
};

const SERVICE_FILE: FileView = {
  file: node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null }),
  packageName: 'packages/core',
  // A source file, so artefact analysis classified nothing: its structure is the language analysers' to
  // produce. `null` is what the panel reads as "this is a source file", not as "nothing is known".
  artifact: null,
  declarations: listing([
    node({ id: 'sym:packages/core/src/service.ts#UserService', kind: 'Class', name: 'UserService' }),
    node({ id: 'sym:packages/core/src/service.ts#helper', kind: 'Function', name: 'helper' }),
  ]),
  imports: listing([]),
  exports: listing([]),
  externalPackages: listing([]),
  routes: listing([]),
  environmentVariables: listing([]),
  statistics: {
    declarations: 2,
    imports: 0,
    exports: 0,
    fanIn: 3,
    fanOut: 1,
    declarationsByKind: { Class: 1, Function: 1 },
  },
};

let stub: FetchStub | undefined;

beforeEach(() => {
  params.current = new URLSearchParams();
  push.mockClear();
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/**
 * The wide arrangement.
 *
 * Both arrangements are in the DOM — a breakpoint hides one, and jsdom applies no breakpoints — so every
 * query has to say which it means. In a browser only one is rendered to the accessibility tree.
 */
function wide() {
  const layout = document.querySelector('[data-layout="wide"]');

  if (layout === null) {
    throw new Error('the wide layout is not rendered');
  }

  return within(layout as HTMLElement);
}


/**
 * A workflow file: no declarations, and everything a reader needs anyway.
 *
 * **The fixture that names the milestone.** Every code statistic on it is zero, which is exactly what the
 * old panel showed — six zeroes and "This file declares nothing" over a file that declares four things and
 * runs two scripts.
 */
const WORKFLOW_FILE: FileView = {
  file: node({ id: 'file:.github/workflows/ci.yml', kind: 'File', fileId: null }),
  packageName: '.github/workflows',
  artifact: {
    kind: 'ci-workflow',
    format: 'yaml',
    role: 'configuration',
    summary: {
      kind: 'ci-workflow',
      role: 'configuration',
      defines: [
        { kind: 'job', count: 2 },
        { kind: 'step', count: 4 },
      ],
      configures: [],
      reaches: [{ type: 'RUNS', count: 1 }],
      referencedBy: 1,
      variables: ['NPM_TOKEN'],
      position: 'in .github/workflows, 2 levels deep',
      established: true,
    },
    sections: [
      {
        title: 'jobs',
        elements: [
          {
            node: node({ id: 'art:.github/workflows/ci.yml#job:jobs:verify', kind: 'ArtifactElement', name: 'verify' }),
            kind: 'job',
            name: 'verify',
            detail: 'runs on ubuntu-latest',
            line: 6,
            requires: [],
          },
          {
            node: node({ id: 'art:.github/workflows/ci.yml#job:jobs:ship', kind: 'ArtifactElement', name: 'ship' }),
            kind: 'job',
            name: 'ship',
            detail: 'runs on ubuntu-latest',
            line: 14,
            requires: [node({ id: 'art:.github/workflows/ci.yml#job:jobs:verify', kind: 'ArtifactElement', name: 'verify' })],
          },
        ],
      },
    ],
    references: listing([
      {
        type: 'RUNS',
        node: node({ id: 'file:tools/ship.sh', kind: 'File', fileId: null, name: 'tools/ship.sh' }),
        via: node({ id: 'art:.github/workflows/ci.yml#command:jobs.ship:bash tools/ship.sh', kind: 'ArtifactElement', name: 'bash tools/ship.sh' }),
        confidence: 'INFERRED',
        evidence: 'invoked by ship: bash tools/ship.sh; resolved to tools/ship.sh',
      },
    ]),
    referencedBy: listing([
      {
        type: 'DOCUMENTS',
        node: node({ id: 'file:README.md', kind: 'File', fileId: null, name: 'README.md' }),
        via: null,
        confidence: 'RESOLVED',
        evidence: 'linked from this document; resolved to .github/workflows/ci.yml',
      },
    ]),
    unresolved: listing([
      {
        type: 'RUNS',
        text: './tools/gone.sh',
        reason: 'artefact-path-matches-no-file',
        evidence: 'invoked by ship; no file in the repository has this path',
      },
    ]),
    boundary:
      'Read as indentation structure: jobs, their declared prerequisites and their steps. Matrix expansion was not performed.',
  },
  declarations: listing([]),
  imports: listing([]),
  exports: listing([]),
  externalPackages: listing([]),
  routes: listing([]),
  environmentVariables: listing([]),
  statistics: {
    declarations: 0,
    imports: 0,
    exports: 0,
    fanIn: 0,
    fanOut: 0,
    declarationsByKind: {},
  },
};

/**
 * Paths are spelled out in full rather than as short prefixes.
 *
 * The harness matches a stub as a substring of the request URL, longest wins — and a file request is
 * `/api/files/packages/core/…` — only `#` is escaped — which contains `/packages`. A `/files/` stub loses to the
 * package-listing stub and the file panel is handed the wrong payload.
 */
/**
 * Opens a tab in the wide layout.
 *
 * `userEvent.click` does not switch these: the page renders both the wide and the narrow arrangement, and
 * with two live Radix tab lists in one document the synthesised pointer sequence does not reach the
 * intended trigger. Radix activates on mouse-down, so dispatching that directly is both sufficient and
 * closer to what the component actually listens for.
 */
function openTab(name: string): void {
  const tab = wide().getAllByRole('tab', { name: new RegExp(`^${name}`) })[0] as HTMLElement;

  fireEvent.mouseDown(tab);
}

function render(): void {
  stub = stubFetch([
    { path: '/packages/packages/core', data: CORE },
    { path: '/packages', data: PACKAGES },
    { path: '/files/packages/core/src/service.ts', data: SERVICE_FILE },
    { path: '/files/.github/workflows/ci.yml', data: WORKFLOW_FILE },
    { path: '/symbol/', data: SYMBOL_VIEW },
    { path: '/search', data: SEARCH },
  ]);

  renderWithQuery(<ExplorerPage />);
}

describe('Explorer', () => {
  it('opens with a heading that says what this page is for', async () => {
    render();

    expect(screen.getByRole('heading', { level: 1, name: 'Repository Navigation' })).toBeInTheDocument();
    expect(screen.getByText(/packages, the modules inside them and the declarations/)).toBeInTheDocument();
    await wide().findAllByRole('button', { name: /^apps,/ });
  });

  it('puts a search box at the top, naming everything it searches', () => {
    render();

    expect(screen.getByRole('textbox', { name: 'Search files, declarations and packages' })).toHaveAttribute(
      'placeholder',
      'Search files, declarations, packages...',
    );
  });

  describe('navigation', () => {
    it('groups packages by the repository’s own directories', async () => {
      render();

      // `apps` and `packages` are directories in the payload — not categories chosen here.
      expect(await wide().findByRole('button', { name: /^apps,/ })).toBeInTheDocument();
      expect(wide().getByRole('button', { name: /^packages,/ })).toBeInTheDocument();
    });

    it('does not show every package at once — only the largest group starts open', async () => {
      render();

      const packagesGroup = await wide().findByRole('button', { name: /^packages,/ });
      const appsGroup = wide().getByRole('button', { name: /^apps,/ });

      // `packages/core` has the most declarations, so its group opens and `apps` stays closed.
      expect(packagesGroup).toHaveAttribute('aria-expanded', 'true');
      expect(appsGroup).toHaveAttribute('aria-expanded', 'false');
      expect(wide().queryByText('api')).not.toBeInTheDocument();
    });

    it('expands a group when asked', async () => {
      const user = userEvent.setup();

      render();

      await user.click(await wide().findByRole('button', { name: /^apps,/ }));

      expect(wide().getByRole('listbox', { name: 'Packages in apps' })).toBeInTheDocument();
      expect(wide().getByText('api')).toBeInTheDocument();
    });

    it('selects a package through the URL, so the view can be shared', async () => {
      const user = userEvent.setup();

      render();

      await user.click(await wide().findByText('core'));

      expect(push).toHaveBeenCalledWith('/explorer?package=packages%2Fcore');
    });
  });

  describe('with nothing selected', () => {
    it('teaches instead of showing an empty screen', async () => {
      render();

      expect(wide().getByRole('heading', { name: 'Repository Explorer' })).toBeInTheDocument();
      expect(wide().getByText(/Choose a package to inspect/)).toBeInTheDocument();
      // The three steps a reader will take.
      expect(wide().getByText('Pick a package')).toBeInTheDocument();
      expect(wide().getByText('Open a file')).toBeInTheDocument();
      expect(wide().getByText('Select a declaration')).toBeInTheDocument();
      await wide().findAllByRole('button', { name: 'Open packages/core' });
    });

    it('suggests real packages from this repository, never invented ones', async () => {
      render();

      const names = PACKAGES.entries.map((entry) => entry.name);
      const suggestions = (await wide().findAllByRole('button', { name: /^Open / })).map((button) =>
        (button.getAttribute('aria-label') ?? '').replace('Open ', ''),
      );

      // Read from the label rather than parsed out of the visible text, which also carries the counts.
      expect(suggestions.length).toBeGreaterThan(0);
      for (const suggestion of suggestions) {
        expect(names).toContain(suggestion);
      }
    });

    it('never says "No data" or "Nothing selected"', async () => {
      render();

      await wide().findByRole('heading', { name: 'Repository Explorer' });

      expect(document.body.textContent ?? '').not.toMatch(/No data|Nothing selected/);
    });
  });

  describe('with a package selected', () => {
    beforeEach(() => {
      params.current = new URLSearchParams('package=packages/core');
    });

    it('shows what the package holds', async () => {
      render();

      expect(await wide().findByRole('heading', { level: 2, name: 'packages/core' })).toBeInTheDocument();
      expect(wide().getByText('Directories')).toBeInTheDocument();
      expect(wide().getByText('Important declarations')).toBeInTheDocument();
      expect(wide().getByText('Depended on by')).toBeInTheDocument();
    });

    it('degrades the description rather than writing one from the package name', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: 'packages/core' });

      expect(wide().getByText('Description —')).toBeInTheDocument();
      expect(wide().getByText('Available after Repository Intelligence generation.')).toBeInTheDocument();
    });

    it('reads directories back from the file paths', async () => {
      render();

      // `src/service.ts` and `index.ts` — one nested directory and one file at the package root.
      expect(await wide().findByText('packages/core/src/')).toBeInTheDocument();
      expect(wide().getByText('packages/core/')).toBeInTheDocument();
    });

    it('explains an absence of roles rather than showing a blank card', async () => {
      render();

      expect(await wide().findByText(/Roles are annotations the analysis adds/)).toBeInTheDocument();
    });
  });

  describe('with a file selected', () => {
    beforeEach(() => {
      params.current = new URLSearchParams('package=packages/core&file=packages/core/src/service.ts');
    });

    it('shows the file, its package and its counts', async () => {
      render();

      expect(
        await wide().findByRole('heading', { level: 2, name: 'packages/core/src/service.ts' }),
      ).toBeInTheDocument();
      expect(wide().getByText('Imports')).toBeInTheDocument();
      expect(wide().getByText('Exports')).toBeInTheDocument();
    });

    /**
     * `GET /impact/{id}` accepts only a `sym:` identifier — a `file:` one is rejected. The button has to
     * say so rather than linking somewhere that cannot answer.
     */
    it('disables Impact for a file, with the reason', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: 'packages/core/src/service.ts' });

      const impact = wide().getByRole('button', { name: /^Impact/ });

      expect(impact).toBeDisabled();
      expect(impact).toHaveAccessibleName(/impact is analysed per declaration/);
    });

    it('asks TraceIQ about this file, not about the repository', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: 'packages/core/src/service.ts' });

      expect(wide().getByRole('link', { name: 'Ask TraceIQ' })).toHaveAttribute(
        'href',
        expect.stringContaining('subject=file%3Apackages%2Fcore%2Fsrc%2Fservice.ts'),
      );
    });

    it('opens a declaration in place rather than navigating away', async () => {
      const user = userEvent.setup();

      render();

      await user.click(await wide().findByRole('button', { name: /UserService/ }));

      expect(push).toHaveBeenCalledWith(expect.stringContaining('symbol=sym%3A'));
      expect(push).toHaveBeenCalledWith(expect.stringContaining('/explorer?'));
    });
  });


  /**
   * The artefact panel: what the centre pane shows for a file that declares no code.
   *
   * The layout is deliberately unchanged — same header, same badges, same tab strip — so these tests are
   * about the *information*, which is the only thing this milestone moved.
   */
  describe('with an artefact selected', () => {
    beforeEach(() => {
      params.current = new URLSearchParams('file=.github/workflows/ci.yml');
    });

    it('names the artefact family instead of the word "File"', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });
      expect(wide().getByText('ci-workflow')).toBeInTheDocument();
    });

    it('summarises what the artefact declares rather than showing six zeroes', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });
      // Assembled from graph facts, never generated: see `ArtifactSummary`.
      expect(wide().getByText(/declaring 2 jobs, 4 steps/)).toBeInTheDocument();
      expect(wide().getByText(/in \.github\/workflows, 2 levels deep/)).toBeInTheDocument();
    });

    it('leads with the structure, and shows what the artefact declares', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });
      expect(wide().getByText('verify')).toBeInTheDocument();
      expect(wide().getByText('ship')).toBeInTheDocument();
      // Two jobs share a `runs-on`, so the detail line appears twice — which is correct, and the assertion
      // is about it appearing at all.
      expect(wide().getAllByText('runs on ubuntu-latest').length).toBe(2);
    });

    it('shows only the ordering the artefact declared, and says who declared it', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });
      // `ship` needs `verify`; `verify` needs nothing, and appears above `ship` in the file — position is
      // not evidence and nothing here presents it as any.
      expect(wide().getByText(/needs verify/)).toBeInTheDocument();
      expect(wide().getByText(/declared by this artefact/)).toBeInTheDocument();
    });

    it('states where the reading stopped, so an artefact is never silently empty', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });
      expect(wide().getByText(/Matrix expansion was not performed/)).toBeInTheDocument();
    });

    it('never says a file with no declarations declares nothing', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });

      // The sentence this milestone exists to delete.
      expect(wide().queryByText('This file declares nothing')).not.toBeInTheDocument();

      openTab('Declarations');
      expect(
        wide().getByText('No source-code declarations were extracted from this file'),
      ).toBeInTheDocument();
      expect(wide().getByText(/What it declares is on the Structure tab/)).toBeInTheDocument();
    });

    it('shows what it runs and what documents it, with the evidence for each', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });

      openTab('References');
      expect(wide().getByText('runs')).toBeInTheDocument();
      expect(wide().getByText(/resolved to tools\/ship\.sh/)).toBeInTheDocument();

      openTab('Referenced by');
      expect(wide().getByText('documents')).toBeInTheDocument();
    });

    it('shows what the artefact named that resolved to nothing', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: '.github/workflows/ci.yml' });

      openTab('Unresolved');
      // A workflow invoking a script that no longer exists is one of the more useful things an analysis can
      // report, and dropping it would make an absent RUNS edge indistinguishable from an absent command.
      expect(wide().getByText('./tools/gone.sh')).toBeInTheDocument();
    });
  });

  describe('with a declaration selected', () => {
    beforeEach(() => {
      params.current = new URLSearchParams(
        'package=packages/core&file=packages/core/src/service.ts&symbol=sym:packages/core/src/service.ts#UserService.find',
      );
    });

    it('shows the declaration, its kind, package and file', async () => {
      render();

      expect(await wide().findByRole('heading', { level: 2, name: 'UserService.find' })).toBeInTheDocument();
      expect(wide().getByText('Method')).toBeInTheDocument();
      expect(wide().getByText('packages/core')).toBeInTheDocument();
      expect(wide().getByRole('button', { name: 'packages/core/src/service.ts' })).toBeInTheDocument();
    });

    it('keeps dependents, dependencies and references apart', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: 'UserService.find' });

      expect(wide().getByText(/^Dependents/)).toBeInTheDocument();
      expect(wide().getByText(/^Dependencies/)).toBeInTheDocument();
      expect(wide().getByText(/^References/)).toBeInTheDocument();
    });

    /** The fixture's one outgoing call has a `null` target — an edge whose other end is unnamed. */
    it('reports an edge whose other end the analysis could not name', async () => {
      render();

      expect(await wide().findByText(/1 further edge exists whose other end/)).toBeInTheDocument();
    });

    it('offers all four actions, each pointing somewhere real', async () => {
      render();

      await wide().findByRole('heading', { level: 2, name: 'UserService.find' });

      expect(wide().getByRole('link', { name: /^Impact/ })).toHaveAttribute(
        'href',
        expect.stringContaining('/impact?id=sym%3A'),
      );
      expect(wide().getByRole('link', { name: /^Search/ })).toHaveAttribute('href', expect.stringContaining('/search?q='));
      expect(wide().getByRole('link', { name: 'Ask TraceIQ' })).toHaveAttribute(
        'href',
        expect.stringContaining('subject=sym%3A'),
      );
      expect(wide().getByRole('link', { name: /^Architecture/ })).toHaveAttribute('href', '/architecture');
    });
  });

  describe('tips', () => {
    it('explains the vocabulary the rest of the page uses', async () => {
      render();

      expect(wide().getByText('What a package is')).toBeInTheDocument();
      expect(wide().getByText('What a declaration is')).toBeInTheDocument();
      expect(wide().getByText('How to navigate')).toBeInTheDocument();
      expect(wide().getByText('How to use Impact')).toBeInTheDocument();
      expect(wide().getByText('How to use Ask TraceIQ')).toBeInTheDocument();
      await wide().findAllByRole('button', { name: /^apps,/ });
    });
  });

  describe('search', () => {
  /**
   * Typing is driven with `fireEvent.change`, not `userEvent.type`, and the reason is worth recording.
   *
   * Inside the full page render under jsdom, `userEvent.type` never focuses this input — `activeElement`
   * stays off it and no value lands — while the very same component reached directly, with the very same
   * interaction, types fine. The input node is not replaced between keystrokes, so it is not a remount.
   * Delivering the change event asserts what the product actually does with the input: the state updates
   * and the navigation narrows. The keyboard path itself is verified in a real browser instead, which is
   * the only place a focus problem would matter.
   */
    it('filters the navigation as you type, without a request', async () => {
      render();

      await wide().findByRole('button', { name: /^apps,/ });
      fireEvent.change(screen.getByRole('textbox', { name: /^Search files/ }), { target: { value: 'apps' } });

      await waitFor(() => {
        expect(wide().queryByRole('button', { name: /^packages,/ })).not.toBeInTheDocument();
      });
    });

    it('explains why a search found nothing, instead of saying "no results"', async () => {
      stub = stubFetch([
        { path: '/packages', data: PACKAGES },
        { path: '/search', data: { ...SEARCH, declarations: listing([]), files: listing([]), total: 0 } },
      ]);

      renderWithQuery(<ExplorerPage />);

      await wide().findByRole('button', { name: /^packages,/ });
      fireEvent.change(screen.getByRole('textbox', { name: /^Search files/ }), { target: { value: 'zzz' } });

      expect(await screen.findByText(/Matching is exact\s+or by prefix/)).toBeInTheDocument();
    });
  });
});
