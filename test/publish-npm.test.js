import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRIPT = path.join(process.cwd(), 'scripts', 'publish-npm.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

// 假 npm：只实现本脚本用到的子命令，行为由 FAKE_* 环境变量控制。
const FAKE_NPM = `#!/usr/bin/env bash
set -u
cmd="\${1:-}"; shift || true
printf '%s %s\\n' "$cmd" "$*" >> "\${FAKE_LOG:?}"
mode="\${FAKE_STATE:?}/public"
case "$cmd" in
  --version) echo "11.99.0"; exit 0 ;;
  view)
    if [ -f "$mode" ]; then echo "0.6.5"; exit 0; fi
    echo "npm error code E404" >&2
    exit 1 ;;
  whoami) echo "fake-user"; exit 0 ;;
  stage) echo "(fake) staged packages: none"; exit 0 ;;
  publish)
    if [ "\${FAKE_CONFLICT:-}" = "1" ]; then
      echo "npm error code E403" >&2
      echo "npm error 403 You cannot publish over the previously published versions: 0.6.5." >&2
      exit 1
    fi
    case " $* " in
      *" --provenance "*)
        if [ "\${FAKE_PROVENANCE_RC:-0}" != "0" ]; then
          echo "npm error code EUSAGE provenance signing requires OIDC" >&2
          exit "\${FAKE_PROVENANCE_RC}"
        fi ;;
    esac
    if grep -q "_authToken" "\${NPM_CONFIG_USERCONFIG:-/nonexistent}" 2>/dev/null; then
      echo "fake npm: published with NODE_AUTH_TOKEN"
      rc="\${FAKE_TOKEN_PUBLISH_RC:-0}"
      [ "$rc" = "0" ] && [ -n "\${FAKE_TOKEN_MAKES_PUBLIC:-}" ] && : > "$mode"
    else
      echo "fake npm: published via trusted publishing"
      rc="\${FAKE_TRUSTED_PUBLISH_RC:-0}"
      [ "$rc" = "0" ] && [ -n "\${FAKE_TRUSTED_MAKES_PUBLIC:-}" ] && : > "$mode"
    fi
    exit "$rc" ;;
  *) exit 0 ;;
esac
`;

function runPublish(env = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-npm-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  if (options.prePublic) fs.writeFileSync(path.join(state, 'public'), '');
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });

  const output = path.join(dir, 'github-output');
  fs.writeFileSync(output, '');
  const log = path.join(dir, 'npm-calls.log');
  fs.writeFileSync(log, '');

  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PACKAGE_NAME: '@xiaopb/dsh-mobile-compose',
      VERSION: '0.6.5',
      GITHUB_OUTPUT: output,
      WORKDIR: path.join(dir, 'work'),
      FAKE_STATE: state,
      FAKE_LOG: log,
      PROBE_REGISTRY: '0',
      POLL_ATTEMPTS: '2',
      POLL_INTERVAL: '0',
      ACTIONS_ID_TOKEN_REQUEST_URL: '',
      NODE_AUTH_TOKEN: '',
      ...env,
    },
  });

  const outputs = fs
    .readFileSync(output, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((acc, line) => {
      const i = line.indexOf('=');
      acc[line.slice(0, i)] = line.slice(i + 1);
      return acc;
    }, {});
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout + res.stderr, outputs, calls };
}

test('publish-npm: 版本已公开时直接跳过，不发第二次', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({}, { prePublic: true });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.outputs.method, 'already published');
  assert.equal(res.calls.filter((c) => c.startsWith('publish ')).length, 0);
});

test('publish-npm: 没有任何发布凭据 → 不发 publish，直接给出诊断', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({});
  assert.equal(res.status, 1, '没有凭据时应当失败');
  assert.equal(res.calls.filter((c) => c.startsWith('publish ')).length, 0);
  assert.match(res.stdout, /Version not public/);
  assert.match(res.stdout, /Staged Packages/);
});

test('publish-npm: OIDC 发布且立刻公开 → trusted publishing', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    FAKE_TRUSTED_MAKES_PUBLIC: '1',
  });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.outputs.method, 'trusted publishing (OIDC)');
  assert.equal(res.calls.filter((c) => c.startsWith('publish ')).length, 1);
  assert.match(res.calls.find((c) => c.startsWith('publish ')), /--provenance/);
});

test('publish-npm: 可信发布「成功」但版本没公开 → 回退 token 并确认公开', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    NODE_AUTH_TOKEN: 'npm_faketoken',
    FAKE_TRUSTED_PUBLISH_RC: '0', // 退出码 0，但没有 ->public
    FAKE_TOKEN_MAKES_PUBLIC: '1',
  });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.outputs.method, 'NPM_TOKEN');
  const publishes = res.calls.filter((c) => c.startsWith('publish '));
  assert.equal(publishes.length, 2, `应当先 OIDC 再 token：${publishes.join(' | ')}`);
});

test('publish-npm: provenance 失败时自动去掉 --provenance 重试', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    FAKE_PROVENANCE_RC: '1',
    FAKE_TRUSTED_MAKES_PUBLIC: '1',
  });
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.outputs.method, 'trusted publishing (OIDC)');
  const publishes = res.calls.filter((c) => c.startsWith('publish '));
  assert.equal(publishes.length, 2, publishes.join(' | '));
  assert.match(publishes[0], /--provenance/);
  assert.doesNotMatch(publishes[1], /--provenance/);
});

test('publish-npm: registry 回「已存在该版本」→ 不再换方式重发，只等刷新', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    NODE_AUTH_TOKEN: 'npm_faketoken',
    FAKE_CONFLICT: '1',
  });
  assert.equal(res.status, 1, res.stdout);
  const publishes = res.calls.filter((c) => c.startsWith('publish '));
  assert.equal(publishes.length, 1, `冲突后不该再用 token 重发：${publishes.join(' | ')}`);
  assert.match(res.stdout, /已存在该版本/);
});

test('publish-npm: 两条路都没公开 → 失败并给出 staged 处置建议', { skip: !hasBash && 'bash 不可用' }, () => {
  const res = runPublish({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    NODE_AUTH_TOKEN: 'npm_faketoken',
    FAKE_TOKEN_PUBLISH_RC: '0',
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Version not public/);
  assert.match(res.stdout, /Staged Packages/);
  assert.match(res.stdout, /Trusted Publisher/);
});
