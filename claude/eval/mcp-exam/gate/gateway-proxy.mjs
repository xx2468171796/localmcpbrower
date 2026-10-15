/**
 * Trusted helper the bastion's exam script runs OUTSIDE the gate sandbox: listens on a unix socket and forwards every
 * connection to the company AI gateway (TCP 192.168.110.246:8899 by default, nothing else). The gate sandbox then runs
 * with --unshare-net (needed: the exam site and Chromium use loopback ports, which the build account's egress firewall
 * rejects on the host network) and the driver reaches the model only through this socket (--model-socket <path>).
 * Holds no secrets: the key travels inside the request headers from the driver. Judge layer.
 *
 *   node claude/eval/mcp-exam/gate/gateway-proxy.mjs <socket path> [host:port]      (stops when stdin closes)
 */
import fs from 'node:fs';
import net from 'node:net';

const [, , socketPath, target = '192.168.110.246:8899'] = process.argv;
if (!socketPath) { console.error('usage: gateway-proxy.mjs <socket path> [host:port]'); process.exit(2); }
const [host, port] = target.split(':');
try { fs.unlinkSync(socketPath); } catch { /* not there */ }
const server = net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  client.pipe(upstream).pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end);
  upstream.on('error', end);
});
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); console.log(`proxy ${socketPath} → ${target}`); });
process.stdin.resume();
process.stdin.on('end', () => { server.close(); try { fs.unlinkSync(socketPath); } catch { /* gone */ } process.exit(0); });
