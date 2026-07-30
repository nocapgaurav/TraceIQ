import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listing, node } from '@/test/fixtures';
import { renderWithQuery, stubFetch, type FetchStub } from '@/test/harness';
import type { PackageView } from '@/types/api';

import { FileTree, PackageTree, SymbolList } from './trees';

/**
 * The Explorer's panes.
 *
 * Each pane is a `listbox`, so these tests assert the accessible contract — options, selection and
 * keyboard reachability — rather than the styling that expresses it visually.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/explorer',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const PACKAGES = listing([
  { name: 'packages/api', files: 8, declarations: 90, dependencies: 1, dependents: 0 },
  { name: 'packages/core', files: 10, declarations: 140, dependencies: 0, dependents: 1 },
]);

const PACKAGE_VIEW: PackageView = {
  name: 'packages/core',
  files: listing([
    node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null }),
    node({ id: 'file:packages/core/src/util.ts', kind: 'File', fileId: null }),
  ]),
  dependencies: listing([]),
  dependents: listing([]),
  externalPackages: listing([]),
  roles: { Controller: [], Service: [], Repository: [], Middleware: [], Model: [], Test: [] },
  statistics: { files: 2, declarations: 12, declarationsByKind: { Function: 12 } },
  limitations: [],
};

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('PackageTree', () => {
  it('lists packages as options with their file counts', async () => {
    stub = stubFetch([{ path: '/packages', data: PACKAGES }]);

    renderWithQuery(<PackageTree selected={null} onSelect={() => {}} />);

    expect(await screen.findByRole('listbox', { name: 'Packages' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('packages/core')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('marks the selected package', async () => {
    stub = stubFetch([{ path: '/packages', data: PACKAGES }]);

    renderWithQuery(<PackageTree selected="packages/core" onSelect={() => {}} />);

    await screen.findByRole('listbox', { name: 'Packages' });

    const selected = screen.getAllByRole('option').filter((option) => option.getAttribute('aria-selected') === 'true');

    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('packages/core');
  });

  it('reports a choice made with the keyboard', async () => {
    stub = stubFetch([{ path: '/packages', data: PACKAGES }]);
    const onSelect = vi.fn();

    renderWithQuery(<PackageTree selected={null} onSelect={onSelect} />);
    await screen.findByRole('listbox', { name: 'Packages' });

    const buttons = screen.getAllByRole('button');

    buttons[0]?.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('packages/api');
  });

  it('says so when the repository derived no packages', async () => {
    stub = stubFetch([{ path: '/packages', data: listing([]) }]);

    renderWithQuery(<PackageTree selected={null} onSelect={() => {}} />);

    expect(await screen.findByText('No packages')).toBeInTheDocument();
  });
});

describe('FileTree', () => {
  it('asks for nothing until a package is chosen', () => {
    stub = stubFetch([]);

    renderWithQuery(<FileTree packageName={null} selected={null} onSelect={() => {}} />);

    expect(screen.getByText('Choose a package')).toBeInTheDocument();
    expect(stub.calls).toEqual([]);
  });

  it('shows a file’s path relative to its package, since the package is the pane above', async () => {
    stub = stubFetch([{ path: '/packages/packages/core', data: PACKAGE_VIEW }]);

    renderWithQuery(<FileTree packageName="packages/core" selected={null} onSelect={() => {}} />);

    expect(await screen.findByText('src/service.ts')).toBeInTheDocument();
    expect(screen.queryByText('packages/core/src/service.ts')).not.toBeInTheDocument();
  });

  it('reports the full path when a file is chosen, not the shortened one', async () => {
    stub = stubFetch([{ path: '/packages/packages/core', data: PACKAGE_VIEW }]);
    const onSelect = vi.fn();

    renderWithQuery(<FileTree packageName="packages/core" selected={null} onSelect={onSelect} />);

    await userEvent.click(await screen.findByText('src/service.ts'));

    expect(onSelect).toHaveBeenCalledWith('packages/core/src/service.ts');
  });
});

describe('SymbolList', () => {
  it('groups declarations by kind, with a count per group', () => {
    renderWithQuery(
      <SymbolList
        declarations={[
          node({ id: 'sym:a.ts#one', kind: 'Function' }),
          node({ id: 'sym:a.ts#two', kind: 'Function' }),
          node({ id: 'sym:a.ts#Three', kind: 'Class' }),
        ]}
      />,
    );

    expect(screen.getByText('Function (2)')).toBeInTheDocument();
    expect(screen.getByText('Class (1)')).toBeInTheDocument();
  });

  it('orders groups by kind so the same file always reads the same way', () => {
    renderWithQuery(
      <SymbolList
        declarations={[node({ id: 'sym:a.ts#z', kind: 'Variable' }), node({ id: 'sym:a.ts#A', kind: 'Class' })]}
      />,
    );

    const headings = screen.getAllByText(/^(Class|Variable) \(/).map((element) => element.textContent);

    expect(headings).toEqual(['Class (1)', 'Variable (1)']);
  });

  it('says so for an empty file', () => {
    renderWithQuery(<SymbolList declarations={[]} />);

    expect(screen.getByText('No declarations in this file')).toBeInTheDocument();
  });
});
