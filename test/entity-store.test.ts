import { describe, expect, it } from "vitest";
import {
  createEntityStore,
  ENTITY_COLUMN_KINDS,
  EntityDefinitionError,
  EntitySchemaMismatchError,
  EntityValueError,
  ensureEntityTables,
  openStandaloneEntityStore,
  type EntityDefinition,
} from "../src/storage/entity/index.js";
import {
  openDatabase,
  withImmediateTransaction,
  type DatabaseSyncLike,
} from "../src/storage/sqlite/sqliteBridge.js";

interface DocumentRow {
  id: string;
  title: string;
  count: number;
  active: boolean;
  note: string | null;
}

const documentDefinition: EntityDefinition<DocumentRow> = {
  tableName: "documents",
  primaryKey: "id",
  columns: {
    id: { kind: ENTITY_COLUMN_KINDS.TEXT },
    title: { kind: ENTITY_COLUMN_KINDS.TEXT },
    count: { kind: ENTITY_COLUMN_KINDS.INTEGER },
    active: { kind: ENTITY_COLUMN_KINDS.BOOLEAN },
    note: { kind: ENTITY_COLUMN_KINDS.TEXT, nullable: true },
  },
};

async function withDatabase(run: (database: DatabaseSyncLike) => void | Promise<void>): Promise<void> {
  const database = await openDatabase(":memory:");
  try {
    await run(database);
  } finally {
    database.close();
  }
}

describe("standalone entity store", () => {
  it("creates a table and supports save, read, update, and remove", async () => {
    await withDatabase((database) => {
      ensureEntityTables(database, [documentDefinition]);
      const store = createEntityStore(database, documentDefinition);

      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("documents"))
        .toBeDefined();

      const first: DocumentRow = {
        id: "doc-1",
        title: "first",
        count: 1,
        active: true,
        note: null,
      };
      expect(store.save(first)).toBe(first);
      expect(store.findById("doc-1")).toEqual(first);

      const updated: DocumentRow = { ...first, title: "updated", count: 2, active: false, note: "memo" };
      store.save(updated);
      expect(store.findAll()).toEqual([updated]);
      expect(store.findById("missing")).toBeNull();
      expect(store.remove(updated)).toBe(true);
      expect(store.remove("doc-1")).toBe(false);
    });
  });

  it("rejects invalid values before writing", async () => {
    await withDatabase((database) => {
      const store = createEntityStore(database, documentDefinition);
      expect(() => store.save({
        id: "doc-1",
        title: 42 as unknown as string,
        count: 1,
        active: true,
        note: null,
      })).toThrow(EntityValueError);
      expect(store.findAll()).toEqual([]);
    });
  });

  it("fails closed when an existing table drifts from its definition", async () => {
    await withDatabase((database) => {
      const store = createEntityStore(database, documentDefinition);
      expect(store.findAll()).toEqual([]);
      expect(() => createEntityStore(database, {
        ...documentDefinition,
        columns: {
          ...documentDefinition.columns,
          count: { kind: ENTITY_COLUMN_KINDS.REAL },
        },
      })).toThrow(EntitySchemaMismatchError);
    });
  });

  it("rejects unsafe table identifiers", async () => {
    await withDatabase((database) => {
      expect(() => createEntityStore(database, {
        ...documentDefinition,
        tableName: "documents; DROP TABLE documents",
      })).toThrow(EntityDefinitionError);
    });
  });

  it("can initialize sync tables and a domain table through the standalone helper", async () => {
    const store = await openStandaloneEntityStore({
      databasePath: ":memory:",
      definition: documentDefinition,
    });
    try {
      const tables = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.length).toBeGreaterThan(20);
      expect(store.findAll()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("can save an entity inside an outer writer transaction", async () => {
    await withDatabase((database) => {
      const store = createEntityStore(database, documentDefinition);
      const row: DocumentRow = {
        id: "nested-1",
        title: "nested",
        count: 1,
        active: true,
        note: null,
      };

      withImmediateTransaction(database, () => {
        store.save(row);
      });

      expect(store.findById(row.id)).toEqual(row);
    });
  });
});
