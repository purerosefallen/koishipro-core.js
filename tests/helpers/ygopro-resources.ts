import fs from 'node:fs';
import path from 'node:path';

const YGOPRO_DIR_ENV = 'YGOPRO_DIR';
const DEFAULT_YGOPRO_DIR = '../ygopro';

function resolveProjectPath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

function requireExistingPath(label: string, filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing ${label}: ${filePath} (set ${YGOPRO_DIR_ENV} to override ${DEFAULT_YGOPRO_DIR})`,
    );
  }
  return filePath;
}

export function getYgoproDir(): string {
  return resolveProjectPath(process.env[YGOPRO_DIR_ENV] ?? DEFAULT_YGOPRO_DIR);
}

export function requireYgoproDir(): string {
  return requireExistingPath('ygopro dir', getYgoproDir());
}

export function requireYgoproScriptDir(): string {
  return requireExistingPath(
    'ygopro script dir',
    path.join(getYgoproDir(), 'script'),
  );
}

export function requireYgoproCardsPath(): string {
  return requireExistingPath(
    'ygopro cards db',
    path.join(getYgoproDir(), 'cards.cdb'),
  );
}

export function requireTestReplayPath(): string {
  return requireExistingPath(
    'replay file',
    path.join(process.cwd(), 'tests', 'test.yrp'),
  );
}

export function getReplayFixturePaths(): {
  scriptDir: string;
  cardsPath: string;
  yrpPath: string;
} {
  return {
    scriptDir: requireYgoproScriptDir(),
    cardsPath: requireYgoproCardsPath(),
    yrpPath: requireTestReplayPath(),
  };
}
