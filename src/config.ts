/** TOML config load, validation, and atomic save. */

import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { configInvalid, configMissing, ioError } from './errors.js';
import { writeFileAtomic } from './store/atomic.js';
import {
  canonicalRepoSubject,
  canonicalUserSubject,
  isValidLogin,
  isValidRepoFullName,
  subjectKey,
} from './subjects.js';
import type { Config, ConfigDefaults, ConfigSubject, Resource } from './types.js';

export const SCHEMA_VERSION = 1;

const USER_RESOURCE_ORDER: readonly Resource[] = ['followers', 'repos'];
const USER_RESOURCE_SET = new Set<string>(USER_RESOURCE_ORDER);

const ROOT_KEYS = new Set(['schema_version', 'defaults', 'subjects']);
const DEFAULTS_KEYS = new Set([
  'raw_retention_days',
  'token_env',
  'request_timeout_ms',
  'max_retries',
]);
const SUBJECT_KEYS = new Set(['type', 'account', 'repo', 'resources']);

export interface ParseConfigResult {
  config: Config;
  warnings: string[];
}

export interface LoadConfigOptions {
  /** Defaults to true. When false, a missing file returns null. */
  required?: boolean;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw configInvalid(message);
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${location}${key} is not a recognized config key`);
    }
  }
}

function requireInteger(
  value: unknown,
  location: string,
  minimum: number,
  maximum?: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${location} must be an integer`);
  }
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `>= ${minimum}` : `between ${minimum} and ${maximum}`;
    fail(`${location} must be ${range}`);
  }
  return value;
}

export function defaultDefaults(): ConfigDefaults {
  return {
    rawRetentionDays: 30,
    tokenEnv: 'GH_TOKEN',
    requestTimeoutMs: 30_000,
    maxRetries: 3,
  };
}

export function defaultConfig(): Config {
  return {
    schemaVersion: SCHEMA_VERSION,
    defaults: defaultDefaults(),
    subjects: [],
  };
}

function canonicalUserResources(resources: Iterable<Resource>): Resource[] {
  const set = new Set(resources);
  return USER_RESOURCE_ORDER.filter((resource) => set.has(resource));
}

function parseUserResources(raw: unknown, location: string): Resource[] {
  if (raw === undefined) {
    return [...USER_RESOURCE_ORDER];
  }
  if (!Array.isArray(raw)) {
    fail(`${location} must be an array of resources`);
  }
  if (raw.length === 0) {
    fail(`${location} must not be empty`);
  }

  const resources = new Set<Resource>();
  for (const value of raw) {
    if (typeof value !== 'string' || !USER_RESOURCE_SET.has(value)) {
      fail(`${location} must be a non-empty subset of followers,repos`);
    }
    resources.add(value as Resource);
  }
  if (resources.size === 0) {
    fail(`${location} must be a non-empty subset of followers,repos`);
  }
  return canonicalUserResources(resources);
}

function parseDefaults(raw: unknown): ConfigDefaults {
  const defaults = defaultDefaults();
  if (raw === undefined) {
    return defaults;
  }
  if (!isRecord(raw)) {
    fail('defaults must be a table');
  }
  checkUnknownKeys(raw, DEFAULTS_KEYS, 'defaults.');

  if (hasOwn(raw, 'raw_retention_days')) {
    defaults.rawRetentionDays = requireInteger(
      raw.raw_retention_days,
      'defaults.raw_retention_days',
      1,
    );
  }
  if (hasOwn(raw, 'token_env')) {
    if (typeof raw.token_env !== 'string') {
      fail('defaults.token_env must be a string');
    }
    defaults.tokenEnv = raw.token_env;
  }
  if (hasOwn(raw, 'request_timeout_ms')) {
    defaults.requestTimeoutMs = requireInteger(
      raw.request_timeout_ms,
      'defaults.request_timeout_ms',
      1_000,
    );
  }
  if (hasOwn(raw, 'max_retries')) {
    defaults.maxRetries = requireInteger(raw.max_retries, 'defaults.max_retries', 0, 10);
  }
  return defaults;
}

function parseSubject(raw: unknown, index: number): ConfigSubject {
  const location = `subjects[${index}]`;
  if (!isRecord(raw)) {
    fail(`${location} must be a table`);
  }
  checkUnknownKeys(raw, SUBJECT_KEYS, `${location}.`);

  const type = raw.type;
  if (type !== 'user' && type !== 'repo') {
    fail(`${location}.type must be "user" or "repo"`);
  }

  if (type === 'user') {
    if (raw.repo !== undefined) {
      fail(`${location}.repo is only valid for repository subjects`);
    }
    if (typeof raw.account !== 'string') {
      fail(`${location}.account is required for user subjects`);
    }
    if (!isValidLogin(raw.account)) {
      fail(`${location}.account is not a valid GitHub login`);
    }
    const resources = parseUserResources(raw.resources, `${location}.resources`);
    return {
      subject: canonicalUserSubject(raw.account),
      type: 'user',
      account: raw.account,
      resources,
    };
  }

  if (raw.account !== undefined) {
    fail(`${location}.account is only valid for user subjects`);
  }
  if (raw.resources !== undefined) {
    fail(`${location}.resources is only valid for user subjects`);
  }
  if (typeof raw.repo !== 'string') {
    fail(`${location}.repo is required for repository subjects`);
  }
  if (!isValidRepoFullName(raw.repo)) {
    fail(`${location}.repo must be owner/name with exactly one slash`);
  }
  return {
    subject: canonicalRepoSubject(raw.repo),
    type: 'repo',
    repo: raw.repo,
    resources: ['repo'],
  };
}

function parseSubjects(raw: unknown): { subjects: ConfigSubject[]; warnings: string[] } {
  if (raw === undefined) {
    return { subjects: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    fail('subjects must be an array of tables');
  }

  const subjects: ConfigSubject[] = [];
  const indexes = new Map<string, number>();
  const warnings: string[] = [];

  raw.forEach((entry, index) => {
    const subject = parseSubject(entry, index);
    const key = subjectKey(subject);
    const existingIndex = indexes.get(key);

    if (existingIndex === undefined) {
      indexes.set(key, subjects.length);
      subjects.push(subject);
      return;
    }

    const existing = subjects[existingIndex];
    if (existing === undefined) {
      indexes.set(key, subjects.length);
      subjects.push(subject);
      return;
    }

    if (existing.type === 'user' && subject.type === 'user') {
      existing.resources = canonicalUserResources([...existing.resources, ...subject.resources]);
      warnings.push(`Duplicate subject ${subject.subject}; merged follower/repo resources.`);
    } else {
      warnings.push(`Duplicate subject ${subject.subject}; keeping the first entry.`);
    }
  });

  return { subjects, warnings };
}

/** Parses and validates TOML text. Throws `config_invalid` on any violation. */
export function parseConfig(text: string): ParseConfigResult {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configInvalid(`Invalid TOML: ${message}`);
  }

  if (!isRecord(raw)) {
    fail('Config must be a TOML table');
  }
  checkUnknownKeys(raw, ROOT_KEYS, '');

  if (!hasOwn(raw, 'schema_version')) {
    fail('schema_version is required and must be 1');
  }
  if (raw.schema_version !== SCHEMA_VERSION) {
    fail(`schema_version must be ${SCHEMA_VERSION}`);
  }

  const defaults = parseDefaults(raw.defaults);
  const { subjects, warnings } = parseSubjects(raw.subjects);

  return {
    config: {
      schemaVersion: SCHEMA_VERSION,
      defaults,
      subjects,
    },
    warnings,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Serializes a config to the canonical TOML form written by this tool. */
export function serializeConfig(config: Config): string {
  const lines: string[] = [
    `schema_version = ${config.schemaVersion}`,
    '',
    '[defaults]',
    `raw_retention_days = ${config.defaults.rawRetentionDays}`,
    `token_env = ${tomlString(config.defaults.tokenEnv)}`,
    `request_timeout_ms = ${config.defaults.requestTimeoutMs}`,
    `max_retries = ${config.defaults.maxRetries}`,
  ];

  for (const subject of config.subjects) {
    lines.push('', '[[subjects]]', `type = ${tomlString(subject.type)}`);
    if (subject.type === 'user') {
      lines.push(`account = ${tomlString(subject.account)}`);
      lines.push(`resources = [${subject.resources.map(tomlString).join(', ')}]`);
    } else {
      lines.push(`repo = ${tomlString(subject.repo)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Reads config from disk. A missing file throws `config_missing` unless
 * `required` is false, in which case it returns null.
 */
export async function loadConfig(
  configPath: string,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig | null> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      if (options.required === false) {
        return null;
      }
      throw configMissing(configPath);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw ioError(`Failed to read ${configPath}: ${message}`, { path: configPath });
  }

  return parseConfig(text);
}

/** Writes config atomically with a private file mode. */
export async function saveConfig(configPath: string, config: Config): Promise<void> {
  await writeFileAtomic(configPath, serializeConfig(config), 0o600);
}
