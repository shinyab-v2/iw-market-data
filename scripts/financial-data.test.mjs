import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

console.log('Testing fundamental schema and manifests...');

const schemaPath = path.join(root, 'schemas', 'fundamental-v1.schema.json');
assert.ok(fs.existsSync(schemaPath), 'fundamental-v1.schema.json must exist');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
assert.equal(schema.schema_version?.enum?.[0] || schema.properties?.schema_version?.enum?.[0], 'fundamental-v1');

const manifestPath = path.join(root, 'fundamentals', 'manifest.json');
assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schema_version, 'fundamental-manifest.v1');
assert.ok(typeof manifest.tickers === 'object', 'manifest.tickers must be an object');

const guidanceManifestPath = path.join(root, 'guidance', 'manifest.json');
assert.ok(fs.existsSync(guidanceManifestPath), 'guidance/manifest.json must exist');
const guidanceManifest = JSON.parse(fs.readFileSync(guidanceManifestPath, 'utf8'));
assert.equal(guidanceManifest.schema_version, 'guidance-manifest.v1');

const sourceIndexPath = path.join(root, 'sources', 'public-source-index.json');
assert.ok(fs.existsSync(sourceIndexPath), 'sources/public-source-index.json must exist');
const sourceIndex = JSON.parse(fs.readFileSync(sourceIndexPath, 'utf8'));
assert.equal(sourceIndex.schema_version, 'public-source-index.v1');
assert.ok(sourceIndex.sources.SEC_EDGAR, 'SEC_EDGAR source must be defined');

console.log('PASS: Fundamental schemas, manifests, and source index verified');
