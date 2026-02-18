declare module "node:sqlite" {
  export type RunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export interface StatementSync {
    run(...parameters: unknown[]): RunResult;
    get<T = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...parameters: unknown[]): T[];
  }

  export type DatabaseSyncOptions = {
    open?: boolean;
    readOnly?: boolean;
    timeout?: number;
    enableForeignKeyConstraints?: boolean;
  };

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

