import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Activity, AuditActivity, ConfigPreview, JsonObject, Service, WeightVersion } from '../shared/types.js';

export interface StoredService extends Service {
  uid?: string;
  resourceVersion?: string;
  spec?: JsonObject;
  targetId?: string;
  deleted?: boolean;
  creationConfirmed?: boolean;
  missing?: boolean;
}
export interface Operation extends Activity {
  fingerprint: string;
  nonce?: string;
  baselineUid?: string;
  baselineVersion?: string;
  requestedSpec?: JsonObject;
}
export interface StoredPreview {
  id: string;
  expiresAt: string;
  actor: string;
  service: StoredService;
  glueProfile?: JsonObject;
  consumedBy?: string;
}
export interface StoredConfigPreview {
  id: string;
  actor: string;
  serviceId: string;
  revision: string;
  expiresAt: string;
  spec: JsonObject;
  changes: ConfigPreview['changes'];
  consumedBy?: string;
}
export interface StoredWeightVersion extends WeightVersion { requestId: string; fingerprint: string; importId?: string }
function activityOf(operation: Operation): Activity {
  const { fingerprint, nonce, baselineUid, baselineVersion, requestedSpec, ...activity } = operation;
  return activity;
}
export class Store {
  db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, cluster_id INTEGER NOT NULL,
        namespace TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS service_identity ON services(cluster_id, namespace, name) WHERE deleted = 0;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, service_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_operation ON operations(service_id) WHERE status IN ('pending', 'unknown');
      CREATE INDEX IF NOT EXISTS operation_history ON operations(service_id, created_at);
      CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS config_previews (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, csrf TEXT NOT NULL, actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS weight_versions (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_assets (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      PRAGMA user_version = 1;
    `);
  }
  list(): StoredService[] {
    return (this.db.prepare('SELECT data FROM services WHERE deleted=0 ORDER BY rowid DESC').all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  get(id: string): StoredService | undefined {
    const row = this.db.prepare('SELECT data FROM services WHERE id=? AND deleted=0').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  save(service: StoredService) {
    this.db.prepare(`INSERT INTO services(id,name,cluster_id,namespace,deleted,data) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,data=excluded.data`)
      .run(service.id, service.name, service.clusterId, service.namespace, Number(Boolean(service.deleted)), JSON.stringify(service));
  }
  operation(id: string): Operation | undefined {
    const row = this.db.prepare('SELECT data FROM operations WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveOperation(operation: Operation) {
    this.db.prepare(`INSERT INTO operations(id,service_id,status,created_at,data) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data`)
      .run(operation.id, operation.serviceId, operation.status, operation.createdAt, JSON.stringify(operation));
  }
  activities(id: string): Activity[] {
    return (this.db.prepare('SELECT data FROM operations WHERE service_id=? ORDER BY created_at DESC LIMIT 50').all(id) as { data: string }[])
      .map(row => activityOf(JSON.parse(row.data)));
  }
  audit(): AuditActivity[] {
    return (this.db.prepare(`SELECT o.data AS operation,s.data AS service,s.deleted FROM operations o
      JOIN services s ON s.id=o.service_id ORDER BY o.created_at DESC LIMIT 200`).all() as { operation: string; service: string; deleted: number }[])
      .map(row => { const service = JSON.parse(row.service) as StoredService; return { ...activityOf(JSON.parse(row.operation)), serviceName: service.name, modelName: service.modelName, deleted: Boolean(row.deleted) }; });
  }
  saveConfigPreview(preview: StoredConfigPreview) {
    this.db.prepare('INSERT OR REPLACE INTO config_previews(id,expires_at,data) VALUES (?,?,?)').run(preview.id, preview.expiresAt, JSON.stringify(preview));
  }
  configPreview(id: string): StoredConfigPreview | undefined {
    const row = this.db.prepare('SELECT data FROM config_previews WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  weights(): StoredWeightVersion[] {
    return (this.db.prepare("SELECT data FROM weight_versions WHERE NOT EXISTS (SELECT 1 FROM platform_assets a WHERE a.kind='archived:weight' AND a.id=weight_versions.id) ORDER BY rowid DESC").all() as { data: string }[]).map(row => JSON.parse(row.data));
  }
  weight(id: string): StoredWeightVersion | undefined {
    const row = this.db.prepare("SELECT data FROM weight_versions WHERE id=? AND NOT EXISTS (SELECT 1 FROM platform_assets a WHERE a.kind='archived:weight' AND a.id=weight_versions.id)").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  weightByRequest(requestId: string): StoredWeightVersion | undefined { const row = this.db.prepare('SELECT data FROM weight_versions WHERE request_id=?').get(requestId) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  saveWeight(weight: StoredWeightVersion) {
    this.db.prepare(`INSERT INTO weight_versions(id,request_id,data) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(weight.id, weight.requestId, JSON.stringify(weight));
  }
  pending(): Operation[] {
    return (this.db.prepare("SELECT data FROM operations WHERE status IN ('pending','unknown')").all() as { data: string }[]).map(r => JSON.parse(r.data));
  }
  savePreview(preview: StoredPreview) {
    this.db.prepare('INSERT OR REPLACE INTO previews(id,expires_at,data) VALUES (?,?,?)').run(preview.id, preview.expiresAt, JSON.stringify(preview));
  }
  preview(id: string): StoredPreview | undefined {
    const row = this.db.prepare('SELECT data FROM previews WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  assets<T>(kind: string, includeArchived = false): T[] {
    return (this.db.prepare("SELECT data FROM platform_assets p WHERE kind=? AND (? OR NOT EXISTS (SELECT 1 FROM platform_assets a WHERE a.kind='archived:' || p.kind AND a.id=p.id)) ORDER BY rowid DESC").all(kind, Number(includeArchived)) as { data: string }[]).map(row => JSON.parse(row.data));
  }
  asset<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM platform_assets WHERE kind=? AND id=?').get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveAsset(kind: string, id: string, value: unknown) {
    this.db.prepare('INSERT INTO platform_assets(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(value));
  }
  deleteAsset(kind: string, id: string) { this.db.prepare('DELETE FROM platform_assets WHERE kind=? AND id=?').run(kind, id); }
  session(id: string): { actor: string; csrf: string; expiresAt: number } | undefined {
    const row = this.db.prepare('SELECT actor,csrf,expires_at AS expiresAt FROM sessions WHERE id=? AND expires_at>?').get(id, Date.now());
    return row as { actor: string; csrf: string; expiresAt: number } | undefined;
  }
  saveSession(id: string, csrf: string, actor: string, expires: number) {
    this.db.prepare('INSERT INTO sessions(id,csrf,actor,expires_at) VALUES (?,?,?,?)').run(id, csrf, actor, expires);
  }
  deleteSession(id: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    this.db.prepare('DELETE FROM previews WHERE expires_at<?').run(new Date(Date.now() - 86400000).toISOString());
    this.db.prepare('DELETE FROM config_previews WHERE expires_at<?').run(new Date(Date.now() - 86400000).toISOString());
  }
  close() { this.db.close(); }
}

export function publicService(service: StoredService): Service {
  const { uid, resourceVersion, spec, targetId, deleted, creationConfirmed, missing, ...result } = service;
  return { ...result, revision: createHash('sha256').update(`${service.id}:${uid}:${resourceVersion}:${service.updatedAt}`).digest('hex') };
}
