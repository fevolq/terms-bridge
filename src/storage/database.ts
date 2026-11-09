import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { ApiError, conversationKey } from '../domain/request.js';
import { parseConfig } from '../projects/config.js';
import { recordSchema } from './tasks.js';
import { conversationSchema } from './conversations.js';
import { uploadedFileSchema } from '../domain/file.js';
import type { PluginConfig, Table, TaskRecord, ConversationRecord, WorkspaceBinding, UploadedFile, TaskMetadata } from '../domain/types.js';

export const bindingSchema = z.object({ workspace_path: z.string().min(1), configured_path: z.string().min(1).optional() }).strict();
export const storedFileSchema = z.object({ file: uploadedFileSchema, workspace_path: z.string().min(1) }).strict();
export type StoredFile = z.infer<typeof storedFileSchema>;
const bindingsSchema = z.record(z.string(), bindingSchema);
type SqlName = 'tasks' | 'session_mappings' | 'files';

/** Reads come from SQLite; failed writes never publish an in-memory replacement. */
class SqlTable<T> implements Table<T> {
  constructor(protected owner: BridgeDatabase, private name: SqlName, private schema: z.ZodType<T>) {}
  get(key: string): T | undefined {
    const row = this.owner.sql.prepare('SELECT value FROM ' + this.name + ' WHERE key = ?').get(key);
    return row ? this.schema.parse(JSON.parse(row.value as string)) : undefined;
  }
  *entries(): IterableIterator<[string, T]> {
    for (const row of this.owner.sql.prepare('SELECT key, value FROM ' + this.name + ' ORDER BY rowid').all())
      yield [row.key as string, this.schema.parse(JSON.parse(row.value as string))];
  }
  putSync(key: string, value: T): void {
    const parsed = this.schema.parse(value);
    this.owner.sql.prepare('INSERT INTO ' + this.name + '(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(parsed));
  }
  async put(key: string, value: T): Promise<void> { this.putSync(key, value); }
  async update(key: string, change: (value: T) => T): Promise<T> {
    return this.owner.transaction(() => {
      const current = this.get(key);
      if (current === undefined) throw new Error('Missing ' + this.name + ' record');
      const value = change(current); this.putSync(key, value); return value;
    });
  }
}

const pendingTask = "(json_extract(value, '$.status') IN ('queued','running','retrying') OR (json_extract(value, '$.status') = 'completed' AND json_extract(value, '$.delivery.status') IN ('pending','retrying')))";
const projectId = "json_extract(value, '$.request.metadata.project_id')";
const conversationId = "json_extract(value, '$.request.metadata.conversation_id')";
// The partial index supplies both IDs, so deleted mappings are checked before task bodies are loaded.
const liveTask = "NOT EXISTS (SELECT 1 FROM session_mappings AS mapping WHERE json_extract(mapping.value, '$.project_id') = " +
  projectId.replace('value', 'tasks.value') + " AND json_extract(mapping.value, '$.conversation_id') = " +
  conversationId.replace('value', 'tasks.value') + " AND json_extract(mapping.value, '$.deleted') = 1)";

class SqlTaskTable extends SqlTable<TaskRecord> {
  constructor(owner: BridgeDatabase) { super(owner, 'tasks', recordSchema); }
  *pending(): IterableIterator<[string, TaskRecord]> {
    // Force the partial index: ORDER BY rowid must not make SQLite scan terminal history.
    const rows = this.owner.sql.prepare('SELECT key,value FROM tasks INDEXED BY tasks_pending WHERE ' + pendingTask + ' AND ' + liveTask + ' ORDER BY rowid').all();
    for (const row of rows) yield [row.key as string, recordSchema.parse(JSON.parse(row.value as string))];
  }
  busy(metadata: TaskMetadata): boolean {
    return !!this.owner.sql.prepare('SELECT 1 FROM tasks INDEXED BY tasks_pending WHERE ' + pendingTask + ' AND ' + projectId + '=? AND ' + conversationId + "=? AND json_extract(value, '$.status') IN ('queued','running','retrying') LIMIT 1")
      .get(metadata.project_id, metadata.conversation_id);
  }
}

export class BridgeDatabase {
  readonly sql: DatabaseSync;
  readonly tasks: SqlTaskTable;
  readonly mappings: SqlTable<ConversationRecord>;
  readonly files: SqlTable<StoredFile>;
  readonly bindings: Table<Record<string, WorkspaceBinding>>;
  private inTransaction = false;
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error('Database path must be absolute');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.sql = new DatabaseSync(path);
    try {
      this.sql.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = this.sql.prepare('PRAGMA user_version').get()!.user_version as number;
      if (version > 1) throw new Error('terms-bridge database was created by a newer version');
      if (version === 0) this.transaction(() => {
        this.sql.exec(
          'CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), api_prefix TEXT NOT NULL, revision INTEGER NOT NULL);' +
          'CREATE TABLE projects (key TEXT PRIMARY KEY, config TEXT NOT NULL, binding TEXT);' +
          'CREATE TABLE session_mappings (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
          "CREATE UNIQUE INDEX mapping_session ON session_mappings(json_extract(value, '$.session_id'));" +
          'CREATE TABLE tasks (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
          'CREATE TABLE files (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
          'PRAGMA user_version=1;');
      });
      this.sql.exec("CREATE INDEX IF NOT EXISTS mapping_deleted ON session_mappings(json_extract(value, '$.project_id'),json_extract(value, '$.conversation_id')) WHERE json_extract(value, '$.deleted') = 1");
      this.sql.exec('CREATE INDEX IF NOT EXISTS tasks_pending ON tasks(' + projectId + ',' + conversationId + ') WHERE ' + pendingTask);
      this.transaction(() => {
        if (!this.sql.prepare('SELECT 1 FROM settings WHERE id=1').get()) this.writeSettings(parseConfig({}), 1);
      });
      this.tasks = new SqlTaskTable(this);
      this.mappings = new SqlTable(this, 'session_mappings', conversationSchema);
      this.files = new SqlTable(this, 'files', storedFileSchema);
      this.bindings = {
        get: key => key === 'current' ? this.readBindings() : undefined,
        entries: () => new Map([['current', this.readBindings()]]).entries(),
        put: async (key, value) => { if (key !== 'current') throw new Error('Invalid binding key'); this.transaction(() => this.writeBindings(value)); },
        update: async (key, change) => {
          if (key !== 'current') throw new Error('Invalid binding key');
          return this.transaction(() => { const next = change(this.readBindings()); this.writeBindings(next); return next; });
        },
      };
    } catch (error) { this.sql.close(); throw error; }
  }
  transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.sql.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try {
      const result = operation();
      if (result instanceof Promise) throw new Error('Database transactions must not await external operations');
      this.sql.exec('COMMIT'); return result;
    } catch (error) {
      // Some SQLite failures already roll back the transaction; preserve the original cause.
      try { this.sql.exec('ROLLBACK'); } catch {}
      throw error;
    }
    finally { this.inTransaction = false; }
  }
  readSettings(): { config: PluginConfig; revision: number } {
    const row = this.sql.prepare('SELECT api_prefix,revision FROM settings WHERE id=1').get();
    if (!row) throw new Error('terms-bridge configuration has not been initialized');
    const projects = Object.fromEntries(this.sql.prepare('SELECT key,config FROM projects').all().map(item => [item.key, JSON.parse(item.config as string)]));
    return { config: parseConfig({ api_prefix: row.api_prefix, projects }), revision: row.revision as number };
  }
  writeSettings(config: PluginConfig, revision: number): void {
    const parsed = parseConfig(config);
    this.sql.prepare('INSERT INTO settings(id,api_prefix,revision) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET api_prefix=excluded.api_prefix,revision=excluded.revision').run(parsed.api_prefix, revision);
    for (const row of this.sql.prepare('SELECT key FROM projects').all()) if (!Object.hasOwn(parsed.projects, row.key as string)) this.sql.prepare('DELETE FROM projects WHERE key=?').run(row.key!);
    for (const [id, project] of Object.entries(parsed.projects)) this.sql.prepare('INSERT INTO projects(key,config) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET config=excluded.config').run(id, JSON.stringify(project));
  }
  private readBindings(): Record<string, WorkspaceBinding> {
    return Object.fromEntries(this.sql.prepare('SELECT key,binding FROM projects WHERE binding IS NOT NULL').all().map(row => [row.key, bindingSchema.parse(JSON.parse(row.binding as string))]));
  }
  writeBindings(value: Record<string, WorkspaceBinding>): void {
    const parsed = bindingsSchema.parse(value);
    this.sql.prepare('UPDATE projects SET binding=NULL').run();
    for (const [id, binding] of Object.entries(parsed)) {
      const result = this.sql.prepare('UPDATE projects SET binding=? WHERE key=?').run(JSON.stringify(binding), id);
      if (!result.changes) throw new Error('Workspace binding has no configured project');
    }
  }
  admitTask(key: string, task: TaskRecord, mapping: ConversationRecord): void {
    this.transaction(() => {
      if (this.tasks.get(key)) throw new ApiError(409, 'CHAT_ALREADY_EXISTS', 'chat_id already exists in this conversation', task.request.metadata);
      const mappingKey = conversationKey(mapping.project_id, mapping.conversation_id);
      if (!this.mappings.get(mappingKey)) this.mappings.putSync(mappingKey, mapping);
      this.tasks.putSync(key, task);
    });
  }
  saveFile(file: UploadedFile, workspace_path: string): Promise<void> { return this.files.put(file.file_id, { file, workspace_path }); }
  close(): void { this.sql.close(); }
}
