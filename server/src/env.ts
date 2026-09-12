import { config } from 'dotenv';
import { existsSync } from 'node:fs';

/**
 * Environment loading.
 *
 * Must be imported FIRST in the entrypoint: other modules read process.env at
 * module scope, and ES imports are evaluated in order, so anything loaded after
 * them would arrive too late.
 *
 * dotenv does not overwrite variables that are already set, so precedence runs
 * real environment variables > .env > .env.local. That ordering is what lets a
 * container be configured entirely through its environment with no file at all.
 * Both files are gitignored.
 */
const FILES = ['.env', '.env.local'];

export const loadedEnvFiles: string[] = [];
for (const file of FILES) {
  if (!existsSync(file)) continue;
  config({ path: file });
  loadedEnvFiles.push(file);
}
