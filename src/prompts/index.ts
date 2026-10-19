/** Clack prompt wrappers. Callers must check the prompt gate first. */

import { confirm, isCancel, select, text } from '@clack/prompts';
import { interrupted } from '../errors.js';
import { parseExplicitSubject } from '../subjects.js';
import type { PromptApi, SubjectType, WatchAddAnswer } from '../types.js';

function validateValue(type: SubjectType, input: string): string | undefined {
  try {
    parseExplicitSubject(type, input);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid value';
  }
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

export function createPrompts(): PromptApi {
  return {
    watchAdd: askWatchAdd,
    selectSubject: askSelectSubject,
    confirmRemoval: askConfirmRemoval,
  };
}
