import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// Structural checks of the GitHub workflows. Expressions are compared as literal strings;
// actionlint (master.yml) type-checks them.
const github = fileURLToPath(new URL('../.github/', import.meta.url));
const source = (file) => readFileSync(`${github}${file}`, 'utf8');
const workflowFiles = readdirSync(`${github}workflows`).filter((file) => /\.ya?ml$/.test(file)).sort();
const workflows = Object.fromEntries(workflowFiles.map((file) => [file, yaml.load(source(`workflows/${file}`))]));
const publish = workflows['publish.yml'];
const release = workflows['release.yml'];
const docs = workflows['docs.yml'];
const scripts = (job) => (job.steps || []).map((step) => step.run || '').join('\n');
const needs = (job) => [job.needs || []].flat();
const ancestors = (jobs, name, seen = new Set()) => {
  for (const parent of needs(jobs[name])) {
    if (!seen.has(parent)) { seen.add(parent); ancestors(jobs, parent, seen); }
  }
  return seen;
};
const stepRunning = (job, pattern) => job.steps.find((step) => pattern.test(step.run || ''));
// The commands of a run script, one per line, without blank lines and shell comments.
const commands = (run) => run.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const action = (step) => step.uses?.split('@')[0];
const download = (job, name = 'release-packages') => job.steps.find((step) => action(step) === 'actions/download-artifact' && step.with?.name === name);
const digest = '${{ needs.pack.outputs.manifest_sha256 }}';
const releaseDirectory = '${{ runner.temp }}/simfinity-release';
const manifest = '"$RUNNER_TEMP/simfinity-release/manifest.json"';

describe('release archives are packed before any dependency code runs (#28)', () => {
  it('packs from a fresh checkout with no install, test or package script', () => {
    const { pack } = publish.jobs;
    expect(needs(pack)).toEqual([]);
    expect(pack.permissions).toBeUndefined();
    expect(pack.steps.map((step) => action(step) || step.name)).toEqual([
      'actions/checkout', 'actions/setup-node', 'Validate release source', 'Pack committed release source', 'actions/upload-artifact',
    ]);
    expect(pack.steps[0].with).toEqual({ ref: '${{ inputs.commit }}', 'fetch-depth': 0 });
    expect(scripts(pack)).not.toMatch(/\bnpm (ci|install|i|run|test|exec|pack)\b|\bnpx\b/);
    const step = pack.steps.find((item) => item.id === 'pack');
    expect(step.run.trim().split('\n')).toEqual([
      'node scripts/release-packages.js pack "$RUNNER_TEMP/simfinity-release"',
      `node scripts/publish-packages.js ${manifest} --registry npm --dry-run`,
      `digest=$(sha256sum ${manifest})`,
      'echo "manifest_sha256=${digest%% *}" >> "$GITHUB_OUTPUT"',
    ]);
    expect(pack.steps.at(-1).with).toEqual({
      name: 'release-packages', path: `${releaseDirectory}/`, 'if-no-files-found': 'error', 'retention-days': 30, overwrite: true,
    });
    expect(pack.outputs).toEqual({ manifest_sha256: '${{ steps.pack.outputs.manifest_sha256 }}' });
    expect(publish.on.workflow_call.outputs.manifest_sha256.value).toBe('${{ jobs.pack.outputs.manifest_sha256 }}');
  });

  it('lets no other job create or replace the release archives', () => {
    for (const [file, workflow] of Object.entries(workflows)) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (file === 'publish.yml' && name === 'pack') continue;
        expect(scripts(job)).not.toContain('release-packages.js pack');
        expect((job.steps || []).filter((step) => action(step) === 'actions/upload-artifact' && step.with?.name === 'release-packages')).toEqual([]);
      }
    }
  });

  it('runs every install and test of the run after packing', () => {
    for (const [name, job] of Object.entries(publish.jobs)) {
      if (name === 'pack') continue;
      if (job.uses || /\bnpm (ci|install|run|test)\b/.test(scripts(job))) expect([...ancestors(publish.jobs, name)]).toContain('pack');
    }
  });

  it('consumer-tests the packed archives and pins every publish job to the packed manifest digest', () => {
    const { build } = publish.jobs;
    expect(needs(build)).toEqual(['pack']);
    expect(download(build).with).toEqual({ name: 'release-packages', path: releaseDirectory });
    const consumers = stepRunning(build, /test:packages/);
    expect(consumers.run.trim()).toBe(`npm run test:packages -- ${manifest}`);
    expect(consumers.env).toEqual({ SIMFINITY_RELEASE_MANIFEST_SHA256: digest });
    expect(build.steps.indexOf(download(build))).toBeLessThan(build.steps.indexOf(stepRunning(build, /^npm ci$/)));
    expect(scripts(build)).not.toContain('release-packages.js');
    const publishers = { 'publish-npm': ['npm', ['pack', 'verify-tag']], 'publish-gpr': ['github', ['pack', 'verify-tag', 'publish-npm']] };
    for (const [name, [registry, dependencies]] of Object.entries(publishers)) {
      const job = publish.jobs[name];
      expect(needs(job)).toEqual(dependencies);
      expect(download(job).with).toEqual({ name: 'release-packages', path: releaseDirectory });
      const step = stepRunning(job, /publish-packages\.js/);
      expect(step.run).toBe(`node scripts/publish-packages.js ${manifest} --registry ${registry} --execute`);
      expect(step.env).toEqual({
        ...(registry === 'github' ? { NODE_AUTH_TOKEN: '${{ github.token }}' } : {}),
        SIMFINITY_RELEASE_COMMIT: '${{ inputs.commit }}',
        SIMFINITY_RELEASE_MANIFEST_SHA256: digest,
      });
      expect(job.steps.indexOf(download(job))).toBeLessThan(job.steps.indexOf(step));
    }
  });

  it('verifies the GitHub release assets against the packed manifest digest before attaching them', () => {
    const job = release.jobs['github-release'];
    expect(needs(job)).toContain('packages');
    expect(download(job).with).toEqual({ name: 'release-packages', path: releaseDirectory });
    const verify = stepRunning(job, /release-packages\.js assets/);
    expect(verify.run).toBe(`node scripts/release-packages.js assets ${manifest} > "$RUNNER_TEMP/release-assets.txt"`);
    expect(verify.env).toEqual({ SIMFINITY_RELEASE_MANIFEST_SHA256: '${{ needs.packages.outputs.manifest_sha256 }}' });
    const steps = job.steps;
    expect(steps.indexOf(verify)).toBeGreaterThan(steps.indexOf(download(job)));
    expect(steps.indexOf(verify)).toBeGreaterThan(steps.indexOf(download(job, 'npm-verification')));
    expect(steps.indexOf(verify)).toBeLessThan(steps.indexOf(stepRunning(job, /gh release upload/)));
  });
});

describe('release source validation lives in release-state.js (#155)', () => {
  it.each([
    ['release', 'eslint-plugin-v0.1.0', false],
    ['release', 'v3.8.1', true],
    ['release', 'v3.9.0-rc.1', true],
    ['push', 'v3.8.1', true],
    ['workflow_dispatch', 'master', true],
  ])('selects runtime release sources for %s / %s: %s', (event, tag, expected) => {
    // This condition uses only JS-compatible Actions operators and startsWith.
    const select = new Function('github', 'startsWith', `return (${release.jobs.source.if});`);
    const context = { repository: 'simtlix/simfinity.js', event_name: event, event: { deleted: false, release: { tag_name: tag } } };
    const startsWith = (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase());
    expect(select(context, startsWith)).toBe(expected);
    expect(select({ ...context, repository: 'someone/fork' }, startsWith)).toBe(false);
    expect(select({ ...context, event: { ...context.event, deleted: true } }, startsWith)).toBe(false);
  });

  it('validates the selected tag and commit in Node and keeps only the ref check in shell', () => {
    const step = publish.jobs.pack.steps.find((item) => item.name === 'Validate release source');
    expect(step.env).toEqual({ RELEASE_TAG: '${{ inputs.tag }}', SOURCE_COMMIT: '${{ inputs.commit }}', DRY_RUN: '${{ inputs.dry_run }}' });
    expect(step.run.trim().split('\n').map((line) => line.trim())).toEqual([
      'if [ "$DRY_RUN" = true ]; then',
      'node scripts/release-state.js verify-source "$RELEASE_TAG" "$SOURCE_COMMIT" --preview',
      'else',
      'test "$GITHUB_REF" = "refs/tags/$RELEASE_TAG"',
      'node scripts/release-state.js verify-source "$RELEASE_TAG" "$SOURCE_COMMIT"',
      'fi',
    ]);
    expect(publish.jobs.pack.steps.indexOf(step)).toBeLessThan(publish.jobs.pack.steps.findIndex((item) => item.id === 'pack'));
    const recheck = publish.jobs['verify-tag'];
    expect(recheck.if).toBe('${{ !inputs.dry_run }}');
    expect(needs(recheck)).toEqual(['build', 'databases']);
    expect(scripts(recheck).trim()).toBe('node scripts/release-state.js verify-source "$RELEASE_TAG" "$SOURCE_COMMIT"');
    expect(Object.values(publish.jobs).map(scripts).join('\n')).not.toMatch(/rev-parse|merge-base|--input-type=module|release-packages\.js check/);
  });
});

describe('workflows run pinned actions, Node and npm (#121)', () => {
  const remote = (value) => !value.startsWith('./');
  const usesLines = (file) => source(`workflows/${file}`).split('\n')
    .map((line) => line.match(/^\s*(?:-\s+)?uses:\s*(.*)$/)?.[1]).filter((value) => value !== undefined);
  const parsedUses = (workflow) => Object.values(workflow.jobs).flatMap((job) => [job.uses, ...(job.steps || []).map((step) => step.uses)]).filter(Boolean);

  it('reads every workflow', () => {
    expect(workflowFiles).toEqual(expect.arrayContaining(['barber.yml', 'database-integration.yml', 'docs.yml', 'master.yml', 'publish.yml', 'release.yml']));
  });

  it.each(workflowFiles)('%s pins every remote action to a full commit SHA with its release', (file) => {
    const lines = usesLines(file);
    // Comments are invisible to the YAML parser, so the text scan must see every parsed `uses`.
    expect(lines.map((line) => line.split(' #')[0].trim())).toEqual(parsedUses(workflows[file]));
    for (const line of lines.filter(remote)) expect(line).toMatch(/^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('gives each pinned commit one release comment and each action release one commit', () => {
    const pins = workflowFiles.flatMap((file) => usesLines(file).filter(remote).map((line) => line.match(/^(.+)@([0-9a-f]{40}) # (v\S+)$/).slice(1)));
    expect(pins.length).toBeGreaterThan(0);
    const bySha = new Map();
    const byRelease = new Map();
    for (const [name, sha, version] of pins) {
      expect(bySha.get(sha) ?? version).toBe(version);
      expect(byRelease.get(`${name}@${version}`) ?? sha).toBe(sha);
      bySha.set(sha, version);
      byRelease.set(`${name}@${version}`, sha);
    }
  });

  it('packs and publishes with one exact Node version and an exact npm that supports trusted publishing', () => {
    const versions = ['pack', 'publish-npm', 'publish-gpr'].map((name) => (
      publish.jobs[name].steps.find((step) => action(step) === 'actions/setup-node').with['node-version']
    ));
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versions).toEqual([versions[0], versions[0], versions[0]]);
    const installs = workflowFiles.flatMap((file) => [...source(`workflows/${file}`).matchAll(/npm install --global npm@(\S+)/g)].map((match) => match[1]));
    expect(installs).toHaveLength(2);
    expect(new Set(installs).size).toBe(1);
    expect(scripts(publish.jobs['publish-npm'])).toContain(`npm install --global npm@${installs[0]} --ignore-scripts`);
    expect(installs[0]).toMatch(/^11\.\d+\.\d+$/);
    const [, minor, patch] = installs[0].split('.').map(Number);
    expect(minor > 5 || (minor === 5 && patch >= 1)).toBe(true);
  });

  it('keeps the npm trusted publisher identity and permissions', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] }, release: { types: ['published'] }, workflow_dispatch: null });
    expect(release.jobs.packages.uses).toBe('./.github/workflows/publish.yml');
    expect(release.jobs.packages.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write' });
    expect(publish.permissions).toEqual({ contents: 'read' });
    expect(publish.jobs['publish-npm'].environment).toBe('npm-release');
    expect(publish.jobs['publish-npm'].permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('lets Dependabot propose action pin updates only', () => {
    expect(yaml.load(source('dependabot.yml'))).toEqual({
      version: 2,
      updates: [{ 'package-ecosystem': 'github-actions', directory: '/', schedule: { interval: 'weekly' }, groups: { actions: { patterns: ['*'] } } }],
    });
  });
});

describe('GitHub release creation (#122, #125)', () => {
  const job = release.jobs['github-release'];
  const lookup = job.steps.find((step) => step.id === 'existing');
  const publication = stepRunning(job, /gh release create/);

  it('creates a GitHub release only after a complete lookup reports none', () => {
    expect(lookup.name).toBe('Find the GitHub release for this tag');
    expect(lookup.env).toEqual({ GH_TOKEN: '${{ github.token }}', RELEASE_TAG: '${{ needs.source.outputs.tag }}' });
    expect(lookup.run).toBe('node scripts/github-release.js find "$RELEASE_TAG" >> "$GITHUB_OUTPUT"');
    expect(job.steps.indexOf(publication)).toBe(job.steps.indexOf(lookup) + 1);
    expect(publication.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      RELEASE_TAG: '${{ needs.source.outputs.tag }}',
      PRERELEASE: '${{ needs.source.outputs.prerelease }}',
      RELEASE_EXISTS: '${{ steps.existing.outputs.exists }}',
    });
    expect(commands(publication.run).slice(0, 5)).toEqual([
      'case "$RELEASE_EXISTS" in',
      'true) ;;',
      'false) gh release create "$RELEASE_TAG" --verify-tag --generate-notes --title "$RELEASE_TAG" --draft ;;',
      '*) echo \'The GitHub release lookup did not complete\' >&2; exit 1 ;;',
      'esac',
    ]);
    expect(job.permissions).toEqual({ contents: 'write' });
    for (const workflow of Object.values(workflows)) {
      for (const item of Object.values(workflow.jobs)) expect(scripts(item)).not.toMatch(/gh release view/);
    }
  });

  it('derives the pre-release and latest flags from the package version, clearing pre-release in its own call', () => {
    expect(commands(publication.run).slice(5)).toEqual([
      'mapfile -t assets < "$RUNNER_TEMP/release-assets.txt"',
      'gh release upload "$RELEASE_TAG" "${assets[@]}" --clobber',
      'if [ "$PRERELEASE" = true ]; then',
      'gh release edit "$RELEASE_TAG" --draft=false --prerelease --latest=false',
      'else',
      'gh release edit "$RELEASE_TAG" --prerelease=false',
      'gh release edit "$RELEASE_TAG" --draft=false --latest',
      'fi',
      'echo "Released $RELEASE_TAG after both registries and npm integrity checks passed." >> "$GITHUB_STEP_SUMMARY"',
    ]);
    // Only the files the digest-verified manifest lists, plus the npm evidence, are attached.
    expect(Object.values(workflows).flatMap((workflow) => Object.values(workflow.jobs)).map(scripts).join('\n')).not.toMatch(/gh release upload[^\n]*\*/);
    expect(Object.values(workflows).flatMap((workflow) => Object.values(workflow.jobs)).map(scripts).join('\n').match(/gh release (create|edit|upload)/g))
      .toEqual(['gh release create', 'gh release upload', 'gh release edit', 'gh release edit', 'gh release edit']);
  });
});

describe('documentation deploys only move GitHub Pages forward (#123)', () => {
  const { build, gate, deploy } = docs.jobs;
  const check = () => gate.steps.find((step) => step.id === 'gate');

  it('records the documented version and commit in the build', () => {
    expect(build.outputs).toEqual({
      pages_artifact: 'github-pages-${{ github.run_attempt }}',
      version: '${{ steps.version.outputs.version }}',
      commit: '${{ steps.version.outputs.commit }}',
    });
    const step = build.steps.find((item) => item.id === 'version');
    expect(commands(step.run)).toEqual([
      'node --input-type=module -e \'import { readFileSync } from "node:fs"; console.log("version=" + JSON.parse(readFileSync("package.json", "utf8")).version)\' >> "$GITHUB_OUTPUT"',
      'commit=$(git rev-parse HEAD)',
      'echo "commit=$commit" >> "$GITHUB_OUTPUT"',
    ]);
    expect(build.steps[0].with).toEqual({ 'fetch-depth': 0, ref: '${{ inputs.source_ref || github.sha }}' });
  });

  it('decides in a gate job with no environment and no write scope', () => {
    expect(gate.if).toBe('inputs.deploy && (github.ref == \'refs/heads/master\' || startsWith(github.ref, \'refs/tags/v\'))');
    expect(needs(gate)).toEqual(['build']);
    expect(gate.environment).toBeUndefined();
    expect(gate.permissions).toEqual({ contents: 'read', deployments: 'read' });
    expect(gate.outputs).toEqual({ deploy: '${{ steps.gate.outputs.deploy }}' });
    expect(gate.steps.map((step) => action(step) || step.name)).toEqual([
      'actions/checkout', 'actions/setup-node', 'Allow only a stable, current version that keeps Pages moving forward', 'Report documentation the live site already contains',
    ]);
    expect(gate.steps[0].with).toEqual({ 'fetch-depth': 0 });
    expect(check().env).toEqual({
      RELEASE_VERSION: '${{ needs.build.outputs.version }}',
      SOURCE_COMMIT: '${{ needs.build.outputs.commit }}',
      GH_TOKEN: '${{ github.token }}',
    });
    expect(check().run).toBe('node scripts/release-state.js verify-docs "$RELEASE_VERSION" "$SOURCE_COMMIT" >> "$GITHUB_OUTPUT"');
  });

  it('reports documentation the live site already contains as a notice, not a failure', () => {
    const report = gate.steps.at(-1);
    expect(report.if).toBe('steps.gate.outputs.deploy == \'false\'');
    expect(report.env).toEqual({
      SOURCE_COMMIT: '${{ needs.build.outputs.commit }}',
      LIVE_COMMIT: '${{ steps.gate.outputs.live }}',
      LIVE_DEPLOYMENT: '${{ steps.gate.outputs.deployment }}',
    });
    expect(commands(report.run)).toEqual([
      'message="GitHub Pages deployment $LIVE_DEPLOYMENT already serves $LIVE_COMMIT, which contains $SOURCE_COMMIT; documentation was not deployed again."',
      'echo "::notice title=Documentation already live::$message"',
      'echo "$message" >> "$GITHUB_STEP_SUMMARY"',
    ]);
    expect(report['continue-on-error']).toBeUndefined();
  });

  it('deploys only when the gate says so, and fails a re-run that the live site has overtaken', () => {
    expect(deploy.if).toBe('needs.gate.outputs.deploy == \'true\'');
    expect(needs(deploy)).toEqual(['build', 'gate']);
    expect(deploy.environment).toEqual({ name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' });
    expect(deploy.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write', deployments: 'read' });
    expect(deploy.steps.map((step) => action(step) || step.name)).toEqual([
      'actions/checkout', 'actions/setup-node', 'Prevent an old retry from replacing newer documentation', 'actions/configure-pages', 'actions/deploy-pages',
    ]);
    expect(deploy.steps[0].with).toEqual({ 'fetch-depth': 0 });
    const recheck = stepRunning(deploy, /release-state/);
    expect(recheck.env).toEqual(check().env);
    // bash -e: a failing gate or any answer but deploy=true fails the job, naming the live deployment.
    expect(recheck.shell).toBe('bash');
    expect(commands(recheck.run)).toEqual([
      'result=$(node scripts/release-state.js verify-docs "$RELEASE_VERSION" "$SOURCE_COMMIT")',
      'echo "$result"',
      'if ! grep -qx deploy=true <<< "$result"; then',
      'echo "::error title=Documentation already live::The live site already contains $SOURCE_COMMIT (${result//$\'\\n\'/ }); not deploying again"',
      'exit 1',
      'fi',
    ]);
    expect(deploy.steps.at(-1).with).toEqual({ artifact_name: '${{ needs.build.outputs.pages_artifact }}' });
  });

  it('runs the gate before every Pages deployment and deploys Pages from one job only', () => {
    const jobs = Object.entries(workflows).flatMap(([file, workflow]) => Object.entries(workflow.jobs).map(([name, job]) => [`${file}/${name}`, job]));
    expect(jobs.filter(([, job]) => scripts(job).includes('release-state.js verify-docs')).map(([name]) => name)).toEqual(['docs.yml/gate', 'docs.yml/deploy']);
    expect(Object.values(workflows).map((workflow) => Object.values(workflow.jobs).map(scripts).join('\n')).join('\n')).not.toContain('verify-current "$RELEASE_VERSION"');
    expect(jobs.filter(([, job]) => (job.steps || []).some((step) => action(step) === 'actions/deploy-pages')).map(([name]) => name)).toEqual(['docs.yml/deploy']);
    expect(jobs.filter(([, job]) => job.environment?.name === 'github-pages' || job.environment === 'github-pages').map(([name]) => name)).toEqual(['docs.yml/deploy']);
  });

  it('lets the release documentation job grant the gate its deployments scope and never deploys prerelease documentation', () => {
    const job = release.jobs.documentation;
    expect(job.uses).toBe('./.github/workflows/docs.yml');
    expect(needs(job)).toEqual(['source', 'github-release']);
    expect(job.if).toBe('github.event_name != \'workflow_dispatch\' && needs.source.outputs.prerelease != \'true\'');
    expect(job.with).toEqual({ deploy: true, source_ref: '${{ needs.source.outputs.commit }}' });
    expect(job.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write', deployments: 'read' });
  });

  it('never requests more GITHUB_TOKEN scopes in a called workflow than its caller grants', () => {
    const level = { none: 0, read: 1, write: 2 };
    const callee = (job) => /^\.\/\.github\/workflows\/(.+\.ya?ml)$/.exec(job.uses || '')?.[1];
    const violations = [];
    const calls = [];
    const visit = (file, granted, path) => {
      const workflow = workflows[file];
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const requested = job.permissions ?? workflow.permissions;
        expect(typeof requested).toBe('object');
        for (const [scope, value] of Object.entries(requested)) {
          if (!(level[value] <= level[granted[scope] ?? 'none'])) violations.push(`${path}/${name} requests ${scope}: ${value}`);
        }
        if (callee(job)) { calls.push(`${path}/${name}`); visit(callee(job), requested, `${path}/${name}`); }
      }
    };
    for (const [file, workflow] of Object.entries(workflows)) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (callee(job)) { calls.push(`${file}/${name}`); visit(callee(job), job.permissions ?? workflow.permissions, `${file}/${name}`); }
      }
    }
    expect(calls).toEqual(expect.arrayContaining(['release.yml/packages', 'release.yml/documentation', 'release.yml/packages/databases', 'publish.yml/databases']));
    expect(violations).toEqual([]);
  });
});

describe('pull request CI cancels superseded runs only (#147)', () => {
  it.each([
    ['master.yml', 'library-ci'],
    ['database-integration.yml', 'database-integration'],
  ])('%s cancels only an older run of the same pull request', (file, prefix) => {
    expect(workflows[file].concurrency).toEqual({
      group: `${prefix}-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`,
      'cancel-in-progress': '${{ github.event_name == \'pull_request\' }}',
    });
  });

  it('leaves release, publication, documentation and example runs as they were', () => {
    expect(release.concurrency).toEqual({ group: 'simfinity-release', queue: 'max' });
    expect(publish.concurrency).toBeUndefined();
    expect(docs.concurrency).toEqual({ group: 'docs-${{ inputs.deploy && \'production\' || github.ref }}', queue: 'max' });
    expect(workflows['barber.yml'].concurrency).toEqual({ group: 'barber-${{ github.ref }}', 'cancel-in-progress': true });
    for (const workflow of Object.values(workflows)) {
      for (const job of Object.values(workflow.jobs)) expect(job.concurrency).toBeUndefined();
    }
    const groups = Object.values(workflows).map((workflow) => workflow.concurrency?.group).filter(Boolean);
    expect(groups.filter((group) => group === 'simfinity-release')).toHaveLength(1);
  });
});
