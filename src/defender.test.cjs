const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(response, failure = false, platform = 'win32') {
  const calls = [];
  const dialogs = [];
  const context = {
    Buffer, process: { platform, env: { SystemRoot: 'C:\\Windows' } },
    module: { exports: {} },
    require(name) {
      if (name === 'path') return path.win32;
      if (name === 'child_process') return { execFile(...args) {
        calls.push(args);
        args.at(-1)(failure ? new Error('Denied') : null);
      } };
      throw new Error(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'defender.js'), 'utf8'), context);
  const dialog = { async showMessageBox(_parent, options) {
    dialogs.push(options);
    return { response };
  } };
  return { calls, dialogs, run: (folders, enabled) => context.module.exports.offerDefenderExclusion(dialog, {}, folders, enabled), status: folders => context.module.exports.foldersAreExcluded(folders) };
}

test('declining leaves Defender untouched and defaults to keep scanning', async () => {
  const f = fixture(0);
  await f.run(['C:\\Games']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.dialogs[0].defaultId, 0);
  assert.equal(f.dialogs[0].cancelId, 0);
});

test('explicit consent elevates a hidden helper with literal paths and verification', async () => {
  const f = fixture(1);
  const folder = "C:\\Games\\O'Brien $(whoami) `test` & fun";
  await f.run([folder]);
  assert.equal(f.calls.length, 1);
  const [, args, options] = f.calls[0];
  assert.equal(options.windowsHide, true);
  const outer = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(outer, /-Verb RunAs -WindowStyle Hidden/);
  const inner = Buffer.from(outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.ok(inner.includes("'C:\\Games\\O''Brien $(whoami) `test` & fun'"));
  assert.match(inner, /Add-MpPreference -ExclusionPath \$folders/);
  assert.match(inner, /Get-MpPreference/);
  assert.equal(f.dialogs[1].type, 'info');
});

test('failed elevation reports unconfirmed exclusions without rejecting folder selection', async () => {
  const f = fixture(1, true);
  await f.run(['C:\\Games']);
  assert.equal(f.dialogs[1].type, 'warning');
  assert.match(f.dialogs[1].detail, /folder selection was saved/);
});

test('non-Windows and empty selections never prompt or execute', async () => {
  for (const [platform, folders] of [['linux', ['C:\\Games']], ['win32', []]]) {
    const f = fixture(1, false, platform);
    await f.run(folders);
    assert.equal(f.dialogs.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('switching off removes and verifies only the selected folder exclusions', async () => {
  const f = fixture(1);
  await f.run(['C:\\Downloads', 'D:\\Games'], false);
  const outer = Buffer.from(f.calls[0][1].at(-1), 'base64').toString('utf16le');
  const inner = Buffer.from(outer.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)[1], 'base64').toString('utf16le');
  assert.match(inner, /Remove-MpPreference -ExclusionPath \$folders/);
  assert.match(inner, /\$actual -contains \$folder/);
  assert.ok(inner.includes("'C:\\Downloads', 'D:\\Games'"));
});

test('status only turns on after a successful read and does not elevate', async () => {
  for (const failure of [false, true]) {
    const f = fixture(1, failure);
    assert.equal(await f.status(['C:\\Downloads', 'D:\\Games']), !failure);
    const script = Buffer.from(f.calls[0][1].at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-MpPreference/);
    assert.doesNotMatch(script, /RunAs|Add-MpPreference|Remove-MpPreference/);
    assert.equal(f.dialogs.length, 0);
  }
});
