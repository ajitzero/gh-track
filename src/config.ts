/** TOML config load, validation, and atomic save. */

import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';

import { isCalendarDay, isValidRelativeDay } from './date.js';
import { configInvalid, configMissing, ioError } from './errors.js';
import { errorMessage, hasOwn, isRecord } from './guards.js';
import { isMetric, METRIC_ORDER, orderMetrics } from './metrics.js';
import { writeFileAtomic } from './store/atomic.js';
import { isValidRunId } from './store/paths.js';
import {
  canonicalRepoSubject,
  canonicalUserSubject,
  isValidLogin,
  isValidRepoFullName,
  parseSubject as parseSubjectSyntax,
  subjectKey,
} from './subjects.js';
import type {
  Config,
  ConfigDefaults,
  ConfigSubject,
  DashboardLayout,
  DashboardView,
  Metric,
  Resource,
  SubjectType,
  TrackingEntry,
  ViewItem,
} from './types.js';

export const SCHEMA_VERSION = 1;

const USER_RESOURCE_ORDER: readonly Resource[] = ['followers', 'repos'];
const USER_RESOURCE_SET = new Set<string>(USER_RESOURCE_ORDER);

const ROOT_KEYS = new Set(['schema_version', 'defaults', 'subjects', 'tracking', 'views']);
const DEFAULTS_KEYS = new Set([
  'raw_retention_days',
  'token_env',
  'request_timeout_ms',
  'max_retries',
]);
const SUBJECT_KEYS = new Set(['type', 'account', 'repo', 'resources']);
const TRACKING_KEYS = new Set(['metrics']);
const VIEW_KEYS = new Set(['items', 'layout', 'from', 'to']);
const VIEW_ITEM_KEYS = new Set(['subject', 'metrics']);

const VIEW_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidViewName(name: string): boolean {
  return VIEW_NAME_PATTERN.test(name);
}

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
    tracking: [],
    views: [],
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

function parseSubjectInput(
  input: string,
  location: string,
): { key: string; subject: string; type: SubjectType } {
  let parsed: ReturnType<typeof parseSubjectSyntax>;
  try {
    parsed = parseSubjectSyntax(input);
  } catch {
    fail(`${location} is not a valid subject`);
  }
  return {
    key: subjectKey(parsed),
    subject: parsed.subject,
    type: parsed.type,
  };
}

function configuredSubjects(subjects: readonly ConfigSubject[]): Map<string, ConfigSubject> {
  const map = new Map<string, ConfigSubject>();
  for (const subject of subjects) {
    map.set(subjectKey(subject), subject);
  }
  return map;
}

function parseMetrics(raw: unknown, type: SubjectType, location: string): Metric[] {
  const allowed = METRIC_ORDER[type];
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`${location} must be a non-empty array of metrics`);
  }

  const selected = new Set<Metric>();
  for (const value of raw) {
    if (typeof value !== 'string' || !isMetric(value)) {
      fail(`${location} must be a subset of ${allowed.join(',')}`);
    }
    if (!allowed.includes(value)) {
      fail(`${location} must be a subset of ${allowed.join(',')} for ${type} subjects`);
    }
    selected.add(value);
  }
  return orderMetrics(type, selected);
}

function mergeMetrics(type: SubjectType, ...groups: readonly (readonly Metric[])[]): Metric[] {
  return orderMetrics(type, groups.flat());
}

function parseTracking(
  raw: unknown,
  subjects: readonly ConfigSubject[],
): { tracking: TrackingEntry[]; warnings: string[] } {
  if (raw === undefined) {
    return { tracking: [], warnings: [] };
  }
  if (!isRecord(raw)) {
    fail('tracking must be a table');
  }

  const configured = configuredSubjects(subjects);
  const order = new Map<string, number>();
  subjects.forEach((subject, index) => {
    order.set(subjectKey(subject), index);
  });
  const tracking: TrackingEntry[] = [];
  const indexes = new Map<string, number>();
  const warnings: string[] = [];

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!isRecord(value)) {
      fail(`tracking.${key} must be a table`);
    }
    checkUnknownKeys(value, TRACKING_KEYS, `tracking.${key}.`);

    const parsed = parseSubjectInput(key, `tracking.${key}`);
    const subject = configured.get(parsed.key);
    if (subject === undefined) {
      fail(`tracking.${key} is not a configured subject`);
    }
    const metrics = parseMetrics(value.metrics, subject.type, `tracking.${key}.metrics`);

    const existingIndex = indexes.get(parsed.key);
    if (existingIndex !== undefined) {
      const existing = tracking[existingIndex];
      if (existing !== undefined) {
        existing.metrics = mergeMetrics(subject.type, existing.metrics, metrics);
      }
      warnings.push(`Duplicate tracking entry ${parsed.subject}; merged metrics.`);
      continue;
    }

    indexes.set(parsed.key, tracking.length);
    tracking.push({ subject: subject.subject, metrics });
  }

  tracking.sort((left, right) => {
    const leftIndex =
      order.get(subjectKey(parseSubjectSyntax(left.subject))) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex =
      order.get(subjectKey(parseSubjectSyntax(right.subject))) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  return { tracking, warnings };
}

function parseLayout(raw: unknown, location: string): DashboardLayout {
  if (raw === undefined) {
    return 'compact';
  }
  if (raw !== 'compact' && raw !== 'columns' && raw !== 'narrow') {
    fail(`${location} must be "compact", "columns", or "narrow"`);
  }
  return raw;
}

function parseRangeRef(raw: unknown, location: string, allowPrevious: boolean): string {
  if (raw === undefined) {
    return allowPrevious ? 'previous' : 'latest';
  }
  if (typeof raw !== 'string') {
    fail(`${location} must be a string`);
  }
  if (raw === 'latest') {
    return raw;
  }
  if (raw === 'previous') {
    if (!allowPrevious) {
      fail(`${location} cannot be "previous"`);
    }
    return raw;
  }
  if (isCalendarDay(raw) || isValidRelativeDay(raw) || isValidRunId(raw)) {
    return raw;
  }
  fail(`${location} must be latest, previous, a run id, YYYY-MM-DD, or a past offset like 1y`);
}

function parseViewItems(
  raw: unknown,
  configured: ReadonlyMap<string, ConfigSubject>,
  location: string,
): { items: ViewItem[]; warnings: string[] } {
  if (!Array.isArray(raw)) {
    fail(`${location} must be an array of tables`);
  }

  const items: ViewItem[] = [];
  const indexes = new Map<string, number>();
  const warnings: string[] = [];

  raw.forEach((entry, index) => {
    const where = `${location}[${index}]`;
    if (!isRecord(entry)) {
      fail(`${where} must be a table`);
    }
    checkUnknownKeys(entry, VIEW_ITEM_KEYS, `${where}.`);
    if (typeof entry.subject !== 'string') {
      fail(`${where}.subject is required`);
    }

    const parsed = parseSubjectInput(entry.subject, `${where}.subject`);
    const subject = configured.get(parsed.key);
    if (subject === undefined) {
      fail(`${where}.subject is not a configured subject`);
    }
    const metrics = parseMetrics(entry.metrics, subject.type, `${where}.metrics`);

    const existingIndex = indexes.get(parsed.key);
    if (existingIndex !== undefined) {
      const existing = items[existingIndex];
      if (existing !== undefined) {
        existing.metrics = mergeMetrics(subject.type, existing.metrics, metrics);
      }
      warnings.push(`Duplicate view item ${parsed.subject}; merged metrics.`);
      return;
    }

    indexes.set(parsed.key, items.length);
    items.push({ subject: subject.subject, metrics });
  });

  return { items, warnings };
}

function parseViews(
  raw: unknown,
  subjects: readonly ConfigSubject[],
): { views: DashboardView[]; warnings: string[] } {
  if (raw === undefined) {
    return { views: [], warnings: [] };
  }
  if (!isRecord(raw)) {
    fail('views must be a table');
  }

  const configured = configuredSubjects(subjects);
  const views: DashboardView[] = [];
  const warnings: string[] = [];

  for (const name of Object.keys(raw).sort()) {
    if (!VIEW_NAME_PATTERN.test(name)) {
      fail(`views.${name} is not a valid view name`);
    }
    const value = raw[name];
    if (!isRecord(value)) {
      fail(`views.${name} must be a table`);
    }
    checkUnknownKeys(value, VIEW_KEYS, `views.${name}.`);

    const items = parseViewItems(value.items, configured, `views.${name}.items`);
    if (items.items.length === 0) {
      fail(`views.${name}.items must not be empty`);
    }

    warnings.push(...items.warnings);
    views.push({
      name,
      items: items.items,
      layout: parseLayout(value.layout, `views.${name}.layout`),
      from: parseRangeRef(value.from, `views.${name}.from`, true),
      to: parseRangeRef(value.to, `views.${name}.to`, false),
    });
  }

  return { views, warnings };
}

/** Parses and validates TOML text. Throws `config_invalid` on any violation. */
export function parseConfig(text: string): ParseConfigResult {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    const message = errorMessage(error);
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
  const subjects = parseSubjects(raw.subjects);
  const tracking = parseTracking(raw.tracking, subjects.subjects);
  const views = parseViews(raw.views, subjects.subjects);

  return {
    config: {
      schemaVersion: SCHEMA_VERSION,
      defaults,
      subjects: subjects.subjects,
      tracking: tracking.tracking,
      views: views.views,
    },
    warnings: [...subjects.warnings, ...tracking.warnings, ...views.warnings],
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

  for (const entry of config.tracking) {
    lines.push(
      '',
      `[tracking.${tomlString(entry.subject)}]`,
      `metrics = [${entry.metrics.map(tomlString).join(', ')}]`,
    );
  }

  for (const view of config.views) {
    lines.push(
      '',
      `[views.${tomlString(view.name)}]`,
      `layout = ${tomlString(view.layout)}`,
      `from = ${tomlString(view.from)}`,
      `to = ${tomlString(view.to)}`,
    );
    for (const item of view.items) {
      lines.push(
        '',
        `[[views.${tomlString(view.name)}.items]]`,
        `subject = ${tomlString(item.subject)}`,
        `metrics = [${item.metrics.map(tomlString).join(', ')}]`,
      );
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
export function loadConfig(
  configPath: string,
  options?: { required?: true },
): Promise<LoadedConfig>;
export function loadConfig(
  configPath: string,
  options: { required: false },
): Promise<LoadedConfig | null>;
export function loadConfig(
  configPath: string,
  options: { required: boolean },
): Promise<LoadedConfig | null>;
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
    const message = errorMessage(error);
    throw ioError(`Failed to read ${configPath}: ${message}`, { path: configPath });
  }

  return parseConfig(text);
}

/** Writes config atomically with a private file mode. */
export async function saveConfig(configPath: string, config: Config): Promise<void> {
  await writeFileAtomic(configPath, serializeConfig(config), 0o600);
}
