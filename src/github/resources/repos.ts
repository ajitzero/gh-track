/** `GET /users/{login}/repos` pagination. */

export const REPOS_PER_PAGE = 100;

export function reposUrl(apiBase: string, login: string, page: number): string {
  return `${apiBase}/users/${encodeURIComponent(login)}/repos?per_page=${REPOS_PER_PAGE}&page=${page}&sort=updated`;
}
