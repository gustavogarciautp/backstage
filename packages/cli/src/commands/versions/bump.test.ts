/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs-extra';
import mockFs from 'mock-fs';
import { Command } from 'commander';
import { resolve as resolvePath } from 'path';
import { paths } from '../../lib/paths';
import { mapDependencies } from '../../lib/versioning';
import * as runObj from '../../lib/run';
import bump, { bumpBackstageJsonVersion } from './bump';
import { withLogCollector } from '@backstage/test-utils';

// Remove log coloring to simplify log matching
jest.mock('chalk', () => ({
  blue: (str: string) => str,
  cyan: (str: string) => str,
  green: (str: string) => str,
  magenta: (str: string) => str,
  yellow: (str: string) => str,
}));

const REGISTRY_VERSIONS: { [name: string]: string } = {
  '@backstage/core': '1.0.6',
  '@backstage/core-api': '1.0.7',
  '@backstage/theme': '2.0.0',
  '@backstage-extra/custom': '1.1.0',
  '@backstage-extra/custom-two': '2.0.0',
};

const HEADER = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1

`;

const lockfileMock = `${HEADER}
"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/core@^1.0.3":
  version "1.0.3"
  dependencies:
    "@backstage/core-api" "^1.0.3"

"@backstage/theme@^1.0.0":
  version "1.0.0"

"@backstage/core-api@^1.0.6":
  version "1.0.6"

"@backstage/core-api@^1.0.3":
  version "1.0.3"
`;

// This is the lockfile that we produce to unlock versions before we run yarn install
const lockfileMockResult = `${HEADER}
"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/theme@^1.0.0":
  version "1.0.0"
`;

describe('bump', () => {
  afterEach(() => {
    mockFs.restore();
    jest.resetAllMocks();
  });

  it('should bump backstage dependencies', async () => {
    // Make sure all modules involved in package discovery are in the module cache before we mock fs
    await mapDependencies(paths.targetDir, '@backstage/*');

    mockFs({
      '/yarn.lock': lockfileMock,
      '/lerna.json': JSON.stringify({
        packages: ['packages/*'],
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    paths.targetDir = '/';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'runPlain').mockImplementation(async (...[, , , name]) =>
      JSON.stringify({
        type: 'inspect',
        data: {
          name: name,
          'dist-tags': {
            latest: REGISTRY_VERSIONS[name],
          },
        },
      }),
    );
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);

    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null } as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/theme in b to ^2.0.0',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(runObj.runPlain).toHaveBeenCalledTimes(4);
    expect(runObj.runPlain).toHaveBeenCalledWith(
      'yarn',
      'info',
      '--json',
      '@backstage/core',
    );
    expect(runObj.runPlain).toHaveBeenCalledWith(
      'yarn',
      'info',
      '--json',
      '@backstage/theme',
    );

    expect(runObj.run).toHaveBeenCalledTimes(1);
    expect(runObj.run).toHaveBeenCalledWith('yarn', ['install']);

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.5', // not bumped since new version is within range
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.3', // not bumped
        '@backstage/theme': '^2.0.0', // bumped since newer
      },
    });
  });

  it('should bump backstage dependencies and dependencies matching pattern glob', async () => {
    // Make sure all modules involved in package discovery are in the module cache before we mock fs
    await mapDependencies(paths.targetDir, '@backstage/*');
    const customLockfileMock = `${lockfileMock}
"@backstage-extra/custom@^1.1.0":
  version "1.1.0"

"@backstage-extra/custom@^1.0.1":
  version "1.0.1"

"@backstage-extra/custom-two@^1.0.0":
  version "1.0.0"
`;
    const customLockfileMockResult = `${HEADER}
"@backstage-extra/custom-two@^1.0.0":
  version "1.0.0"

"@backstage-extra/custom@^1.1.0":
  version "1.1.0"

"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/theme@^1.0.0":
  version "1.0.0"
`;
    mockFs({
      '/yarn.lock': customLockfileMock,
      '/lerna.json': JSON.stringify({
        packages: ['packages/*'],
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
          '@backstage-extra/custom': '^1.0.1',
          '@backstage-extra/custom-two': '^1.0.0',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
          '@backstage-extra/custom': '^1.1.0',
          '@backstage-extra/custom-two': '^1.0.0',
        },
      }),
    });

    paths.targetDir = '/';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'runPlain').mockImplementation(async (...[, , , name]) =>
      JSON.stringify({
        type: 'inspect',
        data: {
          name: name,
          'dist-tags': {
            latest: REGISTRY_VERSIONS[name],
          },
        },
      }),
    );
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);

    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: '@{backstage,backstage-extra}/*' } as any);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using custom pattern glob @{backstage,backstage-extra}/*',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage-extra/custom-two',
      'Checking for updates of @backstage-extra/custom',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage-extra/custom@^1.0.1 ~> 1.1.0',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage-extra/custom-two in a to ^2.0.0',
      'bumping @backstage/theme in b to ^2.0.0',
      'bumping @backstage-extra/custom-two in b to ^2.0.0',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage-extra/custom-two : 1.0.0 ~> 2.0.0',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(runObj.runPlain).toHaveBeenCalledTimes(6);
    expect(runObj.runPlain).toHaveBeenCalledWith(
      'yarn',
      'info',
      '--json',
      '@backstage/core',
    );
    expect(runObj.runPlain).toHaveBeenCalledWith(
      'yarn',
      'info',
      '--json',
      '@backstage/theme',
    );

    expect(runObj.run).toHaveBeenCalledTimes(1);
    expect(runObj.run).toHaveBeenCalledWith('yarn', ['install']);

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toEqual(customLockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage-extra/custom': '^1.0.1',
        '@backstage-extra/custom-two': '^2.0.0',
        '@backstage/core': '^1.0.5', // not bumped since new version is within range
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage-extra/custom': '^1.1.0',
        '@backstage-extra/custom-two': '^2.0.0',
        '@backstage/core': '^1.0.3', // not bumped
        '@backstage/theme': '^2.0.0', // bumped since newer
      },
    });
  });

  it('should ignore not found packages', async () => {
    // Make sure all modules involved in package discovery are in the module cache before we mock fs
    await mapDependencies(paths.targetDir, '@backstage/*');
    mockFs({
      '/yarn.lock': lockfileMockResult,
      '/lerna.json': JSON.stringify({
        packages: ['packages/*'],
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^2.0.0',
        },
      }),
    });

    paths.targetDir = '/';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'runPlain').mockImplementation(async () => '');
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);

    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null } as any);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core',
      'Package info not found, ignoring package @backstage/theme',
      'Package info not found, ignoring package @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core',
      'Package info not found, ignoring package @backstage/theme',
      'Package info not found, ignoring package @backstage/core',
      'All Backstage packages are up to date!',
    ]);

    expect(runObj.run).toHaveBeenCalledTimes(0);

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.5', // not bumped
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.3', // not bumped
        '@backstage/theme': '^2.0.0', // not bumped
      },
    });
  });
});

describe('bumpBackstageJsonVersion', () => {
  afterEach(() => {
    mockFs.restore();
    jest.resetAllMocks();
  });

  it('should bump version in backstage.json', async () => {
    mockFs({
      '/backstage.json': JSON.stringify({ version: '0.0.1' }),
    });
    paths.targetDir = '/';
    const latest = '1.4.1';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'runPlain').mockImplementation(async (...[, , , name]) =>
      JSON.stringify({
        type: 'inspect',
        data: {
          name,
          'dist-tags': {
            latest,
          },
        },
      }),
    );
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);

    await bumpBackstageJsonVersion();

    const json = await fs.readJson('/backstage.json');
    expect(json).toEqual({ version: '1.4.1' });
  });

  it("should create backstage.json if doesn't exist", async () => {
    mockFs({});
    paths.targetDir = '/';
    const latest = '1.4.1';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'runPlain').mockImplementation(async (...[, , , name]) =>
      JSON.stringify({
        type: 'inspect',
        data: {
          name,
          'dist-tags': {
            latest,
          },
        },
      }),
    );
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);

    await bumpBackstageJsonVersion();

    const json = await fs.readJson('/backstage.json');
    expect(json).toEqual({ version: '1.4.1' });
  });
});
