import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RepositoryScanner, type RepositoryInventory } from '@traceiq/scanner';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { JavaAnalyzer, preloadJavaParser } from './java-analyzer.js';

/**
 * The Java analyser against the constructs a real repository is made of.
 *
 * Every case runs the real scanner and the real analyser over a real directory, and asserts on what the
 * analyser *produced* rather than on what it was asked to do. The confidence assertions matter as much
 * as the count assertions: a Java call edge that read `RESOLVED` would be claiming something no
 * classpath-free analyser can know.
 */
const roots: string[] = [];

beforeAll(async () => {
  await preloadJavaParser();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function inventoryOf(files: Readonly<Record<string, string>>): Promise<RepositoryInventory> {
  const root = await mkdtemp(path.join(tmpdir(), 'traceiq-java-'));

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
  const analyzer = await JavaAnalyzer.prepare(inventory);
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

const MANIFEST = '<project><artifactId>svc</artifactId></project>\n';

describe('declarations', () => {
  it('records classes, interfaces, enums, records and their members', async () => {
    const { declarations, chains } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Shapes.java': [
        'package com.example;',
        '',
        'public class Shapes {',
        '  private final int size;',
        '  public static final String NAME = "shapes";',
        '',
        '  public Shapes(int size) { this.size = size; }',
        '',
        '  public int area() { return size * size; }',
        '',
        '  interface Drawable { void draw(); }',
        '',
        '  enum Colour { RED, GREEN }',
        '',
        '  record Point(int x, int y) {}',
        '',
        '  static class Inner { void go() {} }',
        '}',
        '',
      ].join('\n'),
    });

    expect(chains).toEqual(
      expect.arrayContaining([
        'Shapes',
        'Shapes.size',
        'Shapes.NAME',
        'Shapes.area',
        'Shapes.Drawable',
        'Shapes.Drawable.draw',
        'Shapes.Colour',
        'Shapes.Colour.RED',
        'Shapes.Point',
        'Shapes.Point.x',
        'Shapes.Inner',
        'Shapes.Inner.go',
      ]),
    );

    const byChain = new Map(declarations.map((entry) => [entry.containerChain.join('.'), entry]));

    expect(byChain.get('Shapes')?.kind).toBe('class');
    expect(byChain.get('Shapes.Drawable')?.kind).toBe('interface');
    expect(byChain.get('Shapes.Colour')?.kind).toBe('enum');
    expect(byChain.get('Shapes.Colour.RED')?.kind).toBe('enum-member');
    // A record is a class: the IR has no `record`, and inventing one would make every consumer learn it.
    expect(byChain.get('Shapes.Point')?.kind).toBe('class');
    expect(byChain.get('Shapes.area')?.kind).toBe('method');
  });

  it('records a constructor as a constructor, not a method', async () => {
    const { declarations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': 'package com.example;\npublic class A { public A() {} }\n',
    });

    expect(declarations.find((entry) => entry.name === 'A' && entry.containerChain.length === 2)?.kind).toBe(
      'constructor',
    );
  });

  it('reads visibility, static, final and abstract from the modifiers', async () => {
    const { declarations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/M.java': [
        'package com.example;',
        'public abstract class M {',
        '  private int hidden;',
        '  protected static final int SHARED = 1;',
        '  public abstract void go();',
        '  void packagePrivate() {}',
        '}',
        '',
      ].join('\n'),
    });

    const byChain = new Map(declarations.map((entry) => [entry.containerChain.join('.'), entry]));

    expect(byChain.get('M')?.modifiers.isAbstract).toBe(true);
    expect(byChain.get('M')?.visibility).toBe('public');
    expect(byChain.get('M.hidden')?.visibility).toBe('private');
    expect(byChain.get('M.SHARED')?.visibility).toBe('protected');
    expect(byChain.get('M.SHARED')?.modifiers.isStatic).toBe(true);
    expect(byChain.get('M.SHARED')?.modifiers.isReadonly).toBe(true);
    // Package-private has no word among the graph's three levels, and calling it public would
    // overstate its reach.
    expect(byChain.get('M.packagePrivate')?.visibility).toBeNull();
  });

  it('folds an overload set onto one declaration with several locations', async () => {
    const { declarations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/O.java': [
        'package com.example;',
        'public class O {',
        '  public static O of(int a) { return null; }',
        '  public static O of(String a) { return null; }',
        '  public static O of(int a, int b) { return null; }',
        '}',
        '',
      ].join('\n'),
    });

    const ids = declarations.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);

    const folded = declarations.find((entry) => entry.name === 'of');

    expect(folded?.locations).toHaveLength(3);
  });

  it('declares several fields from one statement', async () => {
    const { chains } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/F.java': 'package com.example;\npublic class F { private int a, b; }\n',
    });

    expect(chains).toEqual(expect.arrayContaining(['F.a', 'F.b']));
  });

  it('never marks a Java declaration async, the language having no such keyword', async () => {
    const { declarations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': 'package com.example;\npublic class A { void go() {} }\n',
    });

    for (const declaration of declarations) {
      expect(declaration.modifiers.isAsync).toBe(false);
    }
  });

  it('emits no exports, Java having no export statement', async () => {
    const { ir } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': 'package com.example;\npublic class A {}\n',
    });

    expect(ir.exports).toEqual([]);
  });
});

describe('imports and type resolution', () => {
  it('binds an import of a type this repository declares', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/model/User.java': 'package com.example.model;\npublic class User {}\n',
      'src/main/java/com/example/svc/Service.java': [
        'package com.example.svc;',
        '',
        'import com.example.model.User;',
        '',
        'public class Service { User find() { return null; } }',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          confidence: 'RESOLVED',
          target: { kind: 'declaration', declarationId: 'sym:src/main/java/com/example/model/User.java#User' },
        }),
      ]),
    );
  });

  it('resolves a third-party import to a Maven external named after its package', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': [
        'package com.example;',
        'import org.apache.commons.lang3.StringUtils;',
        'public class A {}',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          // Never RESOLVED: no jar was opened, so this is what the name says.
          confidence: 'INFERRED',
          target: {
            kind: 'external',
            origin: 'package',
            name: 'org.apache.commons.lang3',
            ecosystem: 'maven',
          },
        }),
      ]),
    );
  });

  it('separates the standard library from a dependency', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': [
        'package com.example;',
        'import java.util.List;',
        'import com.google.common.collect.ImmutableList;',
        'public class A {}',
        '',
      ].join('\n'),
    });

    const targets = resolved.relationships
      .filter((relationship) => relationship.type === 'IMPORTS')
      .map((relationship) => relationship.target);

    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: 'external', origin: 'standard-library', name: 'java.util', ecosystem: 'maven' },
        { kind: 'external', origin: 'package', name: 'com.google.common.collect', ecosystem: 'maven' },
      ]),
    );
  });

  it('resolves a type in the same package without an import', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/User.java': 'package com.example;\npublic class User {}\n',
      'src/main/java/com/example/Repo.java': 'package com.example;\npublic class Repo { User one; }\n',
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'REFERENCES_TYPE',
          confidence: 'RESOLVED',
          target: { kind: 'declaration', declarationId: 'sym:src/main/java/com/example/User.java#User' },
        }),
      ]),
    );
  });

  it('does not treat a type parameter as a dependency', async () => {
    // `T` names nothing outside the repository. Calling it a java.lang type would fabricate a
    // dependency in every generic class.
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Box.java': 'package com.example;\npublic class Box<T> { T value; }\n',
    });

    expect(
      resolved.relationships.some(
        (relationship) =>
          relationship.type === 'REFERENCES_TYPE' &&
          relationship.target.kind === 'external' &&
          relationship.name === 'T',
      ),
    ).toBe(false);
  });

  it('records a generic argument as a reference as well as the outer type', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/User.java': 'package com.example;\npublic class User {}\n',
      'src/main/java/com/example/Repo.java': [
        'package com.example;',
        'import java.util.List;',
        'public class Repo { List<User> all() { return null; } }',
        '',
      ].join('\n'),
    });

    // `User` inside a collection is exactly the edge a reader wants, and in Java it is nearly always
    // inside one.
    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'REFERENCES_TYPE',
          name: 'User',
          target: { kind: 'declaration', declarationId: 'sym:src/main/java/com/example/User.java#User' },
        }),
      ]),
    );
  });
});

describe('inheritance', () => {
  it('records extends and implements as different relationships', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Base.java': 'package com.example;\npublic class Base {}\n',
      'src/main/java/com/example/Marker.java': 'package com.example;\npublic interface Marker {}\n',
      'src/main/java/com/example/Impl.java':
        'package com.example;\npublic class Impl extends Base implements Marker {}\n',
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'EXTENDS', name: 'Base', confidence: 'RESOLVED' }),
        expect.objectContaining({ type: 'IMPLEMENTS', name: 'Marker', confidence: 'RESOLVED' }),
      ]),
    );
  });

  it('does not record a supertype generic argument as a supertype', async () => {
    // `implements Formatter<PetType>` implements `Formatter`; `PetType` is merely named. Recording it as
    // heritage said the class implemented `PetType`, which the graph rejected — and it cost Spring
    // PetClinic its entire Java analysis.
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/PetType.java': 'package com.example;\npublic class PetType {}\n',
      'src/main/java/com/example/Fmt.java': [
        'package com.example;',
        'import java.util.Comparator;',
        'public class Fmt implements Comparator<PetType> {}',
        '',
      ].join('\n'),
    });

    expect(
      resolved.relationships.some(
        (relationship) => relationship.type === 'IMPLEMENTS' && relationship.name === 'PetType',
      ),
    ).toBe(false);

    // But it is still a reference, because the source names it.
    expect(
      resolved.relationships.some(
        (relationship) => relationship.type === 'REFERENCES_TYPE' && relationship.name === 'PetType',
      ),
    ).toBe(true);
  });

  it('lets an enum implement an interface, which Java permits', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Marker.java': 'package com.example;\npublic interface Marker {}\n',
      'src/main/java/com/example/E.java':
        'package com.example;\npublic enum E implements Marker { ONE, TWO }\n',
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'IMPLEMENTS', name: 'Marker' })]),
    );
  });

  it('reports a supertype from a dependency as external rather than dropping it', async () => {
    const { resolved } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/E.java': [
        'package com.example;',
        'import org.junit.jupiter.api.Assertions;',
        'public class E extends Assertions {}',
        '',
      ].join('\n'),
    });

    expect(resolved.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'EXTENDS',
          confidence: 'INFERRED',
          target: expect.objectContaining({ kind: 'external', ecosystem: 'maven' }),
        }),
      ]),
    );
  });
});

describe('calls', () => {
  it('binds a bare call to a member of the enclosing type', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': [
        'package com.example;',
        'public class A {',
        '  void go() { helper(); }',
        '  void helper() {}',
        '}',
        '',
      ].join('\n'),
    });

    const call = callGraph.calls.find((entry) => entry.calleeText === 'helper');

    expect(call?.targetId).toBe('sym:src/main/java/com/example/A.java#A.helper');
    // Never RESOLVED: Java dispatches on the runtime type.
    expect(call?.confidence).toBe('INFERRED');
  });

  it('binds a call through a proven superclass', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Base.java':
        'package com.example;\npublic class Base { protected void shared() {} }\n',
      'src/main/java/com/example/Child.java':
        'package com.example;\npublic class Child extends Base { void go() { shared(); } }\n',
    });

    expect(callGraph.calls.find((entry) => entry.calleeText === 'shared')?.targetId).toBe(
      'sym:src/main/java/com/example/Base.java#Base.shared',
    );
  });

  it('binds a call through a field whose declared type is known', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Repo.java': 'package com.example;\npublic class Repo { void save() {} }\n',
      'src/main/java/com/example/Svc.java': [
        'package com.example;',
        'public class Svc {',
        '  private final Repo repo = null;',
        '  void go() { repo.save(); }',
        '}',
        '',
      ].join('\n'),
    });

    expect(callGraph.calls.find((entry) => entry.calleeText === 'repo.save')?.targetId).toBe(
      'sym:src/main/java/com/example/Repo.java#Repo.save',
    );
  });

  it('binds a static call through the type that declares it', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Util.java':
        'package com.example;\npublic class Util { public static int twice(int a) { return a * 2; } }\n',
      'src/main/java/com/example/Use.java':
        'package com.example;\npublic class Use { int go() { return Util.twice(2); } }\n',
    });

    expect(callGraph.calls.find((entry) => entry.calleeText === 'Util.twice')?.targetId).toBe(
      'sym:src/main/java/com/example/Util.java#Util.twice',
    );
  });

  it('records construction as a call onto the constructor', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Thing.java':
        'package com.example;\npublic class Thing { public Thing() {} }\n',
      'src/main/java/com/example/Use.java':
        'package com.example;\npublic class Use { Thing make() { return new Thing(); } }\n',
    });

    expect(callGraph.calls.some((entry) => entry.calleeText.startsWith('new Thing'))).toBe(true);
  });

  it('refuses to bind a call on a receiver whose type it does not know', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java':
        'package com.example;\npublic class A { void go(Object thing) { thing.hashCode(); } }\n',
    });

    expect(callGraph.calls.some((entry) => entry.calleeText.includes('hashCode'))).toBe(false);
    expect(
      callGraph.unresolved.some(
        (entry) => entry.calleeText.includes('hashCode') && entry.reason === 'root-type-unknown',
      ),
    ).toBe(true);
  });

  it('never claims a Java call is RESOLVED', async () => {
    const { callGraph } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': [
        'package com.example;',
        'public class A {',
        '  void one() { two(); }',
        '  void two() { one(); }',
        '}',
        '',
      ].join('\n'),
    });

    expect(callGraph.calls.length).toBeGreaterThan(0);

    for (const call of callGraph.calls) {
      expect(call.confidence).toBe('INFERRED');
    }
  });
});

describe('frameworks', () => {
  it('reads Spring routes and composes the class path onto the method path', async () => {
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/OwnerController.java': [
        'package com.example;',
        '',
        'import org.springframework.web.bind.annotation.GetMapping;',
        'import org.springframework.web.bind.annotation.PostMapping;',
        'import org.springframework.web.bind.annotation.RequestMapping;',
        'import org.springframework.web.bind.annotation.RestController;',
        '',
        '@RestController',
        '@RequestMapping("/api/owners")',
        'public class OwnerController {',
        '  @GetMapping("/{id}")',
        '  String one() { return ""; }',
        '',
        '  @PostMapping',
        '  String create() { return ""; }',
        '}',
        '',
      ].join('\n'),
    });

    const routes = annotations.routes.map((route) => `${route.method} ${route.path}`).sort();

    expect(routes).toEqual(['GET /api/owners/{id}', 'POST /api/owners']);

    for (const route of annotations.routes) {
      // An annotation is evidence for a framework, never proof of one.
      expect(route.confidence).toBe('INFERRED');
    }
  });

  it('reads Jakarta REST routes', async () => {
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/R.java': [
        'package com.example;',
        '',
        'import jakarta.ws.rs.GET;',
        'import jakarta.ws.rs.Path;',
        '',
        '@Path("/things")',
        'public class R {',
        '  @GET',
        '  @Path("/{id}")',
        '  String one() { return ""; }',
        '}',
        '',
      ].join('\n'),
    });

    expect(annotations.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /things/{id}',
    ]);
  });

  it('reads the method from a RequestMapping that states one', async () => {
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/C.java': [
        'package com.example;',
        'import org.springframework.web.bind.annotation.RequestMapping;',
        'import org.springframework.web.bind.annotation.RequestMethod;',
        'public class C {',
        '  @RequestMapping(value = "/x", method = RequestMethod.DELETE)',
        '  void go() {}',
        '}',
        '',
      ].join('\n'),
    });

    expect(annotations.routes.map((route) => `${route.method} ${route.path}`)).toEqual(['DELETE /x']);
  });

  it('records no route for a RequestMapping that fixes no method', async () => {
    // Spring accepts every method there. Picking GET would state something the source does not.
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/C.java': [
        'package com.example;',
        'import org.springframework.web.bind.annotation.RequestMapping;',
        'public class C {',
        '  @RequestMapping("/x")',
        '  void go() {}',
        '}',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toEqual([]);
  });

  it('ignores a routing-shaped annotation in a file importing no web framework', async () => {
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/C.java': [
        'package com.example;',
        'import com.acme.GetMapping;',
        'public class C {',
        '  @GetMapping("/not-a-route")',
        '  void go() {}',
        '}',
        '',
      ].join('\n'),
    });

    expect(annotations.routes).toEqual([]);
  });

  it('reads Spring stereotypes and JUnit tests as roles', async () => {
    const { annotations } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/S.java': [
        'package com.example;',
        'import org.springframework.stereotype.Service;',
        '@Service',
        'public class S {}',
        '',
      ].join('\n'),
      'src/test/java/com/example/STest.java': [
        'package com.example;',
        'import org.junit.jupiter.api.Test;',
        'public class STest {',
        '  @Test',
        '  void works() {}',
        '}',
        '',
      ].join('\n'),
    });

    const roles = annotations.roles.map((role) => role.role);

    expect(roles).toContain('Service');
    expect(roles).toContain('Test');

    for (const role of annotations.roles) {
      expect(role.confidence).toBe('INFERRED');
    }
  });
});

describe('degradation', () => {
  it('keeps what it recovered from a file with a syntax error', async () => {
    const { chains, outcome } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/Good.java': 'package com.example;\npublic class Good { void ok() {} }\n',
      'src/main/java/com/example/Bad.java': 'package com.example;\npublic class Bad { void ( }\n',
    });

    expect(outcome.failure).toBeNull();
    expect(chains).toContain('Good');
  });

  it('declines when a repository holds no Java', async () => {
    const inventory = await inventoryOf({ 'README.md': '# nothing\n' });
    const analyzer = await JavaAnalyzer.prepare(inventory);
    const outcome = analyzer.analyze({ inventory });

    expect(outcome.contribution).toBeNull();
    expect(outcome.depth).toBe('universal');
    expect(outcome.failure).toBeNull();
  });

  it('covers a test source like any other file', async () => {
    const { outcome } = await analyse({
      'pom.xml': MANIFEST,
      'src/main/java/com/example/A.java': 'package com.example;\npublic class A {}\n',
      'src/test/java/com/example/ATest.java': 'package com.example;\npublic class ATest {}\n',
    });

    expect(outcome.coveredFiles).toContain('src/test/java/com/example/ATest.java');
  });
});

/**
 * Local variables, which is where most of a Java method's calls actually go.
 *
 * Java writes a local's type down, or writes the expression that gives it one. Before these rules
 * the analyser could bind a call on a *field* and not on a local, which against Spring PetClinic
 * meant 868 `root-type-unknown` failures against 106 bound calls.
 */
describe('local variable type inference', () => {
  it('binds a call on a local whose type is declared', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Repo.java': `
        package app;
        public class Repo { public void save() {} }
      `,
      'src/main/java/app/Service.java': `
        package app;
        public class Service {
          public void run() {
            Repo repo = obtain();
            repo.save();
          }
          Repo obtain() { return null; }
        }
      `,
    });

    const call = result.callGraph.calls.find((entry) => entry.calleeText === 'repo.save');

    expect(call?.targetId).toBe('sym:src/main/java/app/Repo.java#Repo.save');
    expect(call?.kind).toBe('instance-member');
    // Never RESOLVED: `repo` could hold a subclass, and Java dispatches on the runtime type.
    expect(call?.confidence).toBe('INFERRED');
    expect(call?.provenance.evidence).toMatch(/declared as 'Repo'/);
  });

  it('binds a call on a var initialised by construction', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Repo.java': 'package app; public class Repo { public void save() {} }',
      'src/main/java/app/Service.java': `
        package app;
        public class Service {
          public void run() {
            var repo = new Repo();
            repo.save();
          }
        }
      `,
    });

    expect(result.callGraph.calls.find((entry) => entry.calleeText === 'repo.save')).toMatchObject({
      targetId: 'sym:src/main/java/app/Repo.java#Repo.save',
      kind: 'instance-member',
    });
  });

  it('binds a call on a var initialised from a factory whose return type is declared here', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Repo.java': 'package app; public class Repo { public void save() {} }',
      'src/main/java/app/Repos.java': `
        package app;
        public class Repos { public static Repo create() { return new Repo(); } }
      `,
      'src/main/java/app/Service.java': `
        package app;
        public class Service {
          public void run() {
            var repo = Repos.create();
            repo.save();
          }
        }
      `,
    });

    const call = result.callGraph.calls.find((entry) => entry.calleeText === 'repo.save');

    expect(call?.targetId).toBe('sym:src/main/java/app/Repo.java#Repo.save');
    expect(call?.provenance.evidence).toMatch(/returns 'Repo'/);
  });

  it('leaves a local with no recoverable type unbound rather than guessing', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Service.java': `
        package app;
        public class Service {
          public void run(java.util.List<String> items) {
            for (var item : items) {
              item.trim();
            }
          }
        }
      `,
    });

    expect(result.callGraph.calls.some((entry) => entry.calleeText === 'item.trim')).toBe(false);
  });
});

/**
 * Calls that leave the repository.
 *
 * A Java repository's dependencies are used far more often than they are declared, and until this
 * milestone none of that use was in the graph: `CALLS reach named external` was zero for every Java
 * repository measured, while TypeScript's was in the thousands.
 */
describe('external calls', () => {
  it('records a call on a local whose declared type is imported from outside', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Service.java': `
        package app;
        import org.slf4j.Logger;
        public class Service {
          public void run() {
            Logger log = null;
            log.info("hello");
          }
        }
      `,
    });

    const external = result.callGraph.externalCalls.find((entry) => entry.calleeText === 'log.info');

    expect(external?.name).toBe('org.slf4j');
    expect(external?.ecosystem).toBe('maven');
    expect(external?.origin).toBe('package');
    // No jar was opened, so that slf4j declares `info` is what a classpath would prove, not this.
    expect(external?.confidence).toBe('INFERRED');
  });

  it('records a static call on an imported type as leaving the repository', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Service.java': `
        package app;
        import java.util.Collections;
        public class Service {
          public void run() { Collections.emptyList(); }
        }
      `,
    });

    expect(
      result.callGraph.externalCalls.find((entry) => entry.calleeText === 'Collections.emptyList'),
    ).toMatchObject({ name: 'java.util', origin: 'standard-library' });
  });

  it('records a statically imported member from outside the repository', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/ServiceTest.java': `
        package app;
        import static org.junit.jupiter.api.Assertions.assertEquals;
        public class ServiceTest {
          public void test() { assertEquals(1, 1); }
        }
      `,
    });

    expect(
      result.callGraph.externalCalls.find((entry) => entry.calleeText === 'assertEquals'),
    ).toMatchObject({ name: 'org.junit.jupiter.api', origin: 'package' });
  });

  it('does not invent an external for a name nothing imported', async () => {
    const result = await analyse({
      'pom.xml': '<project/>',
      'src/main/java/app/Service.java': `
        package app;
        public class Service {
          public void run() { mystery(); }
        }
      `,
    });

    expect(result.callGraph.externalCalls).toHaveLength(0);
    expect(
      result.callGraph.unresolved.find((entry) => entry.calleeText === 'mystery')?.reason,
    ).toBe('root-not-bound');
  });
});
