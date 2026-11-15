// A stand-in for `ssh -N -R <remote socket>:<local socket> <host>` in the mac-node tests: it never
// dials anything. It records its argv in $FAKE_SSH_LOG, then listens on the remote path itself and
// pipes each connection to the local socket, the way sshd and ssh together would. While the file
// $FAKE_SSH_DOWN exists it fails at once, like ssh to an unreachable VM. SIGTERM closes the socket;
// SIGKILL leaves it behind, stale, like an sshd whose Mac went away.
import { createServer, createConnection } from 'node:net';
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\n');
if (process.env.FAKE_SSH_DOWN && existsSync(process.env.FAKE_SSH_DOWN)) {
  process.stderr.write('ssh: connect to host vm port 22: Connection refused\n');
  process.exit(255);
}
const fwd = argv[argv.indexOf('-R') + 1] || '';
const i = fwd.indexOf(':');
const [remote, local] = [fwd.slice(0, i), fwd.slice(i + 1)];
if (!remote || !local) { process.stderr.write('fake ssh: no -R remote:local\n'); process.exit(255); }
const server = createServer(c => {
  const m = createConnection(local);
  c.pipe(m); m.pipe(c);
  const done = () => { c.destroy(); m.destroy(); };
  c.on('error', done); m.on('error', done); c.on('close', done); m.on('close', done);
});
server.on('error', e => { process.stderr.write(`Error: remote port forwarding failed for listen path ${remote}: ${e.code}\n`); process.exit(255); });
server.listen(remote);
process.on('SIGTERM', () => { server.close(); try { unlinkSync(remote); } catch {} process.exit(0); });
