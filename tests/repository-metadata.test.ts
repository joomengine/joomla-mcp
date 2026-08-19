import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const repositoryUrl = 'https://github.com/joomengine/joomla-mcp-ts';
const containerUrl = 'ghcr.io/joomengine/joomla-mcp-ts';

describe('repository metadata', () => {
  it('uses the canonical JoomEngine repository coordinates everywhere users install or inspect the project', async () => {
    const [dockerfile, readme, service, deployment, packageSource] = await Promise.all([
      readFile('Dockerfile', 'utf8'),
      readFile('README.md', 'utf8'),
      readFile('deploy/systemd/joomla-mcp.service', 'utf8'),
      readFile('docs/DEPLOYMENT.md', 'utf8'),
      readFile('package.json', 'utf8'),
    ]);
    const packageDocument = JSON.parse(packageSource) as {
      readonly name: string;
      readonly homepage: string;
      readonly bugs: { readonly url: string };
      readonly repository: { readonly type: string; readonly url: string };
    };

    expect(packageDocument).toMatchObject({
      name: '@joomengine/joomla-mcp',
      homepage: `${repositoryUrl}#readme`,
      bugs: { url: `${repositoryUrl}/issues` },
      repository: {
        type: 'git',
        url: `git+${repositoryUrl}.git`,
      },
    });
    expect(dockerfile).toContain(`org.opencontainers.image.source="${repositoryUrl}"`);
    expect(readme).toContain(`git clone ${repositoryUrl}.git`);
    expect(service).toContain(`Documentation=${repositoryUrl}`);
    expect(deployment).toContain(`${containerUrl}@sha256:`);
  });
});
