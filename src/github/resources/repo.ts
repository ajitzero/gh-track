/** `GET /repos/{owner}/{name}` for a standalone repository. */

export function repoUrl(apiBase: string, fullName: string): string {
  const [owner, name] = fullName.split('/');
  return `${apiBase}/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
}
