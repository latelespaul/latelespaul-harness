// A stand-in for `ssh <host> bridge` in the mac-node tests: it never dials anything. It records its argv
// in $FAKE_SSH_LOG and runs the key's forced command itself, the way sshd would: `mac-node bridge` with
// the VM's environment ($FAKE_SSH_ENV, JSON), whatever command the client asked for. Its own stdin and
// stdout are piped to the bridge, so the bridge reads end of file when this process dies (killed or
// not), as it does when sshd closes the session. While the file $FAKE_SSH_DOWN exists it fails at once,
// like ssh to an unreachable VM.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\n');
if (process.env.FAKE_SSH_DOWN && existsSync(process.env.FAKE_SSH_DOWN)) {
  process.stderr.write('ssh: connect to host vm port 22: Connection refused\n');
  process.exit(255);
}
const bridge = spawn(process.execPath, [process.env.FAKE_SSH_CLI, 'bridge'],
  { env: JSON.parse(process.env.FAKE_SSH_ENV || '{}'), stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(bridge.stdin);
bridge.stdout.pipe(process.stdout);
bridge.stdin.on('error', () => {});
process.stdout.on('error', () => {});
process.stdin.on('end', () => bridge.stdin.end());
bridge.on('close', code => process.exit(code ?? 255));
process.on('SIGTERM', () => { bridge.stdin.end(); setTimeout(() => process.exit(0), 50); });
