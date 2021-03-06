/*
Zapatos: https://jawj.github.io/zapatos/
Copyright (C) 2020 George MacKerron
Released under the MIT licence: see LICENCE file
*/

import * as fs from 'fs';
import * as path from 'path';
import type * as pg from 'pg';


interface SchemaRules {
  [schema: string]: {
    include: '*' | string[];
    exclude: '*' | string[];
  };
}

export interface RequiredConfig {
  db: pg.ClientConfig;
}

export interface OptionalConfig {
  outDir: string;
  srcMode: 'symlink' | 'copy';
  schemas: SchemaRules;
  progressListener: boolean | ((s: string) => void);
  warningListener: boolean | ((s: string) => void);
  customTypesTransform: 'PgMy_type' | 'my_type' | 'PgMyType' | ((s: string) => string);
}

export type Config = RequiredConfig & Partial<OptionalConfig>;
export type CompleteConfig = RequiredConfig & OptionalConfig;

const defaultConfig: OptionalConfig = {
  outDir: '.',
  srcMode: 'copy',
  schemas: { public: { include: '*', exclude: [] } },
  progressListener: false,
  warningListener: true,
  customTypesTransform: 'PgMy_type',
};

export const moduleRoot = () => {
  // __dirname could be either ./generate (ts) or ./dist/generate (js)
  const parentDir = path.join(__dirname, '..');
  return fs.existsSync(path.join(parentDir, 'package.json')) ?
    parentDir :
    path.join(parentDir, '..');
};

export const finaliseConfig = (config: Config) => {
  const finalConfig = { ...defaultConfig, ...config };
  if (!finalConfig.db || Object.keys(finalConfig.db).length < 1) throw new Error(`Zapatos needs database connection details`);
  return finalConfig as CompleteConfig;
};
