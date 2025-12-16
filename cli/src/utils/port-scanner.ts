import net from "net";

/**
 * Check if a port is in use
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once("close", () => resolve(false));
      server.close();
    });
    server.on("error", () => resolve(true));
  });
}

/**
 * Scan common development ports to find active servers
 */
export async function scanCommonPorts(): Promise<number[]> {
  const commonPorts = [
    3000, 3001, 3002, 3003,  // Common Node.js/React ports
    8000, 8001, 8080, 8081,  // Common web server ports
    5000, 5001, 5002,        // Common Flask/Python ports
    4000, 4001,              // Common API ports
    5173, 5174,              // Vite default ports
    4200,                    // Angular default
    9000,                    // Common dev ports
  ];

  const activePorts: number[] = [];
  
  for (const port of commonPorts) {
    if (await isPortInUse(port)) {
      activePorts.push(port);
    }
  }

  return activePorts;
}

/**
 * Test if a port is actually serving HTTP
 */
export async function testHttpPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        timeout: 1000,
      },
      () => {
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

