import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'launchpad-container-'));
const name = `launchpad-check-${Date.now()}`; const salt = randomBytes(16).toString('hex'); const password = randomBytes(24).toString('hex');
const origin = 'https://models.example.test'; const envPath = join(dir, 'env');
writeFileSync(envPath, `NODE_ENV=production\nAPP_MODE=setup\nPUBLIC_ORIGIN=${origin}\nADMIN_PASSWORD_HASH=scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}\n`, { mode: 0o600 });
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', envPath, '-v', '/app/data', '-p', '127.0.0.1::3100', 'launchpad-platform:1.5.0'], { stdio: 'pipe' });
  const mapping = execFileSync('docker', ['port', name, '3100'], { encoding: 'utf8' }).trim(); const base = `http://${mapping}`;
  const deadline = Date.now() + 30000; let healthy = false;
  while (Date.now() < deadline) { try { healthy = (await fetch(`${base}/api/health`)).ok; } catch {} if (healthy) break; await new Promise(r => setTimeout(r, 500)); }
  assert.ok(healthy, 'container health endpoint unavailable');
  const unauthorized = await fetch(`${base}/api/services`); assert.equal(unauthorized.status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie'); assert.ok(cookie.includes('Secure')); assert.ok(cookie.includes('HttpOnly'));
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json(); assert.equal(boot.authenticated, true); assert.equal(boot.mode, 'setup');
  const crossed = await fetch(`${base}/api/models`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken }, body: '{}' }); assert.equal(crossed.status, 403);
  const html = await fetch(base); assert.ok((await html.text()).includes('Launchpad')); assert.ok(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const user = execFileSync('docker', ['exec', name, 'id', '-u'], { encoding: 'utf8' }).trim(); assert.notEqual(user, '0');
  execFileSync('docker', ['exec', name, 'kubectl', 'version', '--client', '-o', 'json'], { stdio: 'pipe' }); execFileSync('docker', ['exec', name, 'skopeo', '--version'], { stdio: 'pipe' });
  console.log('PASS: production image starts non-root/read-only; static UI, health, login, Secure cookies, CSRF/origin, CSP, kubectl and skopeo verified.');
} finally {
  try { execFileSync('docker', ['stop', '-t', '10', name], { stdio: 'ignore' }); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
