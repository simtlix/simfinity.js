import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const path = new URL('../.github/workflows/release-eslint-plugin.yml', import.meta.url);
const workflow = existsSync(path) ? yaml.load(readFileSync(path, 'utf8')) : {};
const scripts = job => (job?.steps || []).map(step => step.run || '').join('\n');

describe('independent ESLint publication workflow', () => {
  it('uses plugin tags; dispatch only previews and never publishes', () => {
    expect(workflow.on).toEqual({ push: { tags: ['eslint-plugin-v*'] }, workflow_dispatch: null });
    expect(workflow.jobs?.publish?.if).toBe('github.event_name == \'push\' && startsWith(github.ref, \'refs/tags/eslint-plugin-v\')');
    expect(workflow.jobs?.release?.needs).toEqual(['pack', 'publish']);
    expect(workflow.jobs?.docs?.needs).toBe('release');
    expect(workflow.concurrency).toEqual({ group: 'eslint-plugin-publication', queue: 'max' });
  });
  it('packs before all installation and validates the same archive in an isolated consumer', () => {
    expect(scripts(workflow.jobs?.pack)).toContain('release-eslint-plugin.js pack');
    expect(scripts(workflow.jobs?.pack)).not.toMatch(/npm (ci|install|run|test)/);
    expect(workflow.jobs?.verify?.needs).toBe('pack');
    expect(scripts(workflow.jobs?.verify)).toContain('release-eslint-plugin.js verify');
    expect(scripts(workflow.jobs?.verify)).toContain('node tests/consumer.mjs "$RUNNER_TEMP"/eslint-release/*.tgz');
    expect(workflow.jobs?.publish?.needs).toEqual(['pack', 'verify']);
  });
  it('pins the manifest/source in every consumer and restricts publishing permission', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.publish?.environment).toBe('npm-eslint-release');
    expect(workflow.jobs?.publish?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    for (const name of ['verify', 'publish', 'release']) {
      expect(workflow.jobs?.[name]?.env?.ESLINT_RELEASE_MANIFEST_SHA256).toBe('${{ needs.pack.outputs.manifest_sha256 }}');
      expect(workflow.jobs?.[name]?.env?.ESLINT_RELEASE_COMMIT).toBe('${{ github.sha }}');
    }
    expect(scripts(workflow.jobs?.publish)).toContain('npm install --global npm@11.21.0 --ignore-scripts');
    expect(scripts(workflow.jobs?.publish)).not.toContain('npm login');
    expect(workflow.jobs?.docs?.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(scripts(workflow.jobs?.docs)).toContain('gh workflow run docs.yml --repo "$GITHUB_REPOSITORY" --ref master -f deploy=true');
    const docs = yaml.load(readFileSync(new URL('../.github/workflows/docs.yml', import.meta.url), 'utf8'));
    expect(scripts(docs.jobs.build)).toContain('release-eslint-plugin.js verify-docs');
  });
});
