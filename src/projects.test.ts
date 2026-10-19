import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjects } from './projects.js';
import { log } from './log.js';
import { ConfigError } from './sources/errors.js';

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

test('validation: an oauth object loads on a gateway-m2m entry; a malformed one fails the load naming the project', () => {
  const gw = (oauth: unknown, extra: Record<string, unknown> = { auth: 'gateway-m2m' }) => ({
    projects: [{ slug: 'caldora', repos: ['O/r'], mcp: [{ name: 'gw', url: 'http://gw.internal.example:4600/gw/caldora/mcp', ...extra, oauth }] }],
  });
  withConfigDir((_dir, cfg) => {
    const oauth = { tokenUrl: 'https://idp.example/oauth2/token', scope: 'gw-caldora/bot' };
    writeFileSync(cfg, JSON.stringify(gw(oauth)));
    assert.deepEqual(loadProjects(cfg).projects[0].mcp?.[0].oauth, oauth);
    const refused: [unknown, Record<string, unknown> | undefined, RegExp][] = [
      [oauth, {}, /project "caldora" mcp "gw": "oauth" only goes on an entry with "auth": "gateway-m2m"/],
      [{}, undefined, /project "caldora" mcp "gw" oauth\.tokenUrl must be an https URL/],
      [{ tokenUrl: 'http://idp.example/oauth2/token' }, undefined, /project "caldora" mcp "gw" oauth\.tokenUrl must be an https URL/],
      [{ ...oauth, scope: 7 }, undefined, /oauth\.scope must be a non-empty string/],
      [{ ...oauth, audience: false }, undefined, /oauth\.audience must be a non-empty string/],
      [{ ...oauth, resource: {} }, undefined, /oauth\.resource must be a non-empty string/],
      [{ ...oauth, clientAuth: 'jwt' }, undefined, /oauth\.clientAuth must be "basic" or "post"/],
      [{ ...oauth, clientSecret: 'leaked' }, undefined, /client credentials go in the env/],
    ];
    for (const [o, extra, re] of refused) {
      writeFileSync(cfg, JSON.stringify(gw(o, extra)));
      assert.throws(() => loadProjects(cfg), (e: Error) => re.test(e.message) && e.message.includes(cfg), JSON.stringify(o));
    }
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

test('dispatch is retired: a leftover `dispatch` block warns once, naming the project, and is ignored — the project loads as before', (t) => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ projects: [{ ...BASE.projects[0], dispatch: { auto: ['beta'], maxPerDay: 3 } }, BASE.projects[1]] }));
    const warn = t.mock.method(log, 'warn', () => {});
    const reg = loadProjects(cfg);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]!.arguments[0]), /project "alpha" dispatch is retired — agent messaging replaces it; the block is ignored/);
    assert.equal('dispatch' in reg.projects[0]!, false, 'the block is dropped');
    assert.equal(reg.projects[0]!.systemPrompt, 'json prompt');
  });
});

// ── the sandbox driver after the Daytona driver's removal (OpenSpec retire-daytona-driver D3/D4) ────────

const refused = (re: RegExp) => (e: Error) => e instanceof ConfigError && re.test(e.message);

test('driver — "daytona" is refused at load, naming the project, its field, the removal and the fix (D3)', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ projects: [BASE.projects[0], { slug: 'acme-shop', repos: ['Org/shop'], driver: 'daytona' }] }));
    assert.throws(() => loadProjects(cfg), refused(/: project "acme-shop" driver is "daytona", but the Daytona sandbox driver was removed and "ssh-docker" is the only driver — to move the project, change that setting to "ssh-docker" or drop it \(docs\/sandbox-drivers\.md → Moving a project to ssh-docker\), or keep running the last release that has the Daytona driver$/));
    assert.throws(() => loadProjects(cfg), (e: Error) => e.message.startsWith(`${cfg}: `), 'the file is named first, like every load error');
  });
});

test('driver — a typo or any other value is refused naming the accepted "ssh-docker" — it used to select Daytona silently (D3)', () => {
  withConfigDir((_dir, cfg) => {
    for (const driver of ['ssh-dokcer', 'kubernetes', '', null, 42]) {
      writeFileSync(cfg, JSON.stringify({ projects: [{ slug: 'acme-shop', repos: ['Org/shop'], driver }] }));
      assert.throws(() => loadProjects(cfg), refused(/project "acme-shop" driver must be "ssh-docker", the only sandbox driver; got /), JSON.stringify(driver));
    }
  });
});

test('driver — an absent field and "ssh-docker" load without a warning; so does a registry where every project names ssh-docker under an old Daytona default (D11 proof 2)', (t) => {
  withConfigDir((_dir, cfg) => {
    const warn = t.mock.method(log, 'warn', () => {});
    writeFileSync(cfg, JSON.stringify({ projects: [BASE.projects[0], { ...BASE.projects[1], driver: 'ssh-docker' }] }));
    assert.deepEqual(loadProjects(cfg).projects.map((p) => p.driver), [undefined, 'ssh-docker']);
    writeFileSync(cfg, JSON.stringify({ projects: BASE.projects.map((p) => ({ ...p, driver: 'ssh-docker' })) }));
    for (const old of ['DAYTONA_API_URL', 'SANDBOX_DRIVER'] as const) {
      assert.deepEqual(loadProjects(cfg, old).projects.map((p) => p.slug), ['alpha', 'beta'], `${old}: nothing would move`);
    }
    assert.equal(warn.mock.callCount(), 0);
  });
});

test('driver — under an old Daytona default, the projects without a field are refused, all named, with the setting and the fix (D4)', () => {
  withConfigDir((_dir, cfg) => {
    writeFileSync(cfg, JSON.stringify({ projects: [{ slug: 'acme-shop', repos: ['Org/shop'] }] }));
    assert.throws(() => loadProjects(cfg, 'DAYTONA_API_URL'), refused(/: project "acme-shop" has no "driver", and DAYTONA_API_URL without SANDBOX_DRIVER made Daytona this installation's default, but the Daytona sandbox driver was removed and "ssh-docker" is the only driver — to move it, give it "driver": "ssh-docker" or set SANDBOX_DRIVER=ssh-docker \(docs\/sandbox-drivers\.md → Moving a project to ssh-docker\), or keep running the last release that has the Daytona driver$/));
    assert.deepEqual(loadProjects(cfg).projects.map((p) => p.slug), ['acme-shop'], 'no old default: it loads, on ssh-docker');
    writeFileSync(cfg, JSON.stringify(BASE));
    assert.throws(() => loadProjects(cfg, 'SANDBOX_DRIVER'), refused(/: projects "alpha" and "beta" have no "driver", and SANDBOX_DRIVER=daytona made Daytona this installation's default, .* — to move them, give each "driver": "ssh-docker" or set SANDBOX_DRIVER=ssh-docker /));
    // A reload that adds a project without the field: refused, naming that one project.
    writeFileSync(cfg, JSON.stringify({ projects: [{ ...BASE.projects[0], driver: 'ssh-docker' }, { slug: 'newbie', repos: ['Org/newbie'] }] }));
    assert.throws(() => loadProjects(cfg, 'DAYTONA_API_URL'), refused(/: project "newbie" has no "driver", and DAYTONA_API_URL without SANDBOX_DRIVER/));
  });
});
