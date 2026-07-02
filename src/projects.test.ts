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
