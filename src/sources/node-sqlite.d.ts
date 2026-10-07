// Minimal typings for Node's built-in `node:sqlite` (stable in Node 22.13+/24; not yet in the
// @types/node version this repo pins). Only the surface store.ts uses — extend as needed,
// keep in step with https://nodejs.org/api/sqlite.html.
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): StatementResultingChanges;
    iterate(...params: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
    setReadBigInts(enabled: boolean): void;
    readonly sourceSQL: string;
    readonly expandedSQL: string;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    open(): void;
    readonly isOpen: boolean;
  }
}
