/*
Zapatos: https://jawj.github.io/zapatos/
Copyright (C) 2020 George MacKerron
Released under the MIT licence: see LICENCE file
*/

import * as pg from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { enumDataForSchema, enumTypesForEnumData } from './enums';
import { tablesInSchema, definitionForTableInSchema, crossTableTypesForTables } from './tables';
import { moduleRoot } from './config';
import type { CompleteConfig } from './config';


export interface CustomTypes {
  [name: string]: string;  // any, or TS type for domain's base type
}

export const header = () => {
  const
    pkgPath = path.join(moduleRoot(), 'package.json'),
    pkg = JSON.parse(fs.readFileSync(pkgPath, { encoding: 'utf8' }));

  return `/*
** DON'T EDIT THIS FILE **
It's been generated by Zapatos (v${pkg.version}), and is liable to be overwritten

Zapatos: https://jawj.github.io/zapatos/
Copyright (C) 2020 George MacKerron
Released under the MIT licence: see LICENCE file
*/

`;
};

const coreImports = `import * as db from './src/core';`;

const coreDefs = `
type BasicWhereableFromInsertable<T> = { [K in keyof T]: Exclude<T[K] | db.ParentColumn, null | db.DefaultType> };
type WhereableFromBasicWhereable<T> = { [K in keyof T]?: T[K] | db.SQLFragment<any, T[K]> };
type WhereableFromInsertable<T> = WhereableFromBasicWhereable<BasicWhereableFromInsertable<T>>;

type UpdatableFromInsertable<T> = { [K in keyof T]?: T[K] | db.SQLFragment<any, T[K]> };

type JSONSelectableFromSelectable<T> = { [K in keyof T]:
  Date extends T[K] ? Exclude<T[K], Date> | db.DateString :
  Date[] extends T[K] ? Exclude<T[K], Date[]> | db.DateString[] :
  T[K]
};
`;

const customTypeHeader = `/*
** Please do edit this file as needed **
It's a placeholder for a custom type definition
*/
`;

const sourceFilesForCustomTypes = (customTypes: CustomTypes) =>
  Object.fromEntries(Object.entries(customTypes)
    .map(([name, baseType]) => [
      name,
      `${customTypeHeader}${baseType === 'db.JSONValue' ? "\nimport type * as db from '../src/core';\n" : ""}
export type ${name} = ${baseType};  // replace with your custom type or interface as desired
`,
    ]));


export const tsForConfig = async (config: CompleteConfig) => {
  const
    { schemas, db } = config,
    pool = new pg.Pool(db),
    customTypes = {},
    schemaData = (await Promise.all(
      Object.keys(schemas).map(async schema => {
        const
          rules = schemas[schema],
          tables = rules.exclude === '*' ? [] :  // exclude takes precedence
            (rules.include === '*' ? await tablesInSchema(schema, pool) : rules.include)
              .filter(table => rules.exclude.indexOf(table) < 0),
          enums = await enumDataForSchema(schema, pool),
          tableDefs = await Promise.all(tables.map(async table =>
            definitionForTableInSchema(table, schema, enums, customTypes, config, pool))),
          schemaDef = `\n/* === schema: ${schema} === */\n` +
            `\n/* --- enums --- */\n` +
            enumTypesForEnumData(enums) +
            `\n\n/* --- tables --- */\n` +
            tableDefs.sort().join('\n');

        return { schemaDef, tables };
      }))
    ),
    schemaDefs = schemaData.map(r => r.schemaDef).sort(),
    schemaTables = schemaData.map(r => r.tables),
    allTables = ([] as string[]).concat(...schemaTables).sort(),
    hasTables = allTables.length > 0,
    hasCustomTypes = Object.keys(customTypes).length > 0,
    ts = header() +
      coreImports + '\n' +
      (hasCustomTypes ? "import * as c from './custom';\n" : '') +
      coreDefs +
      schemaDefs.join('\n\n') +
      `\n\n/* === cross-table types === */\n` +
      crossTableTypesForTables(allTables),
    customTypeSourceFiles = sourceFilesForCustomTypes(customTypes);

  await pool.end();
  return { ts, customTypeSourceFiles, hasTables };
};