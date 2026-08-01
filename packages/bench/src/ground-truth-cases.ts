import type { GroundTruthCase } from './ground-truth-types.js';

/**
 * The ground-truth corpus: one small repository per supported language.
 *
 * **Every case is the same program.** A store with a save method, a service that depends on it, a
 * base type the service extends or implements, one dependency call, one standard-library call, and
 * one call the analyser must *not* bind. Writing them as translations of one another is what makes
 * the reports comparable: a difference between two languages' numbers is then a difference in the
 * analysers rather than in what each case happened to exercise.
 *
 * Where a language genuinely lacks a construct, the case omits it and the expectation says nothing
 * about that relationship type. Go has no `implements` keyword and no export statement; Python has
 * neither interfaces nor exports. Those are absences in the language, and inventing an expectation
 * for them would measure the analyser against a language it is not reading.
 *
 * The expectations were written by reading the sources, not by running the analyser and recording
 * its output. That distinction is the whole point — a truth transcribed from the thing it is meant
 * to check can only ever report 100%.
 */
export const GROUND_TRUTH_CASES: readonly GroundTruthCase[] = [
  typescriptCase(),
  javascriptCase(),
  pythonCase(),
  javaCase(),
  goCase(),
];

function typescriptCase(): GroundTruthCase {
  return {
    name: 'typescript',
    description: 'ES modules, classes, an interface, generics and a dependency call',
    files: {
      'package.json': JSON.stringify({
        name: 'gt-typescript',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
        include: ['src'],
      }),
      'src/store.ts': `export interface Persistable {
  save(): void;
}

export class Store implements Persistable {
  save(): void {}

  load(): string {
    return '';
  }
}
`,
      'src/service.ts': `import { readFileSync } from 'node:fs';

import { Store } from './store.js';

export class Service extends Store {
  run(): void {
    this.save();
    readFileSync('x');
  }

  reload(): string {
    const store = new Store();

    return store.load();
  }
}
`,
    },
    expected: {
      declarations: [
        'sym:src/store.ts#Persistable',
        'sym:src/store.ts#Persistable.save',
        'sym:src/store.ts#Store',
        'sym:src/store.ts#Store.save',
        'sym:src/store.ts#Store.load',
        'sym:src/service.ts#Service',
        'sym:src/service.ts#Service.run',
        'sym:src/service.ts#Service.reload',
        // A `const` inside a function body is a declaration in the IR — `nestedVariableOf` records
        // it, and has since the IR existed, because a constructed instance is what makes
        // `store.load()` bindable without a checker.
        'sym:src/service.ts#Service.reload.store',
      ],
      edges: {
        IMPORTS: [
          'file:src/service.ts -> ext:node:fs',
          // Two edges for one statement, and both are facts: the file depends on that module, and
          // the named binding reaches that declaration.
          'file:src/service.ts -> file:src/store.ts',
          'file:src/service.ts -> sym:src/store.ts#Store',
        ],
        EXPORTS: [
          'file:src/store.ts -> sym:src/store.ts#Persistable',
          'file:src/store.ts -> sym:src/store.ts#Store',
          'file:src/service.ts -> sym:src/service.ts#Service',
        ],
        EXTENDS: ['sym:src/service.ts#Service -> sym:src/store.ts#Store'],
        IMPLEMENTS: ['sym:src/store.ts#Store -> sym:src/store.ts#Persistable'],
        CALLS: [
          // `this.save()` reaches the inherited declaration, which is where it is written.
          'sym:src/service.ts#Service.run -> sym:src/store.ts#Store.save',
          'sym:src/service.ts#Service.run -> ext:node:fs',
          // `new Store()` is a call, attributed to the variable it initialises rather than to the
          // method — which is exactly how the IR records a nested variable, and what lets the next
          // line bind.
          'sym:src/service.ts#Service.reload.store -> sym:src/store.ts#Store',
          'sym:src/service.ts#Service.reload -> sym:src/store.ts#Store.load',
        ],
      },
    },
  };
}

function javascriptCase(): GroundTruthCase {
  return {
    name: 'javascript',
    description: 'CommonJS requires and exports, mixed with an ES import',
    files: {
      'package.json': JSON.stringify({
        name: 'gt-javascript',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
      'src/store.js': `function save() {}

function load() {
  return '';
}

module.exports = { save, load };
`,
      'src/service.js': `const path = require('node:path');
const store = require('./store');

exports.run = function run() {
  store.save();
  path.join('a', 'b');
};

exports.reload = () => store.load();
`,
      'src/index.js': `module.exports = require('./service');
`,
    },
    expected: {
      declarations: [
        'sym:src/store.js#save',
        'sym:src/store.js#load',
        'sym:src/service.js#run',
        'sym:src/service.js#reload',
        // `const path = require(…)` declares a module-level constant. It is a declaration whichever
        // module system wrote it.
        'sym:src/service.js#path',
        'sym:src/service.js#store',
      ],
      edges: {
        IMPORTS: [
          'file:src/service.js -> ext:node:path',
          'file:src/service.js -> file:src/store.js',
          'file:src/index.js -> file:src/service.js',
        ],
        EXPORTS: [
          'file:src/store.js -> sym:src/store.js#save',
          'file:src/store.js -> sym:src/store.js#load',
          'file:src/service.js -> sym:src/service.js#run',
          'file:src/service.js -> sym:src/service.js#reload',
          'file:src/index.js -> file:src/service.js',
        ],
        CALLS: [
          'sym:src/service.js#run -> sym:src/store.js#save',
          'sym:src/service.js#run -> ext:node:path',
          'sym:src/service.js#reload -> sym:src/store.js#load',
        ],
      },
    },
  };
}

function pythonCase(): GroundTruthCase {
  return {
    name: 'python',
    description: 'packages, relative imports, inheritance, constructor inference and a distribution call',
    files: {
      'pyproject.toml': `[project]
name = "gt-python"
dependencies = ["requests"]
`,
      'app/__init__.py': '',
      'app/store.py': `class Persistable:
    def save(self):
        pass


class Store(Persistable):
    def load(self):
        return ""
`,
      'app/service.py': `import os

import requests

from .store import Store


class Service(Store):
    def run(self):
        self.save()
        os.getcwd()
        requests.get("https://example.com")

    def reload(self):
        store = Store()

        return store.load()
`,
    },
    expected: {
      declarations: [
        'sym:app/store.py#Persistable',
        'sym:app/store.py#Persistable.save',
        'sym:app/store.py#Store',
        'sym:app/store.py#Store.load',
        'sym:app/service.py#Service',
        'sym:app/service.py#Service.run',
        'sym:app/service.py#Service.reload',
      ],
      edges: {
        IMPORTS: [
          'file:app/service.py -> ext:stdlib:os',
          'file:app/service.py -> ext:python:requests',
          'file:app/service.py -> file:app/store.py',
          'file:app/service.py -> sym:app/store.py#Store',
        ],
        EXTENDS: [
          'sym:app/store.py#Store -> sym:app/store.py#Persistable',
          'sym:app/service.py#Service -> sym:app/store.py#Store',
        ],
        CALLS: [
          'sym:app/service.py#Service.run -> sym:app/store.py#Persistable.save',
          'sym:app/service.py#Service.run -> ext:stdlib:os',
          'sym:app/service.py#Service.run -> ext:python:requests',
          'sym:app/service.py#Service.reload -> sym:app/store.py#Store',
          'sym:app/service.py#Service.reload -> sym:app/store.py#Store.load',
        ],
      },
    },
  };
}

function javaCase(): GroundTruthCase {
  return {
    name: 'java',
    description: 'packages, an interface, inheritance, local variable types and a dependency call',
    files: {
      'pom.xml': `<project><dependencies><dependency>
  <groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.0</version>
</dependency></dependencies></project>`,
      'src/main/java/app/Persistable.java': `package app;

public interface Persistable {
  void save();
}
`,
      'src/main/java/app/Store.java': `package app;

public class Store implements Persistable {
  public void save() {}

  public String load() {
    return "";
  }
}
`,
      'src/main/java/app/Service.java': `package app;

import java.util.Collections;

public class Service extends Store {
  public void run() {
    this.save();
    Collections.emptyList();
  }

  public String reload() {
    Store store = new Store();

    return store.load();
  }
}
`,
    },
    expected: {
      declarations: [
        'sym:src/main/java/app/Persistable.java#Persistable',
        'sym:src/main/java/app/Persistable.java#Persistable.save',
        'sym:src/main/java/app/Store.java#Store',
        'sym:src/main/java/app/Store.java#Store.save',
        'sym:src/main/java/app/Store.java#Store.load',
        'sym:src/main/java/app/Service.java#Service',
        'sym:src/main/java/app/Service.java#Service.run',
        'sym:src/main/java/app/Service.java#Service.reload',
      ],
      edges: {
        IMPORTS: ['file:src/main/java/app/Service.java -> ext:stdlib:java.util'],
        EXTENDS: [
          'sym:src/main/java/app/Service.java#Service -> sym:src/main/java/app/Store.java#Store',
        ],
        IMPLEMENTS: [
          'sym:src/main/java/app/Store.java#Store -> sym:src/main/java/app/Persistable.java#Persistable',
        ],
        CALLS: [
          'sym:src/main/java/app/Service.java#Service.run -> sym:src/main/java/app/Store.java#Store.save',
          'sym:src/main/java/app/Service.java#Service.run -> ext:stdlib:java.util',
          // `new Store()` — Store declares no constructor, so the construction points at the class.
          'sym:src/main/java/app/Service.java#Service.reload -> sym:src/main/java/app/Store.java#Store',
          'sym:src/main/java/app/Service.java#Service.reload -> sym:src/main/java/app/Store.java#Store.load',
        ],
      },
    },
  };
}

function goCase(): GroundTruthCase {
  return {
    name: 'go',
    description: 'modules, embedding with method promotion, receivers and a standard-library call',
    files: {
      'go.mod': 'module example.com/gt\n\ngo 1.22\n',
      'store/store.go': `package store

type Persistable interface {
	Save()
}

type Store struct{}

func (s *Store) Save() {}

func (s *Store) Load() string {
	return ""
}

func New() *Store {
	return &Store{}
}
`,
      'service/service.go': `package service

import (
	"fmt"

	"example.com/gt/store"
)

type Service struct {
	store.Store
}

func (s *Service) Run() {
	s.Save()
	fmt.Println("ran")
}

func (s *Service) Reload() string {
	inner := store.New()

	return inner.Load()
}
`,
    },
    expected: {
      declarations: [
        'sym:store/store.go#Persistable',
        'sym:store/store.go#Persistable.Save',
        'sym:store/store.go#Store',
        'sym:store/store.go#Store.Save',
        'sym:store/store.go#Store.Load',
        'sym:store/store.go#New',
        'sym:service/service.go#Service',
        'sym:service/service.go#Service.Run',
        'sym:service/service.go#Service.Reload',
      ],
      edges: {
        IMPORTS: [
          'file:service/service.go -> ext:stdlib:fmt',
          // A Go package is a directory, so the import anchors on the package's first exported
          // declaration by identifier order — `New` sorts before `Persistable` and `Store`.
          'file:service/service.go -> sym:store/store.go#New',
        ],
        // Embedding promotes the embedded type's methods, which is what EXTENDS records.
        EXTENDS: ['sym:service/service.go#Service -> sym:store/store.go#Store'],
        CALLS: [
          'sym:service/service.go#Service.Run -> sym:store/store.go#Store.Save',
          'sym:service/service.go#Service.Run -> ext:stdlib:fmt',
          'sym:service/service.go#Service.Reload -> sym:store/store.go#New',
          'sym:service/service.go#Service.Reload -> sym:store/store.go#Store.Load',
        ],
      },
    },
  };
}
