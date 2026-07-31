import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '@/test/harness';
import type { AnalysisJob, AnalysisStage } from '@/types/api';

import { AnalysisDialog } from './analysis-dialog';

/**
 * The Repository Analysis dialog, from `fetch` upwards.
 *
 * Only `fetch` is stubbed: the real service, the real polling hook and the real components run. What
 * matters here is the honesty of the progress display and the handling of the states a user will
 * actually hit — a rejected URL, a failed clone, a second submission — none of which are hypothetical.
 */
const push = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const STAGES = ['validate', 'clone', 'scan', 'load', 'complete'] as const;

function stages(done: number, active: number | null = null, failedAt: number | null = null): AnalysisStage[] {
  return STAGES.map((name, index) => ({
    name,
    label: name,
    status:
      failedAt === index
        ? 'failed'
        : failedAt !== null && index > failedAt
          ? 'skipped'
          : index < done
            ? 'done'
            : index === active
              ? 'active'
              : 'pending',
    detail: index < done ? `${name} finished` : null,
  }));
}

function job(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: 'analysis-1',
    url: 'https://github.com/facebook/react',
    slug: 'facebook/react',
    htmlUrl: 'https://github.com/facebook/react',
    status: 'running',
    stages: stages(1, 1),
    result: null,
    error: null,
    elapsedMs: 1200,
    workspaceWarning: null,
    ...overrides,
  };
}

const RESULT = {
  repository: 'react',
  slug: 'facebook/react',
  htmlUrl: 'https://github.com/facebook/react',
  files: 541,
  declarations: 4461,
  nodes: 5116,
  edges: 19_473,
  routes: 4,
  environmentVariables: 5,
  externalPackages: 74,
  callEdges: 5481,
  unresolvedCalls: 9294,
  unresolvedReferences: 11_461,
};

/**
 * A stub that answers the POST once and then serves a queue of poll responses.
 *
 * The last entry repeats, so a test never depends on exactly how many times the hook polled.
 */
function stubAnalysis(started: AnalysisJob, polls: readonly AnalysisJob[]): { readonly calls: string[] } {
  const calls: string[] = [];
  let index = 0;

  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    calls.push(`${init?.method ?? 'GET'} ${url}`);

    const meta = { endpoint: 'test', capability: 'analysis', graphApiCalls: 0 };

    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ success: true, data: { accepted: true, job: started }, meta }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }

    const next = polls[Math.min(index, polls.length - 1)] ?? started;

    index += 1;

    return new Response(JSON.stringify({ success: true, data: next, meta }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);

  return { calls };
}

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function submit(url = 'https://github.com/facebook/react'): Promise<void> {
  await userEvent.type(screen.getByRole('textbox', { name: 'GitHub repository URL' }), url);
  await userEvent.click(screen.getByRole('button', { name: /Analyze Repository/ }));
}

describe('AnalysisDialog', () => {
  it('asks for a GitHub URL and offers real examples', () => {
    stubAnalysis(job(), []);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toHaveAttribute(
      'placeholder',
      'https://github.com/facebook/react',
    );
    expect(screen.getByRole('button', { name: 'facebook/react' })).toBeInTheDocument();
  });

  it('cannot be submitted empty', () => {
    stubAnalysis(job(), []);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    expect(screen.getByRole('button', { name: /Analyze Repository/ })).toBeDisabled();
  });

  it('fills the box from an example', async () => {
    stubAnalysis(job(), []);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: 'facebook/react' }));

    expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toHaveValue(
      'https://github.com/facebook/react',
    );
  });

  it('starts an analysis and shows the stages the server reported', async () => {
    stubAnalysis(job(), [job({ stages: stages(2, 2) })]);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    await submit();

    const list = await screen.findByRole('list', { name: 'Analysis stages' });

    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('facebook/react')).toBeInTheDocument();
  });

  /** The milestone is explicit: no invented progress. */
  it('shows no percentage and no progress bar — only stages and elapsed time', async () => {
    stubAnalysis(job(), [job({ stages: stages(3, 3) })]);
    const { container } = renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    await submit();
    await screen.findByRole('list', { name: 'Analysis stages' });

    expect(container.textContent ?? '').not.toMatch(/\d+\s?%/);
    expect(container.querySelector('progress')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    // Elapsed time is measurable, so it is shown.
    expect(screen.getByText(/\d+s elapsed/)).toBeInTheDocument();
  });

  it('disables the form while an analysis is running, preventing a second submission', async () => {
    stubAnalysis(job(), [job()]);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    await submit();

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: /Analyzing/ })).toBeDisabled();
  });

  it('navigates to the Overview when the analysis succeeds', async () => {
    const onOpenChange = vi.fn();

    stubAnalysis(job(), [job({ status: 'succeeded', stages: stages(5), result: RESULT })]);
    renderWithQuery(<AnalysisDialog open onOpenChange={onOpenChange} />);

    await submit();

    // No manual reload: the dialog closes and the Overview is opened for the new repository.
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/dashboard');
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reports what the analysis produced', async () => {
    stubAnalysis(job(), [job({ status: 'succeeded', stages: stages(5), result: RESULT })]);
    renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

    await submit();

    expect(await screen.findByText(/541 files, 4,461 declarations and 19,473 relationships/)).toBeInTheDocument();
  });

  describe('failures', () => {
    it('shows a rejected URL in the server’s own words', async () => {
      stubAnalysis(
        job({ slug: null }),
        [
          job({
            slug: null,
            status: 'failed',
            stages: stages(0, null, 0),
            error: {
              code: 'invalid-url',
              detail: 'gitlab.com is not GitHub.',
              hint: 'Only github.com is supported in this version.',
            },
          }),
        ],
      );
      renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

      await submit('https://gitlab.com/owner/repo');

      const alert = await screen.findByRole('alert');

      expect(within(alert).getByText('invalid-url')).toBeInTheDocument();
      expect(within(alert).getByText('gitlab.com is not GitHub.')).toBeInTheDocument();
      expect(within(alert).getByText('Only github.com is supported in this version.')).toBeInTheDocument();
    });

    it('marks the failed stage and skips the rest, rather than leaving them pending', async () => {
      stubAnalysis(job(), [
        job({
          status: 'failed',
          stages: stages(1, null, 1),
          error: { code: 'repository-not-found', detail: 'gone', hint: 'check the spelling' },
        }),
      ]);
      renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

      await submit();

      await screen.findByRole('alert');

      expect(screen.getAllByLabelText('stage failed')).toHaveLength(1);
      expect(screen.getAllByLabelText('stage skipped').length).toBeGreaterThan(0);
      expect(screen.queryByLabelText('stage pending')).toBeNull();
    });

    it('re-enables the form after a failure, so another URL can be tried', async () => {
      stubAnalysis(job(), [
        job({
          status: 'failed',
          stages: stages(1, null, 1),
          error: { code: 'clone-failed', detail: 'no', hint: 'no' },
        }),
      ]);
      renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

      await submit();
      await screen.findByRole('alert');

      expect(screen.getByRole('textbox', { name: 'GitHub repository URL' })).toBeEnabled();
      expect(push).not.toHaveBeenCalled();
    });

    it('reports a submission that never reached the API', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

      await submit();

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached|could not be started/);
    });

    it('surfaces a workspace that could not be cleaned up, without calling the analysis failed', async () => {
      stubAnalysis(job(), [
        job({
          status: 'succeeded',
          stages: stages(5),
          result: RESULT,
          workspaceWarning: 'EBUSY: resource busy',
        }),
      ]);
      renderWithQuery(<AnalysisDialog open onOpenChange={() => {}} />);

      await submit();

      expect(await screen.findByText(/temporary workspace could not be removed/)).toBeInTheDocument();
      // Still a success: it navigated.
      await waitFor(() => {
        expect(push).toHaveBeenCalledWith('/dashboard');
      });
    });
  });
});
