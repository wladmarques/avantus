'use strict';
// Receptor temporário para inspecionar o payload do webhook da escala.
const http = require('node:http');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    console.log('=== WEBHOOK RECEBIDO ===');
    console.log(JSON.stringify(JSON.parse(body), null, 2));
    res.writeHead(204);
    res.end();
  });
});

server.listen(8099, '127.0.0.1', () => console.log('receptor em http://127.0.0.1:8099/hook'));
