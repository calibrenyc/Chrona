const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlayingTracker } = require('./playing');

test('tracks launcher handoff, multiple games, and exit with a grace period', async () => {
  let time = 0;
  let processes = [];
  const updates = [];
  const tracker = new PlayingTracker(game => updates.push(game?.name || null), async () => processes, () => time);
  const settle = async () => { while (tracker.busy) await new Promise(resolve => setImmediate(resolve)); };
  try {
    processes = [{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: 'C:\\Games\\One\\start.exe' }];
    tracker.track({ id: 'one', name: 'One', installPath: 'C:\\Games\\One' }, 10);
    await settle();
    assert.equal(tracker.current.name, 'One');
    processes.push({ ProcessId: 11, ParentProcessId: 10, ExecutablePath: 'D:\\Runtime\\game.exe' });
    await tracker.poll();
    processes.shift();
    await tracker.poll();
    assert.equal(tracker.current.name, 'One');
    processes.push({ ProcessId: 20, ParentProcessId: 1, ExecutablePath: 'C:\\Games\\Two\\game.exe' });
    tracker.track({ id: 'two', name: 'Two', installPath: 'C:\\Games\\Two' });
    await settle();
    assert.equal(tracker.current.name, 'Two');
    processes.pop();
    await tracker.poll();
    time += 5001;
    await tracker.poll();
    assert.equal(tracker.current.name, 'One');
    processes = [];
    await tracker.poll();
    time += 5001;
    await tracker.poll();
    assert.equal(tracker.current, null);
    assert.deepEqual(updates, ['One', 'Two', 'One', null]);
    assert.equal(tracker.timer, null);
  } finally { tracker.stop(); }
});

test('URI launch waits for a matching game and expires without a false playing state', async () => {
  let time = 0;
  const tracker = new PlayingTracker(() => assert.fail('Unexpected playing state'), async () => [
    { ProcessId: 5, ParentProcessId: 1, ExecutablePath: 'C:\\Games\\OtherGame\\game.exe' }
  ], () => time);
  try {
    tracker.track({ id: 'game', name: 'Game', installPath: 'C:\\Games\\Other' });
    while (tracker.busy) await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracker.current, null);
    time = 120001;
    await tracker.poll();
    assert.equal(tracker.sessions.size, 0);
  } finally { tracker.stop(); }
});
