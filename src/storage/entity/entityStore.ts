import {
  migrateSchema,
} from "../sqlite/schema.js";
import {
  openDatabase,
  withImmediateTransaction,
  type DatabaseSyncLike,
} from "../sqlite/sqliteBridge.js";

/** SQLite scalar values accepted by the standalone entity store. */
export type EntityValue = string | number | boolean | null;

/** Supported column mappings for a standalone entity table. */
export const ENTITY_COLUMN_KINDS = {
  TEXT: "text",
  INTEGER: "integer",
  REAL: "real",
  BOOLEAN: "boolean",
} as const;

export type EntityColumnKind = (typeof ENTITY_COLUMN_KINDS)[keyof typeof ENTITY_COLUMN_KINDS];

/** Column metadata used to generate and validate one SQLite table. */
export interface EntityColumnDefinition {
  readonly kind: EntityColumnKind;
  readonly nullable?: boolean;
}

type StringKeyOf<Row extends object> = Extract<keyof Row, string>;

/** Declarative definition for one application-owned SQLite table. */
export interface EntityDefinition<Row extends object> {
  readonly tableName: string;
  readonly primaryKey: StringKeyOf<Row>;
  readonly columns: Readonly<{
    [K in StringKeyOf<Row>]: EntityColumnDefinition;
  }>;
}

/** Basic CRUD surface intentionally kept smaller than a general-purpose ORM. */
export interface EntityStore<Row extends object> {
  readonly definition: EntityDefinition<Row>;
  /** Inserts a new row or replaces the non-key fields of an existing row. */
  save(entity: Row): Row;
  findById(id: EntityValue): Row | null;
  findAll(): Row[];
  /** Removes a row by entity or primary-key value and reports whether it existed. */
  remove(entityOrId: Row | EntityValue): boolean;
}

/** Entity store that owns the database connection opened by the helper. */
export interface StandaloneEntityStore<Row extends object> extends EntityStore<Row> {
  readonly database: DatabaseSyncLike;
  close(): void;
}

export interface OpenStandaloneEntityStoreOptions<Row extends object> {
  readonly databasePath: string;
  readonly definition: EntityDefinition<Row>;
  /** Initializes the internal sync schema before creating the domain table. */
  readonly initializeSyncSchema?: boolean;
}

/** Error raised when a definition cannot be represented safely in SQLite. */
export class EntityDefinitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EntityDefinitionError";
  }
}

/** Error raised when an existing table does not match its definition. */
export class EntitySchemaMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EntitySchemaMismatchError";
  }
}

/** Error raised when a row value does not match its declared column kind. */
export class EntityValueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EntityValueError";
  }
}

/** Creates one store and creates or verifies its application-owned table. */
export function createEntityStore<Row extends object>(
  database: DatabaseSyncLike,
  definition: EntityDefinition<Row>,
): EntityStore<Row> {
  const normalized = validateDefinition(definition);
  ensureEntityTable(database, normalized);

  const columns = Object.entries(normalized.columns) as [StringKeyOf<Row>, EntityColumnDefinition][];
  const primaryKey = normalized.primaryKey;
  const tableName = quoteIdentifier(normalized.tableName);
  const columnNames = columns.map(([name]) => quoteIdentifier(name));
  const selectColumns = columnNames.join(", ");
  const savePlaceholders = columns.map(() => "?").join(", ");
  const updateColumns = columns.filter(([name]) => name !== primaryKey);
  const updateSql = updateColumns.length === 0
    ? "DO NOTHING"
    : `DO UPDATE SET ${updateColumns
        .map(([name]) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`)
        .join(", ")}`;
  const saveStatement = database.prepare(`
    INSERT INTO ${tableName} (${selectColumns})
    VALUES (${savePlaceholders})
    ON CONFLICT (${quoteIdentifier(primaryKey)}) ${updateSql}
  `);
  const findStatement = database.prepare(
    `SELECT ${selectColumns} FROM ${tableName} WHERE ${quoteIdentifier(primaryKey)} = ?`,
  );
  const listStatement = database.prepare(
    `SELECT ${selectColumns} FROM ${tableName} ORDER BY ${quoteIdentifier(primaryKey)}`,
  );
  const removeStatement = database.prepare(
    `DELETE FROM ${tableName} WHERE ${quoteIdentifier(primaryKey)} = ?`,
  );

  return {
    definition: normalized,
    save(entity: Row): Row {
      const values = columns.map(([name, column]) => toSqlValue(name, column, readEntityValue(entity, name)));
      withImmediateTransaction(database, () => {
        saveStatement.run(...values);
      });
      return entity;
    },
    findById(id: EntityValue): Row | null {
      const column = normalized.columns[primaryKey];
      const result = findStatement.get(toSqlValue(primaryKey, column, id));
      return result === undefined ? null : fromSqlRow(result, columns);
    },
    findAll(): Row[] {
      return listStatement.all().map((row) => fromSqlRow(row, columns));
    },
    remove(entityOrId: Row | EntityValue): boolean {
      const id = isEntityObject(entityOrId)
        ? readEntityValue(entityOrId, primaryKey)
        : entityOrId;
      const column = normalized.columns[primaryKey];
      const result = withImmediateTransaction(database, () =>
        removeStatement.run(toSqlValue(primaryKey, column, id)),
      );
      return result.changes === 1;
    },
  };
}

/** Opens a standalone database, initializes sync tables, and creates one domain table. */
export async function openStandaloneEntityStore<Row extends object>(
  options: OpenStandaloneEntityStoreOptions<Row>,
): Promise<StandaloneEntityStore<Row>> {
  const database = await openDatabase(options.databasePath);
  try {
    if (options.initializeSyncSchema ?? true) {
      migrateSchema(database);
    }
    const store = createEntityStore(database, options.definition);
    return {
      ...store,
      database,
      close(): void {
        database.close();
      },
    };
  } catch (error: unknown) {
    database.close();
    throw error;
  }
}

/** Creates or verifies several application-owned tables in one writer transaction. */
export function ensureEntityTables<Row extends object>(
  database: DatabaseSyncLike,
  definitions: readonly EntityDefinition<Row>[],
): void;
export function ensureEntityTables(
  database: DatabaseSyncLike,
  definitions: readonly EntityDefinition<any>[],
): void {
  const normalizedDefinitions = definitions.map((definition) => validateDefinition(definition));
  withImmediateTransaction(database, () => {
    for (const definition of normalizedDefinitions) {
      ensureEntityTable(database, definition);
    }
  });
}

function ensureEntityTable<Row extends object>(
  database: DatabaseSyncLike,
  definition: EntityDefinition<Row>,
): void {
  const tableName = quoteIdentifier(definition.tableName);
  const existing = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(definition.tableName);
  if (existing === undefined) {
    const columns = (Object.entries(definition.columns) as [StringKeyOf<Row>, EntityColumnDefinition][])
      .map(([name, column]) => columnDefinitionSql(name, column, name === definition.primaryKey))
      .join(",\n");
    database.exec(`CREATE TABLE ${tableName} (\n${columns}\n)`);
    return;
  }

  const actualRows = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const expectedColumns = Object.entries(definition.columns) as [StringKeyOf<Row>, EntityColumnDefinition][];
  if (actualRows.length !== expectedColumns.length) {
    throw new EntitySchemaMismatchError(
      `table ${definition.tableName} columns do not match the entity definition`,
    );
  }

  expectedColumns.forEach(([name, column], index) => {
    const actual = requireRecord(actualRows[index], `table ${definition.tableName} column ${String(index)}`);
    const actualName = requireText(actual.name, "SQLite column name");
    const actualType = requireText(actual.type, `SQLite column ${actualName} type`).toUpperCase();
    const actualNotNull = actual.notnull === 1;
    const actualPrimaryKey = actual.pk === 1;
    const expectedPrimaryKey = name === definition.primaryKey;
    const expectedNotNull = expectedPrimaryKey || !(column.nullable ?? false);
    if (
      actualName !== name ||
      actualType !== sqliteType(column.kind) ||
      actualNotNull !== expectedNotNull ||
      actualPrimaryKey !== expectedPrimaryKey
    ) {
      throw new EntitySchemaMismatchError(
        `table ${definition.tableName} column ${name} does not match the entity definition`,
      );
    }
  });
}

function validateDefinition<Row extends object>(definition: EntityDefinition<Row>): EntityDefinition<Row> {
  if (!isSafeIdentifier(definition.tableName) || definition.tableName.startsWith("sqlite_")) {
    throw new EntityDefinitionError(`invalid entity table name: ${definition.tableName}`);
  }
  if (!isSafeIdentifier(definition.primaryKey)) {
    throw new EntityDefinitionError(`invalid entity primary key: ${definition.primaryKey}`);
  }
  const columns = Object.entries(definition.columns) as [StringKeyOf<Row>, EntityColumnDefinition][];
  if (columns.length === 0) {
    throw new EntityDefinitionError(`entity ${definition.tableName} must declare at least one column`);
  }
  const primaryKeyColumn = definition.columns[definition.primaryKey];
  if (primaryKeyColumn === undefined) {
    throw new EntityDefinitionError(
      `entity ${definition.tableName} primary key ${definition.primaryKey} is not declared`,
    );
  }
  if (primaryKeyColumn.nullable === true) {
    throw new EntityDefinitionError(`entity ${definition.tableName} primary key cannot be nullable`);
  }
  for (const [name, column] of columns) {
    if (!isSafeIdentifier(name)) throw new EntityDefinitionError(`invalid entity column name: ${name}`);
    if (!isEntityColumnKind(column.kind)) {
      throw new EntityDefinitionError(`invalid entity column kind for ${definition.tableName}.${name}`);
    }
  }
  return definition;
}

function columnDefinitionSql(
  name: string,
  column: EntityColumnDefinition,
  primaryKey: boolean,
): string {
  const constraints = [
    primaryKey ? "PRIMARY KEY" : "",
    primaryKey || !(column.nullable ?? false) ? "NOT NULL" : "",
    column.kind === ENTITY_COLUMN_KINDS.BOOLEAN
      ? `CHECK (${quoteIdentifier(name)} IN (0, 1))`
      : "",
  ].filter((value) => value.length > 0).join(" ");
  return `${quoteIdentifier(name)} ${sqliteType(column.kind)}${constraints.length > 0 ? ` ${constraints}` : ""}`;
}

function sqliteType(kind: EntityColumnKind): "TEXT" | "INTEGER" | "REAL" {
  switch (kind) {
    case ENTITY_COLUMN_KINDS.TEXT:
      return "TEXT";
    case ENTITY_COLUMN_KINDS.INTEGER:
    case ENTITY_COLUMN_KINDS.BOOLEAN:
      return "INTEGER";
    case ENTITY_COLUMN_KINDS.REAL:
      return "REAL";
  }
}

function toSqlValue(name: string, column: EntityColumnDefinition, value: unknown): string | number | null {
  if (value === null) {
    if (!(column.nullable ?? false)) throw new EntityValueError(`entity field ${name} cannot be null`);
    return null;
  }
  switch (column.kind) {
    case ENTITY_COLUMN_KINDS.TEXT:
      if (typeof value !== "string") throw new EntityValueError(`entity field ${name} must be text`);
      return value;
    case ENTITY_COLUMN_KINDS.INTEGER:
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new EntityValueError(`entity field ${name} must be a safe integer`);
      }
      return value;
    case ENTITY_COLUMN_KINDS.REAL:
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EntityValueError(`entity field ${name} must be a finite number`);
      }
      return value;
    case ENTITY_COLUMN_KINDS.BOOLEAN:
      if (typeof value !== "boolean") throw new EntityValueError(`entity field ${name} must be boolean`);
      return value ? 1 : 0;
  }
}

function fromSqlRow<Row extends object>(
  value: unknown,
  columns: readonly [StringKeyOf<Row>, EntityColumnDefinition][],
): Row {
  const record = requireRecord(value, "SQLite entity row");
  const result: Record<string, EntityValue> = {};
  for (const [name, column] of columns) {
    const raw = record[name];
    if (raw === undefined) throw new EntitySchemaMismatchError(`SQLite row is missing column ${name}`);
    result[name] = fromSqlValue(name, column, raw);
  }
  return result as Row;
}

function fromSqlValue(name: string, column: EntityColumnDefinition, value: unknown): EntityValue {
  if (value === null) return null;
  switch (column.kind) {
    case ENTITY_COLUMN_KINDS.TEXT:
      if (typeof value !== "string") throw new EntitySchemaMismatchError(`SQLite field ${name} is not text`);
      return value;
    case ENTITY_COLUMN_KINDS.INTEGER:
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new EntitySchemaMismatchError(`SQLite field ${name} is not an integer`);
      }
      return value;
    case ENTITY_COLUMN_KINDS.REAL:
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EntitySchemaMismatchError(`SQLite field ${name} is not a finite number`);
      }
      return value;
    case ENTITY_COLUMN_KINDS.BOOLEAN:
      if (value !== 0 && value !== 1) throw new EntitySchemaMismatchError(`SQLite field ${name} is not boolean`);
      return value === 1;
  }
}

function readEntityValue<Row extends object>(entity: Row, name: StringKeyOf<Row>): unknown {
  const value = (entity as Record<string, unknown>)[name];
  if (value === undefined) throw new EntityValueError(`entity field ${name} is required`);
  return value;
}

function isEntityObject(value: object | EntityValue): value is object {
  return typeof value === "object" && value !== null;
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new EntityDefinitionError(`invalid SQLite identifier: ${value}`);
  return `"${value}"`;
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function isEntityColumnKind(value: unknown): value is EntityColumnKind {
  return value === ENTITY_COLUMN_KINDS.TEXT ||
    value === ENTITY_COLUMN_KINDS.INTEGER ||
    value === ENTITY_COLUMN_KINDS.REAL ||
    value === ENTITY_COLUMN_KINDS.BOOLEAN;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EntitySchemaMismatchError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new EntitySchemaMismatchError(`${label} must be text`);
  return value;
}
