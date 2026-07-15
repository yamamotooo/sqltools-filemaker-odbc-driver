#!/usr/bin/env node
/**
 * Build a win32-x64 .vsix on macOS.
 *
 * The vsix bundles node_modules, so the odbc.node inside it must match the
 * target OS. This script temporarily swaps in IBM's official prebuilt
 * win32-x64 binary (from the node-odbc GitHub release matching the installed
 * odbc version), runs `vsce package --target win32-x64`, then restores the
 * local iODBC-linked macOS binary.
 *
 * Note: the official Windows binary does NOT contain the SQLDescribeColW
 * wide-column-name patch applied on macOS (see rebuild-odbc-iodbc.js). On
 * Windows, use the DSN options (WideAPI=Yes etc., see README) if Japanese
 * identifiers get garbled.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const odbcVersion = require(path.join(root, 'node_modules', 'odbc', 'package.json')).version;
const nodeBinary = path.join(root, 'node_modules', 'odbc', 'lib', 'bindings', 'napi-v8', 'odbc.node');

const cacheDir = path.join(root, '.cache');
const tarball = path.join(cacheDir, `odbc-v${odbcVersion}-win32-x64-napi-v8.tar.gz`);
const url = `https://github.com/IBM/node-odbc/releases/download/v${odbcVersion}/odbc-v${odbcVersion}-win32-x64-napi-v8.tar.gz`;
const backup = path.join(cacheDir, 'odbc.node.darwin');

fs.mkdirSync(cacheDir, { recursive: true });
if (!fs.existsSync(tarball)) {
  console.log(`[package-win32] downloading ${url}`);
  execSync(`curl -fsSL -o "${tarball}" "${url}"`, { stdio: 'inherit' });
}

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odbc-win32-'));
execSync(`tar -xzf "${tarball}" -C "${extractDir}"`);
const winBinary = path.join(extractDir, 'napi-v8', 'odbc.node');
if (!fs.existsSync(winBinary)) {
  console.error('[package-win32] ERROR: tarball did not contain napi-v8/odbc.node.');
  process.exit(1);
}
// PE files start with "MZ"; make sure we are about to bundle a Windows DLL.
const magic = fs.readFileSync(winBinary).subarray(0, 2).toString('latin1');
if (magic !== 'MZ') {
  console.error('[package-win32] ERROR: downloaded odbc.node is not a Windows PE binary.');
  process.exit(1);
}

fs.copyFileSync(nodeBinary, backup);
try {
  fs.copyFileSync(winBinary, nodeBinary);
  execSync('npx vsce package --allow-missing-repository --target win32-x64 -o .', {
    cwd: root,
    stdio: 'inherit',
  });
} finally {
  fs.copyFileSync(backup, nodeBinary);
  fs.unlinkSync(backup);
}
console.log('[package-win32] done: win32-x64 vsix created, macOS odbc.node restored.');
