import { isIP } from 'node:net';
import { execFileSync } from 'node:child_process';

// Trusted short-lived helper only. No mounts, credentials, provider code or Docker socket.
const ports = process.argv.slice(2, 4), hostAddress = process.argv[4];
if (ports.length !== 2 || ports.some(p => !/^[1-9][0-9]{0,4}$/.test(p) || Number(p) > 65535)) throw new Error('NETWORK_POLICY_REFUSED');
if (process.argv.length !== 5 || isIP(hostAddress) !== 4) throw new Error('NETWORK_HOST_UNRESOLVED');
const addresses = [{ address: hostAddress }];
const run = (binary, args) => execFileSync(binary, ['-w', '5', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
for (const binary of ['/usr/sbin/iptables', '/usr/sbin/ip6tables']) {
  // Drop first. Never flush an existing OUTPUT chain while its policy permits traffic.
  for (const chain of ['INPUT', 'OUTPUT', 'FORWARD']) run(binary, ['-P', chain, 'DROP']);
  for (const chain of ['INPUT', 'OUTPUT', 'FORWARD']) run(binary, ['-F', chain]);
  run(binary, ['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT']);
  run(binary, ['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
  run(binary, ['-A', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
}
// No general established OUTPUT exception: pre-existing remote sockets cannot survive activation.
for (const { address } of addresses) for (const port of ports) {
  run('/usr/sbin/iptables', ['-A', 'OUTPUT', '-p', 'tcp', '-d', address, '--dport', port, '-j', 'ACCEPT']);
}
console.log(JSON.stringify({ version: 1, hostAddresses: addresses.map(a => a.address), ports: ports.map(Number), ipv4: 'default-drop', ipv6: 'default-drop' }));
