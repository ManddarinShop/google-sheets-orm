export class TypedSheetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SchemaDriftError extends TypedSheetsError {}

export class ParseError extends TypedSheetsError {}

export class ConflictError extends TypedSheetsError {}