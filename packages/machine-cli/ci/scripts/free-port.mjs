// Prints a TCP port on which nothing listens: the ports of the daemon (local API and peer listener) in verify-install and verify-update.
import { createServer } from 'node:net';

const server = createServer();
server.once('error', (error) => {
  process.stderr.write(`free-port: cannot find a free port (${error.message})\n`);
  process.exit(1);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  server.close(() => process.stdout.write(`${port}\n`));
});
