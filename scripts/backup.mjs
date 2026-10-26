import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const source = resolve(process.env.DATABASE_PATH ?? './data/launchpad.sqlite');
if (!existsSync(source)) throw new Error('数据库不存在，请先启动平台或设置 DATABASE_PATH');
const target = resolve(process.argv[2] ?? `./backups/launchpad-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
if (existsSync(target)) throw new Error('目标文件已存在，不覆盖已有备份');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true, fileMustExist: true });
try { await db.backup(target); chmodSync(target, 0o600); console.log(`备份完成：${target}`); }
finally { db.close(); }
