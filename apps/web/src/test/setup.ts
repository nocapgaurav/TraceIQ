import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount between tests.
 *
 * Testing Library registers this itself only when Vitest's globals are enabled. This config keeps
 * `globals: false` — an explicit `import { describe }` is clearer — so cleanup has to be wired by hand.
 * Without it every render accumulates in one document and `getByRole` finds several matches.
 */
afterEach(() => {
  cleanup();
});

/**
 * Test environment setup.
 *
 * jsdom lacks the two browser APIs the layout primitives ask for. Both are stubbed rather than
 * shimmed with a real implementation: a component test asserts what was rendered, not how a browser
 * measures it.
 */
/**
 * Defined unconditionally, not behind an `'matchMedia' in window` guard: jsdom declares the property but
 * leaves it `undefined`, so the guard passes and the call still throws. Reporting `matches: false` means
 * the `system` theme resolves to light under test, which is the deterministic choice.
 */
Object.defineProperty(globalThis.window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

/**
 * A working `localStorage` on the global object.
 *
 * Node 26 defines a global `localStorage` of its own that throws unless the process was started with
 * `--localstorage-file`, and it shadows the one jsdom puts on `window`. Zustand's `persist` reaches for
 * the global, so without this the store cannot be constructed at all under test. An in-memory map is
 * enough: what is asserted is the state, not that a browser wrote it to disk.
 */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

Object.defineProperty(globalThis, 'localStorage', { writable: true, value: new MemoryStorage() });

/**
 * `scrollIntoView`, which jsdom does not implement at all.
 *
 * The chat page follows a streaming answer with it. Stubbed rather than guarded in the component: a browser
 * always has it, and a `typeof` check in production code to satisfy a test environment would be the test
 * shaping the source.
 */
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Nothing to do: a component test asserts what was rendered, not where the viewport ended up.
  };
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
