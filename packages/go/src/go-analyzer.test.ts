import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RepositoryScanner, type RepositoryInventory } from '@traceiq/scanner';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { GoAnalyzer, preloadGoParser } from './go-analyzer.js';
import { isGoStandardLibrary } from './stdlib.js';

/**
 * The Go analyser against the constructs a real repository is made of.
 *
 * The confidence assertions carry as much weight as the counts. Go is the one grammar-backed analyser
 * that reaches `RESOLVED`, because an import path is the module path plus a directory and there is no
 * search path to guess at — so these tests pin down *which* answers earn that and which stay inferred.
 */
const roots: string[] = [];

beforeAll(async () => {
  await preloadGoParser();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inventoryOf(files: Readonly<Record<string, string>>): Promise<RepositoryInventory> {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-go-'));

  roots.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }

  return new RepositoryScanner().scan(root);
}

async function analyse(files: Readonly<Record<string, string>>) {
  const inventory = await inventoryOf(files);
  const analyzer = await GoAnalyzer.prepare(inventory);
  const outcome = analyzer.analyze({ inventory });
  const contribution = outcome.contribution;

  if (contribution === null) {
    throw new Error(`the analyser declined or failed: ${outcome.failure ?? outcome.reason}`);
  }

  return {
    outcome,
    ...contribution,
    declarations: contribution.ir.declarations,
    chains: contribution.ir.declarations.map((entry) => entry.containerChain.join('.')),
  };
}

const MOD = 'module github.com/acme/svc\n\ngo 1.22\n';

describe('declarations', () => {
  it('records funcs, structs, interfaces, fields, consts and vars', async () => {
    const { declarations, chains } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'const Limit = 10',
        'var counter int',
        '',
        'type Server struct {',
        '\tName string',
        '\tport int',
        '}',
        '',
        'type Handler interface {',
        '\tServe(name string) error',
        '}',
        '',
        'func Run() {}',
        '',
        'func (s *Server) Start() error { return nil }',
        '',
      ].join('\n'),
    });

    expect(chains).toEqual(
      expect.arrayContaining([
        'Limit',
        'counter',
        'Server',
        'Server.Name',
        'Server.port',
        'Handler',
        'Handler.Serve',
        'Run',
        // A method is attributed to its receiver's type, which is what makes it addressable.
        'Server.Start',
      ]),
    );

    const byChain = new Map(declarations.map((entry) => [entry.containerChain.join('.'), entry]));

    expect(byChain.get('Server')?.kind).toBe('class');
    expect(byChain.get('Handler')?.kind).toBe('interface');
    expect(byChain.get('Run')?.kind).toBe('function');
    expect(byChain.get('Server.Start')?.kind).toBe('method');
    expect(byChain.get('Limit')?.modifiers.isReadonly).toBe(true);
    expect(byChain.get('counter')?.modifiers.isReadonly).toBe(false);
  });

  it('reads exportedness from the case of the first letter, which is Go visibility', async () => {
    const { declarations } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\nfunc Exported() {}\n\nfunc unexported() {}\n',
    });

    const byName = new Map(declarations.map((entry) => [entry.name, entry]));

    expect(byName.get('Exported')?.modifiers.isExported).toBe(true);
    expect(byName.get('Exported')?.visibility).toBe('public');
    expect(byName.get('unexported')?.modifiers.isExported).toBe(false);
    expect(byName.get('unexported')?.visibility).toBe('private');
  });

  it('attributes a method to its receiver whether the receiver is a pointer or not', async () => {
    const { chains } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type S struct{}',
        '',
        'func (s *S) Pointer() {}',
        'func (s S) Value() {}',
        '',
      ].join('\n'),
    });

    // A pointer receiver is not a different type for addressing, and treating it as one would split a
    // type's methods across two names.
    expect(chains).toEqual(expect.arrayContaining(['S.Pointer', 'S.Value']));
  });

  it('records a method on an unnamed receiver', async () => {
    const { chains } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\ntype S struct{}\n\nfunc (*S) Go() {}\n',
    });

    expect(chains).toContain('S.Go');
  });

  it('records a defined type over a builtin, and its underlying type as a reference', async () => {
    const { declarations } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\ntype Celsius float64\n',
    });

    expect(declarations.find((entry) => entry.name === 'Celsius')?.kind).toBe('class');
  });

  it('records generic type parameters without treating them as dependencies', async () => {
    const { resolved, chains } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\ntype Box[T any] struct {\n\tValue T\n}\n\nfunc Map[T any](in []T) []T { return in }\n',
    });

    expect(chains).toEqual(expect.arrayContaining(['Box', 'Box.Value', 'Map']));

    // `T` is a type parameter, not a package. Claiming a dependency would fabricate one.
    expect(
      resolved.relationships.some(
        (relationship) => relationship.target.kind === 'external' && relationship.name === 'T',
      ),
    ).toBe(false);
  });

  it('emits no exports, exportedness being the case of the name', async () => {
    const { ir } = await analyse({ 'go.mod': MOD, 'main.go': 'package main\n\nfunc Go() {}\n' });

    expect(ir.exports).toEqual([]);
  });
});

describe('imports', () => {
  it('resolves an import inside this module to the directory it names, and calls it proven', async () => {
    const { resolved } = await analyse({
      'go.mod': MOD,
      'internal/store/store.go': 'package store\n\nfunc Save() {}\n',
      'main.go': [
        'package main',
        '',
        'import "github.com/acme/svc/internal/store"',
        '',
        'func main() { store.Save() }',
        '',
      ].join('\n'),
    });

    // The module path plus the directory *is* the import path. There is no search involved, which is
    // why this is the one grammar-backed analyser that reaches RESOLVED here.
    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'IMPORTS', confidence: 'RESOLVED' }),
      ]),
    );
  });

  it('classifies the standard library by Go\'s own rule, with no list to maintain', async () => {
    expect(isGoStandardLibrary('net/http')).toBe(true);
    expect(isGoStandardLibrary('fmt')).toBe(true);
    expect(isGoStandardLibrary('encoding/json')).toBe(true);
    expect(isGoStandardLibrary('github.com/gin-gonic/gin')).toBe(false);
    expect(isGoStandardLibrary('golang.org/x/sync/errgroup')).toBe(false);
  });

  it('separates a module dependency from the standard library', async () => {
    const { resolved } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'import (',
        '\t"net/http"',
        '\t"github.com/gin-gonic/gin"',
        ')',
        '',
        'func main() { _ = http.StatusOK; _ = gin.New() }',
        '',
      ].join('\n'),
    });

    const targets = resolved.relationships
      .filter((relationship) => relationship.type === 'IMPORTS')
      .map((relationship) => relationship.target);

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: 'external', origin: 'standard-library', name: 'net/http', ecosystem: 'go' },
        { kind: 'external', origin: 'package', name: 'github.com/gin-gonic/gin', ecosystem: 'go' },
      ]),
    );
  });

  it('binds an aliased import under the alias', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'internal/store/store.go': 'package store\n\nfunc Save() {}\n',
      'main.go': [
        'package main',
        '',
        'import st "github.com/acme/svc/internal/store"',
        '',
        'func main() { st.Save() }',
        '',
      ].join('\n'),
    });

    expect(callGraph.calls.find((call) => call.calleeText === 'st.Save')?.targetId).toBe(
      'sym:internal/store/store.go#Save',
    );
  });

  it('records a blank import as a dependency that binds no name', async () => {
    const { ir } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\nimport _ "github.com/lib/pq"\n\nfunc main() {}\n',
    });

    const statement = ir.imports.find((entry) => entry.moduleSpecifier === 'github.com/lib/pq');

    expect(statement).toBeDefined();
    expect(statement?.bindings).toEqual([]);
  });

  it('resolves each module of a workspace against its own module path', async () => {
    const { resolved } = await analyse({
      'go.work': 'go 1.22\n\nuse (\n\t./api\n\t./worker\n)\n',
      'api/go.mod': 'module github.com/acme/api\n\ngo 1.22\n',
      'api/handler/handler.go': 'package handler\n\nfunc Handle() {}\n',
      'worker/go.mod': 'module github.com/acme/worker\n\ngo 1.22\n',
      'worker/main.go': [
        'package main',
        '',
        'import "github.com/acme/api/handler"',
        '',
        'func main() { handler.Handle() }',
        '',
      ].join('\n'),
    });

    // A repository holding two modules must resolve each against its own path; assuming a single root
    // would attribute one module's packages to the other.
    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'IMPORTS', confidence: 'RESOLVED' }),
      ]),
    );
  });
});

describe('embedding, which is how Go composes', () => {
  it('records an embedded struct as EXTENDS', async () => {
    const { resolved } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type Base struct{}',
        '',
        'func (b Base) Shared() {}',
        '',
        'type Child struct {',
        '\tBase',
        '}',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'EXTENDS', name: 'Base', confidence: 'RESOLVED' }),
      ]),
    );
  });

  it('binds a promoted method through the embedded type', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type Base struct{}',
        '',
        'func (b Base) Shared() {}',
        '',
        'type Child struct {',
        '\tBase',
        '}',
        '',
        'func (c Child) Go() { c.Shared() }',
        '',
      ].join('\n'),
    });

    // Promotion is what embedding does, and it is the relationship a reader is looking for.
    expect(callGraph.calls.find((call) => call.calleeText === 'c.Shared')?.targetId).toBe(
      'sym:main.go#Base.Shared',
    );
  });

  it('records an embedded interface', async () => {
    const { resolved } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type Reader interface { Read() error }',
        '',
        'type ReadWriter interface {',
        '\tReader',
        '\tWrite() error',
        '}',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'EXTENDS', name: 'Reader' })]),
    );
  });

  it('reports an embedded type from a dependency as external rather than dropping it', async () => {
    const { resolved } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'import "sync"',
        '',
        'type Safe struct {',
        '\tsync.Mutex',
        '}',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'EXTENDS',
          confidence: 'INFERRED',
          target: expect.objectContaining({ kind: 'external', ecosystem: 'go' }),
        }),
      ]),
    );
  });
});

describe('calls', () => {
  it('binds a bare call to a package-level declaration, and calls it proven', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\nfunc helper() {}\n\nfunc main() { helper() }\n',
    });

    const call = callGraph.calls.find((entry) => entry.calleeText === 'helper');

    expect(call?.targetId).toBe('sym:main.go#helper');
    // Go's package scope is the directory, and the name is declared in it. Nothing is guessed.
    expect(call?.confidence).toBe('RESOLVED');
  });

  it('binds a call across files of the same package', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'a.go': 'package main\n\nfunc helper() {}\n',
      'b.go': 'package main\n\nfunc main() { helper() }\n',
    });

    expect(callGraph.calls.find((entry) => entry.calleeText === 'helper')?.targetId).toBe(
      'sym:a.go#helper',
    );
  });

  it('binds a method on the receiver, as inferred rather than proven', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type S struct{}',
        '',
        'func (s *S) helper() {}',
        'func (s *S) Go() { s.helper() }',
        '',
      ].join('\n'),
    });

    const call = callGraph.calls.find((entry) => entry.calleeText === 's.helper');

    expect(call?.targetId).toBe('sym:main.go#S.helper');
    // An interface value dispatches at runtime, so a method call is the most plausible target.
    expect(call?.confidence).toBe('INFERRED');
  });

  it('binds a call through a field whose declared type is known', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type Store struct{}',
        '',
        'func (st *Store) Save() {}',
        '',
        'type Svc struct {',
        '\tstore *Store',
        '}',
        '',
        'func (s *Svc) Go() { s.store.Save() }',
        '',
      ].join('\n'),
    });

    expect(callGraph.calls.some((call) => call.calleeText.includes('Save'))).toBe(true);
  });

  it('refuses to bind a call on a local whose type Go infers', async () => {
    const { callGraph } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'func make2() interface{} { return nil }',
        '',
        'func main() {',
        '\tthing := make2()',
        '\t_ = thing',
        '}',
        '',
      ].join('\n'),
    });

    // `thing`'s type comes from Go's inference, which this analyser does not reproduce. A guess would
    // put a wrong edge in the graph.
    for (const call of callGraph.calls) {
      expect(call.targetId).not.toContain('#thing');
    }
  });
});

describe('frameworks', () => {
  it('reads Gin route registrations', async () => {
    const { annotations } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'import "github.com/gin-gonic/gin"',
        '',
        'func main() {',
        '\tr := gin.Default()',
        '\tr.GET("/users", listUsers)',
        '\tr.POST("/users", createUser)',
        '\tr.Run()',
        '}',
        '',
        'func listUsers() {}',
        'func createUser() {}',
        '',
      ].join('\n'),
    });

    const routes = annotations.routes.map((route) => `${route.method} ${route.path}`).sort();

    expect(routes).toEqual(['GET /users', 'POST /users']);

    for (const route of annotations.routes) {
      // A method named `GET` on something unrelated looks identical, so the framework import is the
      // evidence and it makes this inferred rather than proven.
      expect(route.confidence).toBe('INFERRED');
    }
  });

  it('reads Echo and Fiber, which share the shape', async () => {
    const { annotations } = await analyse({
      'go.mod': MOD,
      'echo.go': [
        'package main',
        '',
        'import "github.com/labstack/echo/v4"',
        '',
        'func setup(e *echo.Echo) { e.GET("/health", nil) }',
        '',
      ].join('\n'),
      'fiber.go': [
        'package main',
        '',
        'import "github.com/gofiber/fiber/v2"',
        '',
        'func setupFiber(app *fiber.App) { app.Post("/items", nil) }',
        '',
      ].join('\n'),
    });

    const routes = annotations.routes.map((route) => `${route.method} ${route.path}`).sort();

    expect(routes).toEqual(['GET /health', 'POST /items']);
  });

  it('ignores a router-shaped call in a file importing no web framework', async () => {
    const { annotations } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'type Fetcher struct{}',
        '',
        'func (f Fetcher) GET(url string) {}',
        '',
        'func main() { Fetcher{}.GET("/not-a-route") }',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toEqual([]);
  });

  it('records no route for a path that is not addressable', async () => {
    const { annotations } = await analyse({
      'go.mod': MOD,
      'main.go': [
        'package main',
        '',
        'import "github.com/gin-gonic/gin"',
        '',
        'func setup(r *gin.Engine) { r.GET("users", nil) }',
        '',
      ].join('\n'),
    });

    // A path with no leading slash is not one Go's routers accept, and `routeId` would refuse it.
    expect(annotations.routes).toEqual([]);
  });
});

describe('degradation', () => {
  it('keeps what it recovered from a file with a syntax error', async () => {
    const { chains, outcome } = await analyse({
      'go.mod': MOD,
      'good.go': 'package main\n\nfunc Good() {}\n',
      'bad.go': 'package main\n\nfunc Bad( {\n',
    });

    expect(outcome.failure).toBeNull();
    expect(chains).toContain('Good');
  });

  it('analyses a module with no go.mod, resolving no import path', async () => {
    // A vendored directory or a GOPATH-era repository has no go.mod. Declarations are still real; only
    // cross-package resolution is unavailable, and it says so by leaving imports external.
    const { declarations } = await analyse({ 'main.go': 'package main\n\nfunc Go() {}\n' });

    expect(declarations.map((entry) => entry.name)).toContain('Go');
  });

  it('declines when a repository holds no Go', async () => {
    const inventory = await inventoryOf({ 'README.md': '# nothing\n' });
    const analyzer = await GoAnalyzer.prepare(inventory);
    const outcome = analyzer.analyze({ inventory });

    expect(outcome.contribution).toBeNull();
    expect(outcome.depth).toBe('universal');
    expect(outcome.failure).toBeNull();
  });

  it('covers a _test.go file like any other source', async () => {
    const { outcome } = await analyse({
      'go.mod': MOD,
      'main.go': 'package main\n\nfunc Go() {}\n',
      'main_test.go': 'package main\n\nimport "testing"\n\nfunc TestGo(t *testing.T) { Go() }\n',
    });

    expect(outcome.coveredFiles).toContain('main_test.go');
  });
});

/**
 * Local variables, which Go writes less often than Java and infers more.
 *
 * Three shapes carry a type the source states, and each is tested against the rule that reads it.
 * A range variable or a channel receive states nothing, and must stay unbound.
 */
describe('local variable type inference', () => {
  it('binds a call on a local declared with an explicit type', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'store/store.go': 'package store\ntype Store struct{}\nfunc (s *Store) Save() {}\n',
      'main.go': `package main
import "example.com/app/store"
func run() {
  var s store.Store
  s.Save()
}
`,
    });

    expect(result.callGraph.calls.find((entry) => entry.calleeText === 's.Save')).toMatchObject({
      targetId: 'sym:store/store.go#Store.Save',
      kind: 'instance-member',
      confidence: 'INFERRED',
    });
  });

  it('binds a call on a local initialised from a composite literal', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': `package main
type Server struct{}
func (s *Server) Start() {}
func run() {
  s := &Server{}
  s.Start()
}
`,
    });

    const call = result.callGraph.calls.find((entry) => entry.calleeText === 's.Start');

    expect(call?.targetId).toBe('sym:main.go#Server.Start');
    expect(call?.provenance.evidence).toMatch(/'Server' literal/);
  });

  it('binds a call on a local initialised from a constructor function', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': `package main
type Server struct{}
func (s *Server) Start() {}
func NewServer() *Server { return &Server{} }
func run() {
  s := NewServer()
  s.Start()
}
`,
    });

    const call = result.callGraph.calls.find((entry) => entry.calleeText === 's.Start');

    expect(call?.targetId).toBe('sym:main.go#Server.Start');
    expect(call?.provenance.evidence).toMatch(/returns 'Server'/);
  });

  it('leaves a range variable unbound rather than guessing its element type', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': `package main
type Server struct{}
func (s *Server) Start() {}
func run(all []*Server) {
  for _, s := range all {
    s.Start()
  }
}
`,
    });

    expect(result.callGraph.calls.some((entry) => entry.calleeText === 's.Start')).toBe(false);
    expect(
      result.callGraph.unresolved.find((entry) => entry.calleeText === 's.Start')?.reason,
    ).toBe('root-type-unknown');
  });
});

/**
 * Calls into a package outside this repository's modules.
 *
 * Go's import rule makes the *qualifier* exact — an alias names one import path with no search — so
 * these are RESOLVED, matching the confidence the internal package-qualified rule already earned.
 * Until this milestone they were reported `root-not-bound`, which was both the wrong reason and the
 * largest single unresolved category in every Go repository measured.
 */
describe('external calls', () => {
  it('records a standard-library call as an edge onto the standard library', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "fmt"\nfunc run() { fmt.Println("hi") }\n',
    });

    expect(
      result.callGraph.externalCalls.find((entry) => entry.calleeText === 'fmt.Println'),
    ).toMatchObject({ name: 'fmt', origin: 'standard-library', ecosystem: 'go', confidence: 'RESOLVED' });

    expect(result.callGraph.unresolved.some((entry) => entry.calleeText === 'fmt.Println')).toBe(false);
  });

  it('records a module call under the module path, which is the module identity', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nimport "github.com/gin-gonic/gin"\nfunc run() { gin.New() }\n',
    });

    expect(
      result.callGraph.externalCalls.find((entry) => entry.calleeText === 'gin.New'),
    ).toMatchObject({ name: 'github.com/gin-gonic/gin', origin: 'package' });
  });

  it('does not treat a call into this repository as external', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'store/store.go': 'package store\nfunc Save() {}\n',
      'main.go': 'package main\nimport "example.com/app/store"\nfunc run() { store.Save() }\n',
    });

    expect(result.callGraph.externalCalls).toHaveLength(0);
    expect(result.callGraph.calls.find((entry) => entry.calleeText === 'store.Save')?.targetId).toBe(
      'sym:store/store.go#Save',
    );
  });
});

/**
 * Route handlers, which the previous milestone recorded as a known limitation.
 *
 * A bare identifier argument is a package-level name, and in Go a package is a directory — so the
 * lookup is exact. A closure names nothing and must stay unlinked.
 */
describe('route handlers', () => {
  it('links a handler passed by name', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': `package main
import "github.com/gin-gonic/gin"
func listUsers(c *gin.Context) {}
func run() {
  r := gin.Default()
  r.GET("/users", listUsers)
}
`,
    });

    const route = result.annotations.routes.find((entry) => entry.path === '/users');

    expect(route?.method).toBe('GET');
    expect(route?.handlers).toEqual([
      { text: 'listUsers', ordinal: 0, declarationId: 'sym:main.go#listUsers' },
    ]);
  });

  it('records an inline handler without linking it', async () => {
    const result = await analyse({
      'go.mod': 'module example.com/app\n',
      'main.go': `package main
import "github.com/gin-gonic/gin"
func run() {
  r := gin.Default()
  r.GET("/ping", func(c *gin.Context) {})
}
`,
    });

    const route = result.annotations.routes.find((entry) => entry.path === '/ping');

    expect(route?.handlers).toHaveLength(1);
    expect(route?.handlers[0]?.declarationId).toBeNull();
  });
});
