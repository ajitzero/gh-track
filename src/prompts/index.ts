/** Clack prompt wrappers. Callers must check the prompt gate first. */

import { confirm, isCancel, multiselect, select, text } from '@clack/prompts';
import { interrupted } from '../errors.js';
import { isValidLogin, isValidRepoFullName, parseExplicitSubject } from '../subjects.js';
import type {
  DashboardLayout,
  Metric,
  PromptApi,
  SubjectChoice,
  SubjectType,
  WatchAddAnswer,
} from '../types.js';

function validateValue(type: SubjectType, input: string): string | undefined {
  try {
    parseExplicitSubject(type, input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid value';
  }
}

async function askAddType(): Promise<SubjectType | null> {
  const type = await select<SubjectType>({
    message: 'What do you want to add?',
    options: [
      { value: 'user', label: 'User', hint: 'track followers' },
      { value: 'repo', label: 'Repository', hint: 'track stars and forks' },
    ],
  });
  if (isCancel(type)) {
    throw interrupted();
  }
  return type;
}

async function askUserLogin(): Promise<string | null> {
  const value = await text({
    message: 'GitHub login',
    placeholder: 'octocat',
    validate: (input) => (isValidLogin(input ?? '') ? undefined : 'Enter a valid GitHub login'),
  });
  if (isCancel(value)) {
    throw interrupted();
  }
  return value;
}

async function askRepoInput(): Promise<string | null> {
  const value = await text({
    message: 'Repository (owner/name) or owner to browse',
    placeholder: 'torvalds/linux or octocat',
    validate: (input) => {
      const raw = (input ?? '').trim();
      if (raw.length === 0) {
        return undefined;
      }
      if (raw.includes('/')) {
        return isValidRepoFullName(raw) ? undefined : 'Use owner/name with exactly one slash';
      }
      return isValidLogin(raw) ? undefined : 'Enter a valid login or owner/name';
    },
  });
  if (isCancel(value)) {
    throw interrupted();
  }
  return value.trim();
}

async function askRepoName(
  message = 'Repository (owner/name)',
): Promise<string | null> {
  const value = await text({
    message,
    placeholder: 'torvalds/linux',
    validate: (input) => {
      const raw = (input ?? '').trim();
      if (raw.length === 0) {
        return undefined;
      }
      return isValidRepoFullName(raw) ? undefined : 'Use owner/name with exactly one slash';
    },
  });
  if (isCancel(value)) {
    throw interrupted();
  }
  return value.trim();
}

async function askRepos(
  login: string,
  choices: readonly SubjectChoice[],
): Promise<string[] | null> {
  const selected = await multiselect<string>({
    message: `Public repositories for ${login}`,
    options: choices.map((choice) =>
      choice.hint === undefined
        ? { value: choice.value, label: choice.label }
        : { value: choice.value, label: choice.label, hint: choice.hint },
    ),
    required: true,
  });
  if (isCancel(selected)) {
    throw interrupted();
  }
  return selected;
}

async function askWatchAdd(): Promise<WatchAddAnswer | null> {
  const type = await select<SubjectType>({
    message: 'What do you want to watch?',
    options: [
      { value: 'user', label: 'User', hint: 'followers and owned repositories' },
      { value: 'repo', label: 'Repository', hint: 'one repository' },
    ],
  });
  if (isCancel(type)) {
    throw interrupted();
  }

  const value = await text({
    message: type === 'user' ? 'GitHub login' : 'Repository (owner/name)',
    placeholder: type === 'user' ? 'octocat' : 'torvalds/linux',
    validate: (input) => validateValue(type, input ?? ''),
  });
  if (isCancel(value)) {
    throw interrupted();
  }

  const accepted = await confirm({
    message: `Watch ${type === 'user' ? 'user' : 'repository'} ${value}?`,
  });
  if (isCancel(accepted)) {
    throw interrupted();
  }
  if (!accepted) {
    return null;
  }

  return { type, value };
}

async function askSelectSubject(subjects: readonly string[]): Promise<string | null> {
  const selected = await select<string>({
    message: 'Which subject do you want to remove?',
    options: subjects.map((subject) => ({ value: subject, label: subject })),
  });
  if (isCancel(selected)) {
    throw interrupted();
  }

  const accepted = await confirm({ message: `Remove ${selected}?` });
  if (isCancel(accepted)) {
    throw interrupted();
  }
  return accepted ? selected : null;
}

async function askConfirmRemoval(subject: string): Promise<boolean | null> {
  const accepted = await confirm({ message: `Remove ${subject}?` });
  if (isCancel(accepted)) {
    throw interrupted();
  }
  return accepted;
}

async function askSubjects(
  choices: readonly SubjectChoice[],
  initial: readonly string[],
  message = 'Which subjects?',
): Promise<string[] | null> {
  const selected = await multiselect<string>({
    message,
    options: choices.map((choice) =>
      choice.hint === undefined
        ? { value: choice.value, label: choice.label }
        : { value: choice.value, label: choice.label, hint: choice.hint },
    ),
    initialValues: [...initial],
    required: true,
  });
  if (isCancel(selected)) {
    throw interrupted();
  }
  return selected;
}

async function askMetrics(
  subject: string,
  available: readonly Metric[],
  initial: readonly Metric[],
): Promise<Metric[] | null> {
  const selected = await multiselect<Metric>({
    message: `Metrics for ${subject}`,
    options: available.map((metric) => ({ value: metric, label: metric })),
    initialValues: [...initial],
    required: true,
  });
  if (isCancel(selected)) {
    throw interrupted();
  }
  return selected;
}

async function askLayout(initial: DashboardLayout): Promise<DashboardLayout | null> {
  const selected = await select<DashboardLayout>({
    message: 'Layout',
    options: [
      { value: 'compact', label: 'Compact', hint: 'one metrics column' },
      { value: 'columns', label: 'Columns', hint: 'one column per metric' },
    ],
    initialValue: initial,
  });
  if (isCancel(selected)) {
    throw interrupted();
  }
  return selected;
}

async function askFrom(initial: string): Promise<string | null> {
  const choice = await select<string>({
    message: 'Compare from',
    options: [
      { value: 'previous', label: 'Previous observation', hint: 'default' },
      { value: 'custom', label: 'A specific date' },
    ],
    initialValue: initial === 'previous' ? 'previous' : 'custom',
  });
  if (isCancel(choice)) {
    throw interrupted();
  }
  if (choice === 'previous') {
    return 'previous';
  }

  const value = await text({
    message: 'Start date (YYYY-MM-DD)',
    placeholder: '2026-01-01',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(initial) ? { initialValue: initial } : {}),
    validate: (input) => {
      const raw = input ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return 'Use YYYY-MM-DD';
      }
      const date = new Date(`${raw}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw
        ? undefined
        : 'Not a valid calendar date';
    },
  });
  if (isCancel(value)) {
    throw interrupted();
  }
  return value;
}

async function askConfirmSelection(message: string): Promise<boolean | null> {
  const accepted = await confirm({ message });
  if (isCancel(accepted)) {
    throw interrupted();
  }
  return accepted;
}

export function createPrompts(): PromptApi {
  return {
    watchAdd: askWatchAdd,
    selectSubject: askSelectSubject,
    confirmRemoval: askConfirmRemoval,
    selectAddType: askAddType,
    askUserLogin,
    askRepoInput,
    askRepoName,
    selectRepos: askRepos,
    selectSubjects: askSubjects,
    selectMetrics: askMetrics,
    selectLayout: askLayout,
    selectFrom: askFrom,
    confirmSelection: askConfirmSelection,
  };
}
