import AbstractDriver from '@sqltools/base-driver';
import queries from './queries';
import { IConnectionDriver, MConnectionExplorer, NSDatabase, ContextValue, Arg0 } from '@sqltools/types';
import { v4 as generateId } from 'uuid';
import * as odbc from 'odbc';

type DriverLib = odbc.Connection;
type DriverOptions = any;

/**
 * Custom, non-standard connection fields configured in connection.schema.json.
 * The standard fields (username, password, database, connectionTimeout) already
 * exist on IConnection, so they don't need to be redeclared here.
 */
interface FileMakerExtraCredentials {
  connectionMethod?: 'DSN' | 'Connection String';
  dsn?: string;
  connectionString?: string;
  additionalParameters?: string;
}

export default class FileMakerODBC extends AbstractDriver<DriverLib, DriverOptions> implements IConnectionDriver {

  queries = queries;

  /** Typed accessor for the custom fields defined in connection.schema.json */
  private get extra(): FileMakerExtraCredentials {
    return this.credentials as any;
  }

  private buildConnectionString(): string {
    const { connectionMethod, dsn, connectionString, additionalParameters } = this.extra;
    const { database, username, password } = this.credentials;

    if (connectionMethod === 'Connection String' && connectionString && connectionString.trim()) {
      return connectionString.trim();
    }

    if (!dsn) {
      throw new Error('FileMaker ODBC: a DSN name is required (or switch to "Connection String" mode).');
    }

    const parts: string[] = [`DSN=${dsn}`];
    if (database) parts.push(`Database=${database}`);
    if (username) parts.push(`UID=${username}`);
    if (password) parts.push(`PWD=${password}`);
    if (additionalParameters) parts.push(additionalParameters);
    return parts.join(';');
  }

  public async open() {
    if (this.connection) {
      return this.connection;
    }

    const timeoutSec = this.credentials.connectionTimeout || 15;
    this.connection = odbc.connect({
      connectionString: this.buildConnectionString(),
      connectionTimeout: timeoutSec,
      loginTimeout: timeoutSec,
    }).catch((error: any) => {
      // Don't cache the rejected promise, so the user can fix the settings
      // and retry without reloading the language server.
      this.connection = null;
      // node-odbc's error.message is a generic "[odbc] Error connecting to the
      // database"; the actual diagnostics (host unreachable, 802, bad DSN, ...)
      // live in odbcErrors.
      const detail = (error && error.odbcErrors && error.odbcErrors.length)
        ? error.odbcErrors.map((e: any) => `[${e.state || '?'}] ${e.message}`).filter(Boolean).join(' | ')
        : null;
      throw new Error(detail || (error && error.message) || String(error));
    });
    return this.connection;
  }

  public async close() {
    if (!this.connection) return;
    const conn = await this.connection;
    await conn.close();
    this.connection = null;
  }

  /**
   * FileMaker's ODBC/JDBC SQL layer executes one statement at a time.
   * We split on semicolons defensively so pasted multi-statement scripts
   * still run one-by-one instead of failing outright.
   */
  private splitStatements(raw: string): string[] {
    return raw
      .split(/;\s*(?:\r?\n|$)/g)
      .map(s => s.trim())
      .filter(Boolean);
  }

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt = {}) => {
    const conn = await this.open();
    const { requestId } = opt;
    const statements = this.splitStatements(query.toString());

    const resultsAgg: NSDatabase.IResult[] = [];
    for (const statement of statements) {
      try {
        const rows: any = await conn.query(statement);
        const cols = rows.columns
          ? rows.columns.map((c: any) => c.name)
          : (rows[0] ? Object.keys(rows[0]) : []);
        resultsAgg.push(<NSDatabase.IResult>{
          cols,
          connId: this.getId(),
          messages: [this.prepareMessage(`Query ok, ${rows.length} row(s) returned`)],
          results: rows,
          query: statement,
          requestId,
          resultId: generateId(),
        });
      } catch (error) {
        if (opt.throwIfError) {
          throw error;
        }
        // node-odbc's error.message is a generic "[odbc] Error executing the
        // sql statement"; the actual FileMaker diagnostics live in odbcErrors.
        const detail = (error && error.odbcErrors && error.odbcErrors.length)
          ? error.odbcErrors.map((e: any) => e.message).filter(Boolean).join(' | ')
          : null;
        resultsAgg.push(<NSDatabase.IResult>{
          connId: this.getId(),
          cols: [],
          error: true,
          rawError: error,
          messages: [this.prepareMessage(detail || (error && error.message) || String(error))],
          query: statement,
          requestId,
          resultId: generateId(),
          results: [],
        });
      }
    }
    return resultsAgg;
  }

  public async testConnection() {
    await this.open();
    // FileMaker SQL requires a FROM clause; FileMaker_Tables always exists once
    // ODBC/JDBC sharing is enabled, so this works even against an empty file.
    await this.query('SELECT TableName FROM FileMaker_Tables FETCH FIRST 1 ROWS ONLY', { throwIfError: true });
  }

  public async getChildrenForItem({ item, parent }: Arg0<IConnectionDriver['getChildrenForItem']>) {
    switch (item.type) {
      case ContextValue.CONNECTION:
      case ContextValue.CONNECTED_CONNECTION:
        return <MConnectionExplorer.IChildItem[]>[
          { label: 'Tables', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.TABLE },
        ];
      case ContextValue.TABLE:
        return <MConnectionExplorer.IChildItem[]>[
          { label: 'Columns', type: ContextValue.RESOURCE_GROUP, iconId: 'folder', childType: ContextValue.COLUMN },
        ];
      case ContextValue.RESOURCE_GROUP:
        return this.getChildrenForGroup({ item, parent });
    }
    return [];
  }

  private async getChildrenForGroup({ parent, item }: Arg0<IConnectionDriver['getChildrenForItem']>) {
    switch (item.childType) {
      case ContextValue.TABLE:
        return this.queryResults(this.queries.fetchTables(parent as NSDatabase.ISchema));
      case ContextValue.COLUMN:
        return this.getColumns(parent as NSDatabase.ITable);
    }
    return [];
  }

  private async getColumns(parent: NSDatabase.ITable): Promise<NSDatabase.IColumn[]> {
    const results = await this.queryResults(this.queries.fetchColumns(parent));
    return results.map(col => ({
      ...col,
      childType: ContextValue.NO_CHILD,
      iconName: 'column',
      table: parent,
    }));
  }

  public searchItems(itemType: ContextValue, search: string, extraParams: any = {}): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
        return this.queryResults(this.queries.searchTables({ search }));
      case ContextValue.COLUMN:
        return this.queryResults(this.queries.searchColumns({ search, ...extraParams }));
    }
    return Promise.resolve([]);
  }

  public getStaticCompletions: IConnectionDriver['getStaticCompletions'] = async () => {
    return {};
  }
}
