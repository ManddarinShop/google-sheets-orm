import { SheetCell } from "./Adapter.js";
import { ParseError } from "./Errors.js";

export interface Column<T> {
  readonly isOptional: boolean;
  parse(value: SheetCell, columName: string): T;
  serialize(value: T): SheetCell;
  optional(): Column<T | undefined>;
}

class BaseColumn<T> implements Column<T> {
  constructor(
    readonly isOptional: boolean,
    private readonly parser: (value: SheetCell, columnName: string) => T,
    private readonly serializer: (value: T) => SheetCell,
  ) {}

  parse(value: SheetCell, columnName: string): T {
    if (this.isOptional && isEmptyCell(value)) {
      return undefined as T;
    }

    if (!this.isOptional && isEmptyCell(value)) {
      throw new ParseError(`Missing required value for column "${columnName}"`);
    }

    return this.parser(value, columnName);
  }
  serialize(value: T): SheetCell {
    if (value === undefined) {
      return null;
    }

    return this.serializer(value);
  }
  optional(): Column<T | undefined> {
    return new BaseColumn<T | undefined>(
      true,
      this.parser as (value: SheetCell, columnName: string) => T | undefined,
      this.serializer as (value: T | undefined) => SheetCell,
    );
  }
}

function isEmptyCell(value: SheetCell): boolean {
  return value === null || value === "";
}

export function text(): Column<string> { 
    return new BaseColumn<string>(
        false,
        value => String(value),
        value => value,
    );
}


export function number(): Column<number> {
  return new BaseColumn<number>(
    false,
      (value, columnName) => { 
          const parsed = typeof value === "number" ? value : Number(value);

          if (!Number.isFinite(parsed)) { 
              throw new ParseError(`Invalid number for column "${columnName}"`);
          }

          return parsed;
      },
    (value) => value,
  );
}


export function boolean(): Column<boolean> {
  return new BaseColumn<boolean>(
    false,
    (value, columnName) => {
        if (typeof value === "boolean") { 
            return value;
        }

        if (value === "true") { 
            return true;
        }

        if (value === "false") {
          return false;
        }

        throw new ParseError(`Invalid boolean for column "${columnName}"`);
    },
    (value) => value,
  );
}

