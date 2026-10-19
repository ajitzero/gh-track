async function getGitHubFollowBack(username) {
	async function fetchUsers(type) {
		const users = [];
		let page = 1;

		while (true) {
			const response = await fetch(
				`https://api.github.com/users/${encodeURIComponent(username)}/${type}?per_page=100&page=${page}`,
			);

			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status}`);
			}

			const data = await response.json();
			users.push(...data.map((user) => user.login));

			if (data.length < 100) break;
			page++;
		}

		return users;
	}

	const [followers, following] = await Promise.all([
		fetchUsers('followers'),
		fetchUsers('following'),
	]);

	const followerSet = new Set(followers.map((u) => u.toLowerCase()));
	const followingSet = new Set(following.map((u) => u.toLowerCase()));

	return {
		followers,
		following,
		followBack: following.filter((u) => followerSet.has(u.toLowerCase())),
		notFollowingBack: following.filter((u) => !followerSet.has(u.toLowerCase())),
		youDontFollowBack: followers.filter((u) => !followingSet.has(u.toLowerCase())),
	};
}

