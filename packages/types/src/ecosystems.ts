/**
 * The dependency ecosystems TraceIQ can name.
 *
 * **Here, in the vocabulary package, because three layers need the same list and none of them may
 * depend on the others.** The scanner names an ecosystem when it reads a manifest; the resolver names
 * one when a reference leaves the repository; the graph puts one in an external node's identity. Those
 * three had their own answers — the scanner had this list, and the resolver and graph had `npm` and
 * nothing else — which is why a Python import could not become an external node at all: there was no
 * word for where it came from.
 *
 * Naming an ecosystem is not a claim to resolve its packages. The list is deliberately wider than the
 * set any analyser can install or read, exactly as `LANGUAGES` is wider than the set anything parses.
 *
 * **Adding a language should not extend this list.** Java and Go and Rust are already here. A language
 * arriving with a genuinely new packaging system adds one value in one file, and every layer above
 * gains it at once.
 */
export const ECOSYSTEMS = [
  'npm',
  'python',
  'maven',
  'gradle',
  'go',
  'cargo',
  'composer',
  'bundler',
  'nuget',
] as const;

export type Ecosystem = (typeof ECOSYSTEMS)[number];

export function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}
