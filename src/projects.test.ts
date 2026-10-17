import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjects } from './projects.js';

// Each case gets its own throwaway config dir (loadProjects reads projects.d/ relative
// to the config file's location, so the fixture must be a real directory on disk).
function withConfigDir(fn: (dir: string, configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'aven-projects-'));
  try {
    fn(dir, join(dir, 'projects.config.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = {
  projects: [
    { slug: 'alpha', repos: ['Org/alpha'], systemPrompt: 'json prompt', env: {}, mcp: [] },
    { slug: 'beta', repos: ['Org/beta'], env: {}, mcp: [] },
  ],
};

test('JSON-only config: systemPrompt comes from the JSON field', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify(BASE));
    const reg = loadProjects(cfg);
    assert.equal(reg.projects[0].systemPrompt, 'json prompt');
    assert.equal(reg.projects[1].systemPrompt, undefined);
  });
});

test('projects.d/<slug>.md wins over the JSON field; unknown-slug files are ignored', () => {
  withConfigDir((dir, cfg) => {
    writeFileSync(cfg, JSON.stringify(BASE));
    mkdirSync(join(dir, 'projects.d'));
    writeFileSync(join(dir, 'projects.d', 'alpha.md'), 'file prompt\nwith two lines\n');
    writeFileSync(join(dir, 'projects.d', 'ghost.md'), 'nobody reads this');
    const reg = loadProjects(cfg);
    assert.equal(reg.projects[0].systemPrompt, 'file prompt\nwith two lines');
    assert.equal(reg.projects[1].systemPrompt, undefined);
  });
});

test('an empty prompt file falls back to the JSON field', () => {
  withConfigDir((dir, cfg) => {
    writeFileSync(cfg, JSON.stringify(BASE));
    mkdirSync(join(dir, 'projects.d'));
    writeFileSync(join(dir, 'projects.d', 'alpha.md'), '\n  \n');
    const reg = loadProjects(cfg);
    assert.equal(reg.projects[0].systemPrompt, 'json prompt');
  });
});

test('validation: mcp entries need a name and a command or url', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(
      cfg,
      JSON.stringify({ projects: [{ slug: 'a', repos: ['O/r'], mcp: [{ name: 'x' }] }] }),
    );
    assert.throws(() => loadProjects(cfg), /"command" or "url"/);
  });
});

test('validation: slug and repos are required', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ projects: [{ slug: 'a', repos: [] }] }));
    assert.throws(() => loadProjects(cfg), /at least one repo/);
  });
});

// ── slice 2: per-tenant registry (workspaces block) ──────────────────────────
import { teamProjects, projectOwnerTeam, workspacePrefix } from './projects.js';

const HOME = 'T0HOME111';
const CLIENT = 'T0CLIENT22';

const MULTI = {
  projects: BASE.projects,
  workspaces: { [HOME]: ['alpha', 'beta'], [CLIENT]: ['beta'] }, // beta is shared
};

test('teamProjects — no workspaces block: home gets all, others nothing', () => {
  const reg = { projects: BASE.projects };
  assert.deepEqual(teamProjects(reg, HOME, HOME).map((p) => p.slug), ['alpha', 'beta']);
  assert.deepEqual(teamProjects(reg, undefined, HOME).map((p) => p.slug), ['alpha', 'beta']);
  assert.deepEqual(teamProjects(reg, CLIENT, HOME), []);
  // static mode (no home known): the sole workspace sees everything
  assert.deepEqual(teamProjects(reg, 'T0WHATEVER', undefined).map((p) => p.slug), ['alpha', 'beta']);
});

test('teamProjects — with the block: explicit-only, config order preserved', () => {
  assert.deepEqual(teamProjects(MULTI, HOME, HOME).map((p) => p.slug), ['alpha', 'beta']);
  assert.deepEqual(teamProjects(MULTI, CLIENT, HOME).map((p) => p.slug), ['beta']);
  assert.deepEqual(teamProjects(MULTI, 'T0STRANGER', HOME), []); // installed-but-unmapped
  // undefined tenant (home context, e.g. pollers) resolves the home entry
  assert.deepEqual(teamProjects(MULTI, undefined, HOME).map((p) => p.slug), ['alpha', 'beta']);
});

test('projectOwnerTeam — first listing tenant wins; home without a block', () => {
  assert.equal(projectOwnerTeam(MULTI, 'beta', HOME), HOME); // shared → first in config order
  assert.equal(projectOwnerTeam(MULTI, 'alpha', HOME), HOME);
  assert.equal(projectOwnerTeam({ projects: BASE.projects }, 'alpha', HOME), HOME);
  const clientFirst = { projects: BASE.projects, workspaces: { [CLIENT]: ['beta'], [HOME]: ['alpha', 'beta'] } };
  assert.equal(projectOwnerTeam(clientFirst, 'beta', HOME), CLIENT);
  assert.equal(projectOwnerTeam(MULTI, 'ghost', HOME), HOME); // unknown slug → home fallback
});

test('validation: workspaces slugs must exist', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ ...BASE, workspaces: { T0X11111: ['nope'] } }));
    assert.throws(() => loadProjects(cfg), /unknown project "nope"/);
  });
});

test('workspaces entry object form: projects + per-workspace channelPrefix', () => {
  const reg = {
    projects: BASE.projects,
    workspaces: {
      [HOME]: ['alpha', 'beta'],
      [CLIENT]: { projects: ['beta'], channelPrefix: '' },
    },
  };
  // slug resolution treats both shapes identically
  assert.deepEqual(teamProjects(reg, CLIENT, HOME).map((p) => p.slug), ['beta']);
  assert.equal(projectOwnerTeam(reg, 'beta', HOME), HOME);
  // prefix: undefined for array/absent entries (→ deployment default), "" is a VALID override
  assert.equal(workspacePrefix(reg, HOME), undefined);
  assert.equal(workspacePrefix(reg, CLIENT), '');
  assert.equal(workspacePrefix(reg, undefined), undefined);
  const custom = { ...reg, workspaces: { [CLIENT]: { projects: ['beta'], channelPrefix: 'aven-' } } };
  assert.equal(workspacePrefix(custom, CLIENT), 'aven-');
});

test('validation accepts the object form and still catches unknown slugs in it', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ ...BASE, workspaces: { T0X11111: { projects: ['nope'] } } }));
    assert.throws(() => loadProjects(cfg), /unknown project "nope"/);
  });
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ ...BASE, workspaces: { T0X11111: { projects: ['alpha'], channelPrefix: '' } } }));
    assert.deepEqual(teamProjects(loadProjects(cfg), 'T0X11111', 'T0HOME').map((p) => p.slug), ['alpha']);
  });
});

test('a project with sources gets the replica mount merged into its sandbox options at load', () => {
  withConfigDir((dir, configPath) => {
    process.env.AVEN_DATA_DIR = join(dir, 'data');
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: [
            { slug: 'ops', repos: ['Org/ops'], sandbox: { privileged: false, dind: false }, sources: { slack: { workspaces: ['T1'] } } },
            { slug: 'plain', repos: ['Org/plain'] },
          ],
        }),
      );
      const reg = loadProjects(configPath);
      const ops = reg.projects.find((p) => p.slug === 'ops')!;
      // Since host-tools the store never rides into the sandbox: the options are exactly the config's.
      assert.deepEqual(ops.sandbox, { privileged: false, dind: false }, 'no replica mount is injected');
      assert.equal(reg.projects.find((p) => p.slug === 'plain')!.sandbox, undefined, 'no sources → untouched');
      // A hand-written mount is the operator's own and stays as written.
      writeFileSync(
        configPath,
        JSON.stringify({ projects: [{ slug: 'ops', repos: ['Org/ops'], sandbox: { privileged: false, dind: false, mounts: ['/elsewhere:/data/sources'] }, sources: { slack: { workspaces: ['T1'] } } }] }),
      );
      assert.deepEqual(loadProjects(configPath).projects[0]!.sandbox?.mounts, ['/elsewhere:/data/sources']);
    } finally {
      delete process.env.AVEN_DATA_DIR;
    }
  });
});

test('gitFlow: "pr" | "direct" accepted, absent stays undefined (→ pr); anything else fails the boot', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(
      cfg,
      JSON.stringify({
        projects: [
          { slug: 'ledger', repos: ['Org/ledger'], gitFlow: 'direct' },
          { slug: 'code', repos: ['Org/code'], gitFlow: 'pr' },
          { slug: 'legacy', repos: ['Org/legacy'] },
        ],
      }),
    );
    const reg = loadProjects(cfg);
    assert.deepEqual(reg.projects.map((p) => p.gitFlow), ['direct', 'pr', undefined]);
    // The mode is explicit only: a typo must not silently fall back to the PR flow.
    writeFileSync(cfg, JSON.stringify({ projects: [{ slug: 'ledger', repos: ['Org/ledger'], gitFlow: 'trunk' }] }));
    assert.throws(() => loadProjects(cfg), /project "ledger" gitFlow must be one of "pr", "direct", got "trunk"/);
    writeFileSync(cfg, JSON.stringify({ projects: [{ slug: 'ledger', repos: ['Org/ledger'], gitFlow: true }] }));
    assert.throws(() => loadProjects(cfg), /gitFlow must be one of/);
  });
});

test('the shipped projects.config.example.json loads', () => {
  const reg = loadProjects(new URL('../projects.config.example.json', import.meta.url).pathname);
  assert.deepEqual(reg.projects.map((p) => p.slug), ['acme-shop', 'acme-cms', 'acme-monitoring', 'ops-plain']);
});

test('messaging: a valid block loads; an invalid one fails the boot naming the project', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ projects: [{ ...BASE.projects[0], messaging: { send: true, accept: ['home/owen-ops', '*'] } }, BASE.projects[1]] }));
    const reg = loadProjects(cfg);
    assert.deepEqual(reg.projects[0]!.messaging, { send: true, accept: ['home/owen-ops', '*'] });
    assert.equal(reg.projects[1]!.messaging, undefined, 'a project without the block keeps none');
    writeFileSync(cfg, JSON.stringify({ projects: [{ ...BASE.projects[0], messaging: { accept: ['bluefin/*'] } }] }));
    assert.throws(() => loadProjects(cfg), /project "alpha" messaging\.accept: "bluefin\/\*" is not/);
  });
});

test('messaging — shared project: the block is refused at load with an error naming the project, and the project behaves as before', () => {
  withConfigDir((_dir, cfg) => {
    const shared = {
      projects: [{ ...BASE.projects[0], messaging: { accept: ['*'] } }, { ...BASE.projects[1], messaging: { send: true } }],
      workspaces: { T0HOME0001: ['alpha', 'beta'], T0CLIENT01: ['alpha'] },
    };
    writeFileSync(cfg, JSON.stringify(shared));
    const reg = loadProjects(cfg);
    assert.equal(reg.projects[0]!.messaging, undefined, 'alpha is shared by two tenants: no messaging');
    assert.equal(reg.projects[0]!.systemPrompt, 'json prompt', 'and otherwise loads as before');
    assert.deepEqual(reg.projects[1]!.messaging, { send: true }, 'beta has one tenant: kept');
  });
});
