import { createServer } from "node:net";

/** A port nothing listens on at the moment it is answered. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}
