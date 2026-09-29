const path = require('path');
const { execFile } = require('child_process');

function readProcesses() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve([JSON.parse(stdout || '[]')].flat()); } catch (error) { reject(error); }
    });
  });
}

const normalize = value => value ? path.win32.resolve(value).toLowerCase() : '';

class PlayingTracker {
  constructor(onChange, snapshot = readProcesses, now = Date.now) {
    this.onChange = onChange;
    this.snapshot = snapshot;
    this.now = now;
    this.sessions = new Map();
    this.current = null;
  }

  track(game, pid) {
    this.sessions.delete(game.id);
    this.sessions.set(game.id, {
      game: { id: game.id, name: game.name },
      executable: normalize(game.executablePath),
      root: normalize(game.installPath || (game.executablePath && path.win32.dirname(game.executablePath))),
      pids: new Set(pid ? [pid] : []),
      deadline: this.now() + 120000,
      seen: false,
      missingSince: null
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), 2500);
      this.timer.unref();
    }
    this.poll();
  }

  async poll() {
    if (this.busy || !this.sessions.size) return;
    this.busy = true;
    try {
      const processes = await this.snapshot();
      for (const [id, session] of this.sessions) {
        const matching = new Set(session.pids);
        for (const process of processes) {
          const executable = normalize(process.ExecutablePath);
          if (executable && (executable === session.executable ||
              (session.root && executable.startsWith(session.root + '\\')))) {
            matching.add(process.ProcessId);
          }
        }
        // Follow batch/bootstrap launchers into their child processes.
        let changed;
        do {
          changed = false;
          for (const process of processes) {
            if (matching.has(process.ParentProcessId) && !matching.has(process.ProcessId)) {
              matching.add(process.ProcessId);
              changed = true;
            }
          }
        } while (changed);
        session.pids = new Set(processes.filter(process => matching.has(process.ProcessId)).map(process => process.ProcessId));
        if (session.pids.size) {
          session.seen = true;
          session.missingSince = null;
        } else {
          session.missingSince ??= this.now();
          if ((!session.seen && this.now() >= session.deadline) ||
              (session.seen && this.now() - session.missingSince >= 5000)) this.sessions.delete(id);
        }
      }
      const active = [...this.sessions.values()].filter(session => session.seen).at(-1)?.game || null;
      if (JSON.stringify(active) !== JSON.stringify(this.current)) {
        this.current = active;
        this.onChange(active);
      }
      if (!this.sessions.size) this.stop();
    } catch (error) {
      // A failed process query is not evidence that the game has closed.
      console.warn('Could not check running games:', error.message);
    } finally {
      this.busy = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { PlayingTracker, readProcesses };
