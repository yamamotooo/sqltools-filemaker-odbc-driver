import { IBaseQueries, ContextValue } from '@sqltools/types';
import queryFactory from '@sqltools/base-driver/dist/lib/factory';

/**
 * FileMaker's ODBC/JDBC SQL layer does not expose an INFORMATION_SCHEMA or
 * sqlite_master-style catalog. Instead it exposes two special "virtual" tables
 * that can be queried with plain SQL:
 *
 *   FileMaker_Tables  -> TableName, TableId, BaseTableName, BaseFileName, ModCount
 *   FileMaker_Fields  -> TableName, FieldName, FieldType, FieldId, FieldClass, FieldReps, ModCount
 *
 * See: Claris FileMaker SQL Reference > FileMaker system tables.
 * We use these for the connection explorer tree, table/column search, and
 * "describe table" instead of writing raw SQL against normal catalog tables.
 */

const escapeStr = (value: any) => String(value).replace(/'/g, "''");

/**
 * FileMaker_Tables.TableName is the table *occurrence* name (used only for
 * display/browsing the relationships graph). Actual SQL statements (FROM
 * clauses, and FileMaker_Fields.TableName lookups) must reference the base
 * table name instead - see BaseTableName in FileMaker_Tables. We stash that
 * in a custom `table` property on the item (fetchTables/searchTables below)
 * and prefer it here over `label`, which only carries the TO name.
 */
const tableName = (table: any) => (table && typeof table === 'object' ? (table.table || table.label) : table);

const quoteIdent = (name: any) => `"${String(tableName(name)).replace(/"/g, '""')}"`;

const describeTable: IBaseQueries['describeTable'] = queryFactory`
SELECT FieldName AS label,
  FieldType AS dataType,
  FieldClass,
  FieldReps,
  FieldId
FROM FileMaker_Fields
WHERE TableName = '${p => escapeStr(tableName(p))}'
ORDER BY FieldId ASC
`;

const fetchColumns: IBaseQueries['fetchColumns'] = queryFactory`
SELECT FieldName AS label,
  FieldType AS dataType,
  FieldId,
  FieldClass,
  '${ContextValue.COLUMN}' AS type
FROM FileMaker_Fields
WHERE TableName = '${p => escapeStr(tableName(p))}'
ORDER BY FieldId ASC
`;

const fetchRecords: IBaseQueries['fetchRecords'] = queryFactory`
SELECT * FROM ${p => quoteIdent(p.table)}
OFFSET ${p => p.offset || 0} ROWS
FETCH FIRST ${p => p.limit || 50} ROWS ONLY
`;

const countRecords: IBaseQueries['countRecords'] = queryFactory`
SELECT COUNT(*) AS total FROM ${p => quoteIdent(p.table)}
`;

/**
 * FileMaker_Tables has one row per table *occurrence*, so the same base
 * table can appear many times (once per occurrence in the relationships
 * graph). We only want to show each physical table once, so we DISTINCT on
 * BaseTableName and use it for both the label and the query identifier.
 */
const fetchTables: IBaseQueries['fetchTables'] = queryFactory`
SELECT DISTINCT BaseTableName AS label,
  BaseTableName AS "table",
  '${ContextValue.TABLE}' AS type
FROM FileMaker_Tables
WHERE BaseTableName IS NOT NULL
ORDER BY BaseTableName ASC
`;

const searchTables: IBaseQueries['searchTables'] = queryFactory`
SELECT DISTINCT BaseTableName AS label,
  BaseTableName AS "table",
  '${ContextValue.TABLE}' AS type
FROM FileMaker_Tables
WHERE BaseTableName IS NOT NULL
${p => (p.search ? `AND BaseTableName LIKE '%${escapeStr(p.search)}%'` : '')}
ORDER BY BaseTableName ASC
`;

const searchColumns: IBaseQueries['searchColumns'] = queryFactory`
SELECT FieldName AS label,
  TableName AS "table",
  FieldType AS dataType,
  '${ContextValue.COLUMN}' AS type
FROM FileMaker_Fields
WHERE 1 = 1
${p =>
  p.tables && p.tables.filter(t => !!tableName(t)).length
    ? `AND TableName IN (${p.tables
        .filter(t => !!tableName(t))
        .map(t => `'${escapeStr(tableName(t))}'`)
        .join(', ')})`
    : ''
}
${p => (p.search ? `AND FieldName LIKE '%${escapeStr(p.search)}%'` : '')}
ORDER BY FieldName ASC
`;

export default {
  describeTable,
  countRecords,
  fetchColumns,
  fetchRecords,
  fetchTables,
  searchTables,
  searchColumns,
};
