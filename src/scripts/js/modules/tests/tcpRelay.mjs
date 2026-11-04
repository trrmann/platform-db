/**
 * TCP relay for start-up tests: listens on a local port and forwards every connection to a
 * target (the local scratch database). Starting it late simulates a database that comes up
 * after the service; stopping it simulates the database going away.
 */

import net from 'node:net';

export class TcpRelay {
  /**
   * @param {{targetHost: string, targetPort: number}} target
   */
  constructor({ targetHost, targetPort }) {
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.server = null;
    this.sockets = new Set();
  }

  /**
   * A port that is free right now (nothing listens on it).
   */
  static async freePort() {
    const probe = net.createServer();
    await new Promise((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve) => {
      probe.close(resolve);
    });
    return port;
  }

  /**
   * Start forwarding connections made to 127.0.0.1:`port`.
   */
  async start(port) {
    this.server = net.createServer((client) => this.forward(client));
    await new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', resolve);
    });
  }

  /**
   * Pipe one client connection to the target, both ways.
   */
  forward(client) {
    const upstream = net.connect(this.targetPort, this.targetHost);
    this.sockets.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    for (const socket of [client, upstream]) {
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        this.sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
  }

  /**
   * Stop listening and cut every open connection.
   */
  async stop() {
    if (!this.server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => {
      this.server.close(resolve);
    });
    this.server = null;
  }
}

export default TcpRelay;
