// lock.mjs: a pid lock file shared by mac-node's serve (serve.pid) and drain (drain.pid).
import { readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';

export function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// The pid in a lock file: null when the file is missing, 0 when it holds no pid.
function holder(f) { try { return Number(readFileSync(f, 'utf8').trim()) || 0; } catch { return null; } }
const held = pid => pid > 0 && alive(pid);
function tryLink(from, to) { try { linkSync(from, to); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } }

// pidLock(file): true when this process now holds the lock. The lock appears whole, pid inside (a hard
// link of a finished file), or not at all. A lock whose pid is gone is taken over, one taker at a time
// (file.takeover): only the taker may remove a dead holder's lock, so two takers never both win.
export function pidLock(file) {
  const mine = `${file}.${process.pid}`, guard = `${file}.takeover`;
  writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (;;) {
      if (tryLink(mine, file)) return true;
      if (held(holder(file))) return false;
      if (!tryLink(mine, guard)) {
        const g = holder(guard);
        if (held(g)) return false;
        if (g !== null) try { unlinkSync(guard); } catch {}
        continue;
      }
      try {
        const pid = holder(file);
        if (held(pid)) return false;
        if (pid !== null) unlinkSync(file);
        return tryLink(mine, file);
      } finally { unlinkSync(guard); }
    }
  } finally { try { unlinkSync(mine); } catch {} }
}
