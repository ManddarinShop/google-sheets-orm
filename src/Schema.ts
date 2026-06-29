import { Column } from "./Columns.js";
import { SchemaDriftError } from "./Errors.js";

export type SchemaColumnMap = Record<string, Column<any>>

export interface AssertSchemaInput {
  headers: string[];
  key: string;
  columns: SchemaColumnMap;
}

export function assertSchema(input: AssertSchemaInput): void {
  const { headers, key, columns } = input;

  assertNoDuplicateHeaders(headers);
  assertColumnExists(headers, key, `Missing key column "${key}"`);
    assertColumnExists(headers, "_version", `Missing version column "_version"`);
    

    for (const columnName of Object.keys(columns)) { 
        assertColumnExists(
          headers,
          columnName,
          `Missing required column "${columnName}"`,
        );
    }
}

function assertNoDuplicateHeaders(headers: string[]): void{
    const seen = new Set<string>();

    for (const header of headers) { 
        if (seen.has(header)) { 
            throw new SchemaDriftError(`Duplicate header "${header}"`);
        }

        seen.add(header);
    }
}


function assertColumnExists(headers:string[], columnName:string, message: string): void { 
    if (!headers.includes(columnName)) { 
        throw new SchemaDriftError(message);
    }
}