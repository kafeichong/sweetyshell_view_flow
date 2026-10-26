import { spawnSync } from 'node:child_process';

describe('compressed request safety', () => {
  it('should survive trailing bytes after a complete compressed JSON body', () => {
    // A vulnerable parser must not terminate Jest. Only a loopback fixture is used.
    const script = [
      "const http = require('node:http');",
      "const zlib = require('node:zlib');",
      "const express = require('express');",
      'const app = express(); app.use(express.json()); let responseSeen = false;',
      'const payload = Buffer.concat([zlib.gzipSync(JSON.stringify({ok: true})), Buffer.from([0]), Buffer.alloc(100 * 1024, 88)]);',
      "app.post('/', (req, res) => res.json(req.body));",
      'const deadline = setTimeout(() => process.exit(2), 4000);',
      "const server = app.listen(0, '127.0.0.1', () => {",
      "const req = http.request({host: '127.0.0.1', port: server.address().port, method: 'POST',",
      "headers: {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': payload.length}}, res => {",
      "let body = ''; res.on('data', chunk => body += chunk);",
      "res.on('end', () => { if(res.statusCode !== 200 || JSON.parse(body).ok !== true) process.exit(3); responseSeen = true; }); });",
      "req.on('error', () => process.exit(4));",
      'req.end(payload);',
      'setTimeout(() => { if (!responseSeen) process.exit(5); server.closeAllConnections();',
      "server.close(() => { clearTimeout(deadline); process.stdout.write('survived'); }); }, 300); });",
    ].join('\n');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 6000,
    });
    expect({ status: result.status, error: result.stderr }).toEqual({
      status: 0,
      error: '',
    });
    expect(result.stdout).toBe('survived');
  });
});
