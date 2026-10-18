import { spawn } from 'child_process';
const t0 = Date.now();
const child = spawn('node', ['/home/dev/.nvm/versions/node/v24.22.0/lib/node_modules/rea-agents/scripts/rea.mjs', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/tmp/oae-work' });
let buf = '';
child.stdout.on('data', d => {
  buf += d;
  if (buf.includes('"serverInfo"')) {
    console.log('INIT_OK_MS', Date.now() - t0);
    const t1 = Date.now();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdout.on('data', d2 => {
      buf += d2;
      if ((buf.match(/"name"/g) || []).length > 200) {
        console.log('TOOLS_LIST_MS', Date.now() - t1, 'TOOLS', (buf.match(/"name":/g) || []).length);
        child.kill();
        process.exit(0);
      }
    });
  }
});
child.stderr.on('data', d => process.stderr.write(d));
child.on('error', e => { console.log('ERR', e.message); process.exit(1); });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
setTimeout(() => { console.log('TIMEOUT_MS', Date.now() - t0, buf.slice(0, 300)); child.kill(); process.exit(1); }, 60000);
