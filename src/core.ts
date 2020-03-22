import * as pg from 'pg';

import {
  Updatable,
  Whereable,
  Table,
  Column,
} from '../schema';

import { getConfig } from './config';
import { TxnClient } from './transaction';


// === symbols, types, wrapper classes and shortcuts ===

/**
 * Compiles to `DEFAULT` for use in `INSERT`/`UPDATE` queries.
 */
export const Default = Symbol('DEFAULT');
export type DefaultType = typeof Default;

/**
 * Compiles to the current column name within a `Whereable`.
 */
export const self = Symbol('self');
export type SelfType = typeof self;

/**
 * Signals all rows are to be returned (without filtering via a `WHERE` clause)
 */
export const all = Symbol('all');
export type AllType = typeof all;

export type JSONValue = null | boolean | number | string | JSONObject | JSONArray;
export type JSONObject = { [k: string]: JSONValue };
export type JSONArray = JSONValue[];

/**
 * Date represented as an ISO8601 string in JSON.
 */
export type DateString = string;

/**
 * Compiles to a numbered query parameter (`$1`, `$2`, etc) and adds the wrapped value 
 * at the appropriate position of the values array passed to pg  
 */
export class Parameter { constructor(public value: any) { } }
/**
 * Returns a `Parameter` instance, which compiles to a numbered query parameter (`$1`, 
 * `$2`, etc) and adds its wrapped value at the appropriate position of the values array 
 * passed to pg
 */
export function param(x: any) { return new Parameter(x); }

/**
 * Compiles to the wrapped string value, as is. Dangerous: https://xkcd.com/327/.
 */
export class DangerousRawString { constructor(public value: string) { } }
/**
 * Returns a `DangerousRawString` instance, wrapping a string. `DangerousRawString`
 * compiles to the wrapped string value, as is. Dangerous: https://xkcd.com/327/.
 */
export function raw(x: string) { return new DangerousRawString(x); }

/**
 * Returns a `ColumnNames` instance, wrapping either an array or object. `ColumnNames` 
 * compiles to a quoted, comma-separated list of array values (for use in a `SELECT` 
 * query) or object keys (for use in an `INSERT`, `UDPATE` or `UPSERT` query, alongside 
 * `ColumnValues`).
 */
export class ColumnNames<T> { constructor(public value: T) { } }
/**
 * Returns a `ColumnNames` instance, wrapping either an array or an object. `ColumnNames` 
 * compiles to a quoted, comma-separated list of array values (for use in a `SELECT` 
 * query) or object keys (for use in an `INSERT`, `UDPATE` or `UPSERT` query alongside 
 * a `ColumnValues`).
 */
export function cols<T>(x: T) { return new ColumnNames<T>(x); }

/**
 * Compiles to a quoted, comma-separated list of object keys for use in an `INSERT`, 
 * `UPDATE` or `UPSERT` query, alongside `ColumnNames`.
 */
export class ColumnValues<T> { constructor(public value: T) { } }
/**
 * Returns a ColumnValues instance, wrapping an object. ColumnValues compiles to a 
 * quoted, comma-separated list of object keys for use in an INSERT, UPDATE or UPSERT 
 * query alongside a `ColumnNames`.
 */
export function vals<T>(x: T) { return new ColumnValues<T>(x); }

/**
 * Compiles to the name of the column it wraps in the table of the parent query.
 * @param value The column name
 */
export class ParentColumn { constructor(public value: Column) { } }
/**
 * Returns a `ParentColumn` instance, wrapping a column name, which compiles to that 
 * column name of the table of the parent query.
 */
export function parent(x: Column) { return new ParentColumn(x); }

export type GenericSQLExpression = SQLFragment<any> | Parameter | DefaultType | DangerousRawString | SelfType;
export type SQLExpression = Table | ColumnNames<Updatable | (keyof Updatable)[]> | ColumnValues<Updatable> | Whereable | Column | GenericSQLExpression;
export type SQL = SQLExpression | SQLExpression[];

export type Queryable = pg.Pool | TxnClient<any>;


// === SQL tagged template strings ===

interface SQLResultType {
  text: string;
  values: any[];
};

/**
 * Tagged template function returning a `SQLFragment`. The first generic type argument 
 * defines what interpolated value types are allowed. The second defines what type the 
 * `SQLFragment` produces, where relevant (i.e. when calling `.run(...)` on it, or using 
 * it as the value of an `extras` object).
 */
export function sql<T = SQL, RunResult = pg.QueryResult['rows']>(literals: TemplateStringsArray, ...expressions: T[]) {
  return new SQLFragment<RunResult>(Array.prototype.slice.apply(literals), expressions);
}

export class SQLFragment<RunResult = pg.QueryResult['rows']> {

  /**
   * When calling `run`, this function is applied to the object returned by `pg` to 
   * produce the result that is returned. By default, the `rows` array is returned — i.e.
   * `(qr) => qr.rows` — but some shortcut functions alter this in order to match their 
   * declared `RunResult` type.
   */
  runResultTransform: (qr: pg.QueryResult) => any = (qr) => qr.rows;

  parentTable?: string = undefined;  // used for nested shortcut select queries

  constructor(private literals: string[], private expressions: SQLExpression[]) { }

  /**
   * Compile and run this query using the provided database connection. What's returned 
   * is piped via `runResultTransform` before being returned.
   * @param queryable A database client or pool
   */
  async run(queryable: Queryable): Promise<RunResult> {
    const query = this.compile();
    if (getConfig().verbose) console.log(query);
    const qr = await queryable.query(query);
    return this.runResultTransform(qr);
  }

  /**
   * Compile this query, returning a `{ text: string, values: any[] }` object that could 
   * be passed to the `pg` query function. Arguments are generally only passed when the 
   * function calls itself recursively.
   */
  compile(result: SQLResultType = { text: '', values: [] }, parentTable?: string, currentColumn?: Column) {
    if (this.parentTable) parentTable = this.parentTable;

    result.text += this.literals[0];
    for (let i = 1, len = this.literals.length; i < len; i++) {
      this.compileExpression(this.expressions[i - 1], result, parentTable, currentColumn);
      result.text += this.literals[i];
    }
    return result;
  }

  compileExpression(expression: SQL, result: SQLResultType = { text: '', values: [] }, parentTable?: string, currentColumn?: Column) {
    if (this.parentTable) parentTable = this.parentTable;

    if (expression instanceof SQLFragment) {
      // another SQL fragment? recursively compile this one
      expression.compile(result, parentTable, currentColumn);

    } else if (typeof expression === 'string') {
      // if it's a string, it should be a x.Table or x.Columns type, so just needs quoting
      result.text += expression.charAt(0) === '"' ? expression : `"${expression}"`;

    } else if (expression instanceof DangerousRawString) {
      // Little Bobby Tables passes straight through ...
      result.text += expression.value;

    } else if (Array.isArray(expression)) {
      // an array's elements are compiled one by one -- note that an empty array can be used as a non-value
      for (let i = 0, len = expression.length; i < len; i++) this.compileExpression(expression[i], result, parentTable, currentColumn);

    } else if (expression instanceof Parameter) {
      // parameters become placeholders, and a corresponding entry in the values array
      result.values.push(expression.value);
      result.text += '$' + String(result.values.length);  // 1-based indexing

    } else if (expression === Default) {
      // a column default
      result.text += 'DEFAULT';

    } else if (expression === self) {
      // alias to the latest column, if applicable
      if (!currentColumn) throw new Error(`The 'self' column alias has no meaning here`);
      result.text += `"${currentColumn}"`;

    } else if (expression instanceof ParentColumn) {
      // alias to the parent table (plus supplied column name) of a nested query, if applicable
      if (!parentTable) throw new Error(`The 'parent' table alias has no meaning here`);
      result.text += `"${parentTable}"."${expression.value}"`;

    } else if (expression instanceof ColumnNames) {
      // a ColumnNames-wrapped object -> quoted names in a repeatable order
      // or: a ColumnNames-wrapped array
      const columnNames = Array.isArray(expression.value) ? expression.value :
        Object.keys(expression.value).sort();
      result.text += columnNames.map(k => `"${k}"`).join(', ');

    } else if (expression instanceof ColumnValues) {
      // a ColumnValues-wrapped object -> values (in above order) are punted as SQL fragments or parameters
      const
        columnNames = <Column[]>Object.keys(expression.value).sort(),
        columnValues = columnNames.map(k => (<any>expression.value)[k]);

      for (let i = 0, len = columnValues.length; i < len; i++) {
        const
          columnName = columnNames[i],
          columnValue = columnValues[i];
        if (i > 0) result.text += ', ';
        if (columnValue instanceof SQLFragment || columnValue === Default) this.compileExpression(columnValue, result, parentTable, columnName);
        else this.compileExpression(new Parameter(columnValue), result, parentTable, columnName);
      }

    } else if (typeof expression === 'object') {
      // must be a Whereable object, so put together a WHERE clause
      const columnNames = <Column[]>Object.keys(expression).sort();

      if (columnNames.length) {  // if the object is not empty
        result.text += '(';
        for (let i = 0, len = columnNames.length; i < len; i++) {
          const
            columnName = columnNames[i],
            columnValue = (<any>expression)[columnName];
          if (i > 0) result.text += ' AND ';
          if (columnValue instanceof SQLFragment) {
            result.text += '(';
            this.compileExpression(columnValue, result, parentTable, columnName);
            result.text += ')';

          } else {
            result.text += `"${columnName}" = `;
            this.compileExpression(columnValue instanceof ParentColumn ? columnValue : new Parameter(columnValue),
              result, parentTable, columnName);
          }
        }
        result.text += ')';

      } else {
        // or if it is empty, it should always match
        result.text += 'TRUE';
      }

    } else {
      throw new Error(`Alien object while interpolating SQL: ${expression}`);
    }
  }
}


