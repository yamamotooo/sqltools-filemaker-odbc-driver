#!/usr/bin/env node
/**
 * macOS: rebuild the `odbc` native module against iODBC instead of unixODBC.
 *
 * Why: the FileMaker ODBC client driver (fmodbc.so) is only reliable under
 * iODBC. Under unixODBC, any failing SQL statement makes the driver abort()
 * inside SQLExecDirect, killing the whole process (= the SQLTools language
 * server). iODBC also reads /Library/ODBC/odbc.ini (ODBC Manager's files)
 * natively, so no ODBCSYSINI/ODBCINI environment variables are needed.
 *
 * Requires: `brew install libiodbc`
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('[rebuild-odbc-iodbc] not macOS, skipping.');
  process.exit(0);
}

const odbcDir = path.join(__dirname, '..', 'node_modules', 'odbc');
const bindingGyp = path.join(odbcDir, 'binding.gyp');
const nodeBinary = path.join(odbcDir, 'lib', 'bindings', 'napi-v8', 'odbc.node');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

const connectionCpp = path.join(odbcDir, 'src', 'odbc_connection.cpp');
const PATCH_MARKER = 'fm-iodbc-widecol-patch';

// 0. Already linked against iODBC AND source-patched? Then nothing to do.
if (fs.existsSync(nodeBinary)) {
  const links = sh(`otool -L "${nodeBinary}"`);
  const srcPatched = fs.readFileSync(connectionCpp, 'utf8').includes(PATCH_MARKER);
  if (links.includes('libiodbc') && srcPatched) {
    console.log('[rebuild-odbc-iodbc] odbc.node already linked against iODBC (with widecol patch), skipping.');
    process.exit(0);
  }
}

// 1. Locate Homebrew libiodbc.
let iodbcPrefix;
try {
  iodbcPrefix = sh('brew --prefix libiodbc').trim();
  if (!fs.existsSync(path.join(iodbcPrefix, 'lib', 'libiodbc.dylib'))) throw new Error();
} catch {
  console.error(
    '[rebuild-odbc-iodbc] ERROR: Homebrew libiodbc not found.\n' +
    '  Install it first:  brew install libiodbc\n' +
    '  (The FileMaker ODBC driver crashes on SQL errors under unixODBC;\n' +
    '   this project must link the odbc module against iODBC.)'
  );
  process.exit(1);
}

// 2. Patch binding.gyp: point both mac arches at libiodbc and add the
//    ODBC 3.8 constant missing from iODBC's older headers.
let gyp = fs.readFileSync(bindingGyp, 'utf8');
const before = gyp;
gyp = gyp
  .replace(/'\/opt\/homebrew\/include'/g, `'${iodbcPrefix}/include'`)
  .replace(/'-L\/opt\/homebrew\/lib',(\s*)'-lodbc'/g, `'-L${iodbcPrefix}/lib',$1'-liodbc'`)
  // mac x64 section (do not touch the freebsd section, which has no '-L/usr/local/lib' pairing on mac builds)
  .replace(/'-L\/usr\/local\/lib',(\s*)'-lodbc'/g, `'-L${iodbcPrefix}/lib',$1'-liodbc'`)
  .replace(/'\/usr\/local\/include',/g, `'${iodbcPrefix}/include',`);
if (!gyp.includes('SQL_GD_OUTPUT_PARAMS')) {
  gyp = gyp.replace(
    /'defines': \[ 'NAPI_DISABLE_CPP_EXCEPTIONS' \]\n(\s*)\}\],\n(\s*)\[ 'OS == "freebsd"'/,
    `'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS', 'SQL_GD_OUTPUT_PARAMS=0x00000010L' ]\n$1}],\n$2[ 'OS == "freebsd"'`
  );
}
if (!gyp.includes('-liodbc') || !gyp.includes('SQL_GD_OUTPUT_PARAMS')) {
  console.error('[rebuild-odbc-iodbc] ERROR: binding.gyp did not match the expected layout (odbc package updated?). Aborting without changes.');
  process.exit(1);
}
if (gyp !== before) fs.writeFileSync(bindingGyp, gyp);

// 2b. Patch odbc_connection.cpp: fetch column names via SQLDescribeColW.
//     The FileMaker driver's ANSI SQLDescribeCol returns corrupted UTF-8 for
//     non-ASCII column names (a NUL lands mid-sequence, truncating the name,
//     e.g. 顧客氏名 -> 顧�). Its wide entry point returns correct characters,
//     so we take those (iODBC SQLWCHAR = 4-byte UCS-4) and encode UTF-8
//     ourselves. Data values are unaffected (fetched via SQL_C_CHAR).
let cpp = fs.readFileSync(connectionCpp, 'utf8');
if (!cpp.includes(PATCH_MARKER)) {
  const allocOld = '    column->ColumnName = new SQLTCHAR[data->maxColumnNameLength + 1]();';
  const allocNew = '    column->ColumnName = new SQLTCHAR[(data->maxColumnNameLength * 4) + 1](); // fm-iodbc-widecol-patch: room for UTF-8';
  const describeOld =
`    return_code = 
    SQLDescribeCol
    (
      data->hstmt,                   // StatementHandle
      i + 1,                         // ColumnNumber
      column->ColumnName,            // ColumnName
      data->maxColumnNameLength + 1, // BufferLength
      &column->NameLength,           // NameLengthPtr
      &column->DataType,             // DataTypePtr
      &column->ColumnSize,           // ColumnSizePtr
      &column->DecimalDigits,        // DecimalDigitsPtr
      &column->Nullable              // NullablePtr
    );`;
  const describeNew =
`    // fm-iodbc-widecol-patch: use the wide API for the column name, then
    // encode UCS-4 -> UTF-8 into ColumnName (see scripts/rebuild-odbc-iodbc.js).
    SQLWCHAR fmWideName[256];
    SQLSMALLINT fmWideChars = 0;
    return_code =
    SQLDescribeColW
    (
      data->hstmt,                   // StatementHandle
      i + 1,                         // ColumnNumber
      fmWideName,                    // ColumnName
      256,                           // BufferLength (chars)
      &fmWideChars,                  // NameLengthPtr
      &column->DataType,             // DataTypePtr
      &column->ColumnSize,           // ColumnSizePtr
      &column->DecimalDigits,        // DecimalDigitsPtr
      &column->Nullable              // NullablePtr
    );
    if (SQL_SUCCEEDED(return_code)) {
      SQLCHAR *fmOut = column->ColumnName;
      size_t fmCap = (size_t)data->maxColumnNameLength * 4;
      size_t fmO = 0;
      if (fmWideChars > 255) fmWideChars = 255;
      for (SQLSMALLINT fmI = 0; fmI < fmWideChars && fmWideName[fmI]; fmI++) {
        unsigned int cp = (unsigned int)fmWideName[fmI];
        if (cp < 0x80) {
          if (fmO + 1 > fmCap) break;
          fmOut[fmO++] = (SQLCHAR)cp;
        } else if (cp < 0x800) {
          if (fmO + 2 > fmCap) break;
          fmOut[fmO++] = (SQLCHAR)(0xC0 | (cp >> 6));
          fmOut[fmO++] = (SQLCHAR)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
          if (fmO + 3 > fmCap) break;
          fmOut[fmO++] = (SQLCHAR)(0xE0 | (cp >> 12));
          fmOut[fmO++] = (SQLCHAR)(0x80 | ((cp >> 6) & 0x3F));
          fmOut[fmO++] = (SQLCHAR)(0x80 | (cp & 0x3F));
        } else {
          if (fmO + 4 > fmCap) break;
          fmOut[fmO++] = (SQLCHAR)(0xF0 | (cp >> 18));
          fmOut[fmO++] = (SQLCHAR)(0x80 | ((cp >> 12) & 0x3F));
          fmOut[fmO++] = (SQLCHAR)(0x80 | ((cp >> 6) & 0x3F));
          fmOut[fmO++] = (SQLCHAR)(0x80 | (cp & 0x3F));
        }
      }
      fmOut[fmO] = 0;
      column->NameLength = (SQLSMALLINT)fmO;
    }`;
  if (!cpp.includes(allocOld) || !cpp.includes(describeOld)) {
    console.error('[rebuild-odbc-iodbc] ERROR: odbc_connection.cpp did not match the expected layout (odbc package updated?). Aborting without changes.');
    process.exit(1);
  }
  cpp = cpp
    .replace('#include "odbc_connection.h"', '#include "odbc_connection.h"\n#include <sqlucode.h> // fm-iodbc-widecol-patch')
    .replace(allocOld, allocNew)
    .replace(describeOld, describeNew);
  fs.writeFileSync(connectionCpp, cpp);
  console.log('[rebuild-odbc-iodbc] patched odbc_connection.cpp (wide column names).');
}

// 3. Rebuild from source.
console.log('[rebuild-odbc-iodbc] rebuilding odbc against iODBC...');
sh('npx node-pre-gyp rebuild --build-from-source', { cwd: odbcDir, stdio: 'inherit' });

// 4. Verify.
const links = sh(`otool -L "${nodeBinary}"`);
if (!links.includes('libiodbc')) {
  console.error('[rebuild-odbc-iodbc] ERROR: rebuild finished but odbc.node is not linked against libiodbc.');
  process.exit(1);
}
console.log('[rebuild-odbc-iodbc] OK: odbc.node is linked against iODBC.');
