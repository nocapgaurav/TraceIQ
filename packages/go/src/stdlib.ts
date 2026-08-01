/**
 * Whether a Go import path names the standard library.
 *
 * **The Go toolchain's own rule, not a list.** A module path must contain a dot in its first segment —
 * `github.com/...`, `golang.org/x/...`, `example.com/...` — because that is how the toolchain tells a
 * module path from a standard-library path. So `net/http`, `fmt`, `os` and `encoding/json` are standard
 * library, and nothing needs enumerating or updating when Go adds a package.
 *
 * This is the one place across the four analysers where the standard library needs no list at all, and
 * it is worth saying why: Go designed the namespace so the question is answerable by inspection.
 */
export function isGoStandardLibrary(importPath: string): boolean {
  const first = importPath.split('/')[0] ?? '';

  return first.length > 0 && !first.includes('.');
}
