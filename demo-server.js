#!/usr/bin/env node
/**
 * Simple demo server for testing the tunnel
 * Usage: node demo-server.js [port]
 */

const http = require('http');
const port = process.argv[2] || 3000;

let requestCount = 0;

const server = http.createServer((req, res) => {
  requestCount++;
  const timestamp = new Date().toISOString();
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Uplink Tunnel Demo</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      min-height: 100vh;
    }
    .container {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
    }
    h1 {
      margin-top: 0;
      font-size: 2.5em;
    }
    .info {
      background: rgba(255, 255, 255, 0.2);
      padding: 20px;
      border-radius: 10px;
      margin: 20px 0;
    }
    .status {
      display: inline-block;
      background: #4ade80;
      padding: 5px 15px;
      border-radius: 20px;
      font-weight: bold;
      margin: 10px 0;
    }
    code {
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 8px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Uplink Tunnel Demo</h1>
    <div class="status">✅ Tunnel is working!</div>
    
    <div class="info">
      <h2>Request Info</h2>
      <p><strong>Method:</strong> ${req.method}</p>
      <p><strong>URL:</strong> <code>${req.url}</code></p>
      <p><strong>Headers:</strong></p>
      <pre style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 5px; overflow-x: auto;">${JSON.stringify(req.headers, null, 2)}</pre>
    </div>
    
    <div class="info">
      <h2>Server Info</h2>
      <p><strong>Port:</strong> ${port}</p>
      <p><strong>Timestamp:</strong> ${timestamp}</p>
      <p><strong>Request Count:</strong> ${requestCount}</p>
    </div>
    
    <div class="info">
      <h2>Try it!</h2>
      <p>Refresh this page or visit different paths like:</p>
      <ul>
        <li><code>${req.headers.host}/hello</code></li>
        <li><code>${req.headers.host}/test</code></li>
        <li><code>${req.headers.host}/api/data</code></li>
      </ul>
    </div>
  </div>
</body>
</html>
  `;
  
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(port, () => {
  console.log(`🎉 Demo server running on http://localhost:${port}`);
  console.log(`📡 Ready to tunnel! Create a tunnel with:`);
  console.log(`   uplink dev --tunnel --port ${port}`);
  console.log(`   or`);
  console.log(`   node scripts/tunnel/client-improved.js --token <TOKEN> --port ${port} --ctrl 178.156.149.124:7071`);
  console.log(`\nPress Ctrl+C to stop`);
});
