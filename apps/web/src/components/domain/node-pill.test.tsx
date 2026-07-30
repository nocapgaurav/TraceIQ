import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { node } from '@/test/fixtures';

import { ConfidenceBadge, NodePill, UnresolvedPill } from './node-pill';
import { ListingNote } from './listing-note';
import { Limitations } from './limitations';

describe('NodePill', () => {
  it('links a declaration to its symbol page with the hash encoded', () => {
    render(<NodePill node={node({ id: 'sym:packages/core/src/service.ts#find', kind: 'Method' })} />);

    const link = screen.getByRole('link');

    expect(link).toHaveAttribute('href', '/symbol?id=sym%3Apackages%2Fcore%2Fsrc%2Fservice.ts%23find');
    expect(link.getAttribute('href')).not.toContain('#');
  });

  it('links a file to the explorer, which is a file’s detail view', () => {
    render(<NodePill node={node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null })} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/explorer?file=packages%2Fcore%2Fsrc%2Fservice.ts');
  });

  it('writes the kind out, so colour is never the only signal', () => {
    render(<NodePill node={node({ id: 'sym:a.ts#B', kind: 'Interface' })} />);

    expect(screen.getByText('Interface')).toBeInTheDocument();
  });

  it('shows the declaration name for a symbol and the path for a file', () => {
    const { unmount } = render(<NodePill node={node({ id: 'sym:packages/core/src/service.ts#UserService.find' })} />);

    expect(screen.getByText('UserService.find')).toBeInTheDocument();

    unmount();
    render(<NodePill node={node({ id: 'file:packages/core/src/service.ts', kind: 'File', fileId: null })} />);

    expect(screen.getByText('packages/core/src/service.ts')).toBeInTheDocument();
  });

  it('marks an exported declaration', () => {
    render(<NodePill node={node({ id: 'sym:a.ts#B', isExported: true })} />);

    expect(screen.getByText('export')).toBeInTheDocument();
  });

  it('does not mark one that is not exported', () => {
    render(<NodePill node={node({ id: 'sym:a.ts#B', isExported: false })} />);

    expect(screen.queryByText('export')).not.toBeInTheDocument();
  });
});

describe('ConfidenceBadge', () => {
  it('says nothing for CERTAIN, which is the common case', () => {
    const { container } = render(<ConfidenceBadge confidence="CERTAIN" />);

    expect(container).toBeEmptyDOMElement();
  });

  it.each(['RESOLVED', 'INFERRED', 'AMBIGUOUS'] as const)('labels %s', (confidence) => {
    render(<ConfidenceBadge confidence={confidence} />);

    expect(screen.getByText(confidence.toLowerCase())).toBeInTheDocument();
  });

  it('never shows a numeric score, because the graph holds none', () => {
    const { container } = render(<ConfidenceBadge confidence="INFERRED" />);

    expect(container.textContent).not.toMatch(/\d/);
  });
});

describe('UnresolvedPill', () => {
  it('keeps an unresolvable reference visible with its reason', () => {
    render(<UnresolvedPill text="helper()" reason="root-not-bound" />);

    expect(screen.getByText('helper()')).toBeInTheDocument();
    expect(screen.getByText('root-not-bound')).toBeInTheDocument();
  });
});

describe('ListingNote', () => {
  it('states the total when nothing was capped', () => {
    render(<ListingNote listing={{ entries: [1, 2], total: 2, truncated: false }} noun="package" />);

    expect(screen.getByText('2 packages')).toBeInTheDocument();
  });

  it('says how much a cap hid, so a cap is never silent', () => {
    render(<ListingNote listing={{ entries: [1, 2], total: 2244, truncated: true }} noun="entry" plural="entries" />);

    expect(screen.getByText(/showing 2 of 2,244 entries/)).toBeInTheDocument();
    expect(screen.getByText(/the API caps this list/)).toBeInTheDocument();
  });

  it('uses the singular for one', () => {
    render(<ListingNote listing={{ entries: [1], total: 1, truncated: false }} noun="package" />);

    expect(screen.getByText('1 package')).toBeInTheDocument();
  });

  it('uses an irregular plural when given one', () => {
    render(<ListingNote listing={{ entries: [], total: 20, truncated: false }} noun="entry" plural="entries" />);

    expect(screen.getByText('20 entries')).toBeInTheDocument();
  });
});

describe('Limitations', () => {
  it('renders nothing when there are none', () => {
    const { container } = render(<Limitations limitations={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows each code, its affected count and the server’s own wording', () => {
    render(
      <Limitations
        limitations={[
          { code: 'capped-lists', detail: 'every list carries at most a fixed number of entries', affected: 960 },
          { code: 'partial-call-coverage', detail: 'not every call site is bound', affected: null },
        ]}
      />,
    );

    expect(screen.getByText('capped-lists · affects 960')).toBeInTheDocument();
    expect(screen.getByText('every list carries at most a fixed number of entries')).toBeInTheDocument();
    // A null count must not render as "affects null".
    expect(screen.getByText('partial-call-coverage')).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });
});
