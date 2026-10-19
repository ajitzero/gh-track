/** `GET /users/{login}/followers` pagination. */

export const FOLLOWERS_PER_PAGE = 100;

export function followersUrl(apiBase: string, login: string, page: number): string {
  return `${apiBase}/users/${encodeURIComponent(login)}/followers?per_page=${FOLLOWERS_PER_PAGE}&page=${page}`;
}
