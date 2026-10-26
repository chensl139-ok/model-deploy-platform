import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

let muted = false;
const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
process.stdout.write('设置管理员密码（至少 12 个字符，输入不回显）：');
muted = true;
rl.once('line', value => {
  rl.close();
  process.stdout.write('\n');
  if (value.length < 12 || value.length > 256) { process.stderr.write('密码长度需要在 12–256 个字符之间。\n'); process.exitCode = 1; return; }
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(value, salt, 64).toString('hex');
  process.stdout.write(`复制以下整行到 .env（保留单引号）：\nADMIN_PASSWORD_HASH='scrypt$${salt}$${derived}'\n`);
});
rl.on('SIGINT', () => { rl.close(); process.exitCode = 130; process.stdout.write('\n'); });
