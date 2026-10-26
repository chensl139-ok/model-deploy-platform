import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { Kubernetes } from '../server/kubernetes.js';
import { readConfig } from '../server/config.js';
import type { JsonObject } from '../shared/types.js';
const salt = '0123456789abcdef0123456789abcdef';
const env = { NODE_ENV: 'test', APP_MODE: 'live', DEPLOYMENT_PROVIDER: 'kubernetes', KUBE_CONTEXT: 'orbstack', KUBE_NAMESPACES: 'launchpad-test', ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync('test', salt, 64).toString('hex')}` };

test('native Kubernetes requires an explicit context/namespace and keeps Registry credentials optional', () => {
  assert.throws(() => readConfig({ ...env, KUBE_CONTEXT: '' }), /KUBE_CONTEXT/);
  assert.throws(() => readConfig({ ...env, KUBE_NAMESPACES: 'default,..' }), /KUBE_NAMESPACES/);
  assert.throws(() => readConfig({ ...env, APP_MODE: 'setup' }), /live/);
  assert.equal(readConfig(env).IO_MANAGEMENT_TOKEN, '');
});

test('native workload mutations reject foreign ownership and both stale UID and resource version', () => {
  const k = new Kubernetes(readConfig(env));
  assert.throws(() => k.authorize('kube-system'), /授权/);
  assert.throws(() => k.own({ metadata: { labels: { 'launchpad.platform/instance': 'other' } } }), /不属于/);
  k.own({ metadata: { labels: { 'launchpad.platform/instance': 'launchpad' } } });
  for (const headers of [undefined, { 'X-Expected-UID': 'different', 'X-Expected-Resource-Version': '5' }, { 'X-Expected-UID': 'uid', 'X-Expected-Resource-Version': '4' }]) assert.throws(() => k.cas({ metadata: { uid: 'uid', resourceVersion: '5' } }, headers), /变化/);
});

test('PVC replacement or deletion never silently binds an existing weight record to new data', async () => {
  const k = new Kubernetes(readConfig(env));
  let claim: JsonObject = { metadata: { uid: 'original' }, status: { phase: 'Bound' } };
  k.run = async () => claim;
  await k.claim('launchpad-test', 'weights', 'original');
  claim = { metadata: { uid: 'replaced' }, status: { phase: 'Bound' } }; await assert.rejects(k.claim('launchpad-test', 'weights', 'original'), /替换/);
  claim = { metadata: { uid: 'original', deletionTimestamp: new Date().toISOString() }, status: { phase: 'Bound' } }; await assert.rejects(k.claim('launchpad-test', 'weights', 'original'), /删除/);
  claim = { metadata: { uid: 'original' }, status: { phase: 'Pending' } }; await assert.rejects(k.claim('launchpad-test', 'weights', 'original'), /未绑定/);
});
