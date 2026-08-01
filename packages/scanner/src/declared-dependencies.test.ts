import { describe, expect, it } from 'vitest';

import { readDeclaredDependencies } from './declared-dependencies.js';
import type { Ecosystem } from './languages.js';

const read = (ecosystem: Ecosystem, contents: string) =>
  readDeclaredDependencies({ ecosystem, contents });

describe('npm', () => {
  it('reads every dependency section', () => {
    expect(
      read(
        'npm',
        JSON.stringify({
          dependencies: { express: '^4' },
          devDependencies: { vitest: '^1' },
          peerDependencies: { react: '^19' },
          optionalDependencies: { sharp: '^0.33' },
        }),
      ),
    ).toEqual(['express', 'react', 'sharp', 'vitest']);
  });

  it('yields nothing for a manifest declaring none', () => {
    expect(read('npm', '{"name":"x"}')).toEqual([]);
  });
});

describe('composer', () => {
  it('reads require and require-dev, dropping platform requirements', () => {
    expect(
      read(
        'composer',
        JSON.stringify({ require: { php: '^8.2', 'ext-json': '*', 'monolog/monolog': '^3' } }),
      ),
    ).toEqual(['monolog/monolog']);
  });
});

describe('python', () => {
  it('reads a PEP 621 dependencies array, stripping version constraints', () => {
    expect(
      read('python', '[project]\nname = "x"\ndependencies = ["fastapi>=0.100", "pydantic"]\n'),
    ).toEqual(['fastapi', 'pydantic']);
  });

  it('reads a dependencies array spanning several lines', () => {
    expect(
      read('python', '[project]\ndependencies = [\n  "fastapi",\n  "uvicorn[standard]",\n]\n'),
    ).toEqual(['fastapi', 'uvicorn']);
  });

  it('reads a Poetry dependency table and drops python itself', () => {
    expect(
      read(
        'python',
        '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\nhttpx = { version = "^0.27" }\n',
      ),
    ).toEqual(['httpx', 'requests']);
  });

  it('reads requirements.txt, ignoring comments and directives', () => {
    expect(
      read(
        'python',
        '# runtime\nfastapi==0.110.0\n-r other.txt\n--index-url https://example.com\nrequests>=2 ; python_version>"3.8"\n\n',
      ),
    ).toEqual(['fastapi', 'requests']);
  });

  it('stops a table at the next header, so unrelated keys are not read', () => {
    expect(
      read('python', '[tool.poetry.dependencies]\nrequests = "^2"\n\n[tool.black]\nline-length = 100\n'),
    ).toEqual(['requests']);
  });
});

describe('go', () => {
  it('reads a require block', () => {
    expect(
      read(
        'go',
        'module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/sync v0.7.0 // indirect\n)\n',
      ),
    ).toEqual(['github.com/gin-gonic/gin', 'golang.org/x/sync']);
  });

  it('reads a single-line require', () => {
    expect(read('go', 'require github.com/pkg/errors v0.9.1\n')).toEqual([
      'github.com/pkg/errors',
    ]);
  });
});

describe('cargo', () => {
  it('reads the dependencies table', () => {
    expect(
      read('cargo', '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n'),
    ).toEqual(['serde', 'tokio']);
  });
});

describe('maven', () => {
  it('reads each dependency as group:artifact', () => {
    expect(
      read(
        'maven',
        '<project><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId><version>6</version></dependency></dependencies></project>',
      ),
    ).toEqual(['org.springframework:spring-core']);
  });

  it('reads an artifact declared without a group', () => {
    expect(
      read('maven', '<dependencies><dependency><artifactId>junit</artifactId></dependency></dependencies>'),
    ).toEqual(['junit']);
  });

  it('ignores the project coordinate itself', () => {
    // Only elements inside a <dependency> count, so the project's own artifactId is not
    // read as a dependency on itself.
    expect(read('maven', '<project><artifactId>my-service</artifactId></project>')).toEqual([]);
  });
});

describe('gradle', () => {
  it('reads quoted coordinates from every common configuration', () => {
    expect(
      read(
        'gradle',
        "dependencies {\n  implementation 'com.google.guava:guava:33.0'\n  testImplementation(\"org.junit:junit:5\")\n}\n",
      ),
    ).toEqual(['com.google.guava:guava', 'org.junit:junit']);
  });
});

describe('bundler', () => {
  it('reads gem declarations', () => {
    expect(read('bundler', "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\ngem 'puma'\n")).toEqual([
      'puma',
      'rails',
    ]);
  });
});

describe('robustness', () => {
  it('yields nothing for a malformed manifest rather than failing', () => {
    // One unreadable manifest must not cost a repository its whole scan; the manifest is
    // still reported as present.
    expect(read('npm', '{ not json')).toEqual([]);
    expect(read('maven', '<project')).toEqual([]);
  });

  it('yields nothing for an ecosystem it does not read', () => {
    expect(read('nuget', '<Project><PackageReference Include="Newtonsoft.Json" /></Project>')).toEqual(
      [],
    );
  });

  it('sorts and de-duplicates, so two scans agree', () => {
    const names = read(
      'npm',
      JSON.stringify({ dependencies: { b: '1', a: '1' }, devDependencies: { a: '1' } }),
    );

    expect(names).toEqual(['a', 'b']);
  });
});
