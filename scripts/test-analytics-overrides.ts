// End-to-end check that counts and dates staff set on a post (admin panel:
// setPostCounts, setPostDate) are what Account Analytics shows, against a
// running server. Needs an admin and two plain accounts with the same
// password; removes what it creates.
// usage: bun scripts/test-analytics-overrides.ts <admin> <user A> <user B> <password>

import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, nameA, nameB, password] = process.argv.slice(2);
if (!adminName || !nameA || !nameB || !password) throw new Error("usage: bun scripts/test-analytics-overrides.ts <admin> <user A> <user B> <password>");

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	return { gql, get, admin };
}

const boss = await session(adminName);
const a = await session(nameA);
const b = await session(nameB);
const [userA] = await sql`select id::text from users where lower(screen_name) = lower(${nameA})`;
const DAY = 86_400_000;
const metrics = ["Impressions", "Likes", "Replies", "Retweets", "Bookmark", "Engagements"];

// totals per engagement type of the overview's daily series over [from, to)
const overview = async (from: number, to: number) => {
	const user = (await a.get("accountOverviewDailyQuery", { current_from: from, current_to: to, prev_from: from - DAY, prev_to: from }))?.data?.viewer_v2?.user_results?.result;
	const sum: Record<string, number> = {};
	for (const r of user?.current_time_series ?? []) sum[r.engagement_type] = (sum[r.engagement_type] ?? 0) + r.count;
	return { sum, followers: user?.relationship_counts?.followers, negative: (user?.current_time_series ?? []).some((r: any) => r.count < 0) };
};
const contentRow = async (from: number, to: number, id: string) => {
	const rows = (await a.get("contentPageQuery", { from_time: new Date(from).toISOString(), to_time: new Date(to).toISOString(), requested_metrics: metrics }))?.data?.viewer_v2?.user_results?.result?.tweets_results ?? [];
	const row = rows.find((t: any) => t.rest_id === id);
	return row && Object.fromEntries(row.result.organic_metrics_total.map((x: any) => [x.metric_type, x.metric_value]));
};

const post = (await a.gql("CreateTweet", { tweet_text: `analytics overrides ${Date.now()}` }))?.data?.create_tweet?.tweet_results?.result?.rest_id;
check(!!post, "A posts");
await b.gql("FavoriteTweet", { tweet_id: post });
await b.gql("CreateBookmark", { tweet_id: post });
await b.get("TweetDetail", { focalTweetId: post });

// counts set by staff
const set = await boss.admin("setPostCounts", { id: post, counts: { likes: 500, views: 10000, reposts: 7, quotes: 3, replies: 2, bookmarks: 0 } });
check(set.status === 200, "the admin sets the post's counts", set);
const now = Date.now();
const m = await contentRow(now - DAY, now + DAY, post);
check(m?.Likes === 500 && m?.Impressions === 10000 && m?.Retweets === 10 && m?.Replies === 2 && m?.Bookmark === 0, "Content shows the set counts", m);
check(m?.Engagements === 512, "and its engagements add them up", m?.Engagements);
const total = (await a.get("postDetailsProviderMetricsTotalQuery", { rest_id: post, requested_metrics: metrics }))?.data?.tweet_result_by_rest_id?.result?.organic_metrics_total;
check(total?.find((x: any) => x.metric_type === "Likes")?.metric_value === 500, "the post's page totals too", total);
const card = (await a.get("postDetailsProviderQuery", { rest_id: post }))?.data?.tweet_result_by_rest_id?.result;
check(card?.counts?.favorite_count === 500 && card?.counts?.bookmark_count === 0 && card?.views?.count === "10000", "and the post shown on it", { counts: card?.counts, views: card?.views });
const today = await overview(now - DAY, now + DAY);
check(today.sum.Fav === 500 && today.sum.Displayed === 10000 && today.sum.Retweet === 7 && today.sum.QuoteTweet === 3 && today.sum.Reply === 2, "the overview counts them", today.sum);
check(!today.sum.Bookmark && !today.negative, "a count set below the real one takes it down, not below 0", today.sum.Bookmark);
const widget = (await a.get("useFetchAnalyticsQuery", { requested_metrics: ["Likes", "Impressions"] }))?.data?.result?.result?.free_metrics_rollup;
check(widget?.find((x: any) => x.metric_type === "Likes")?.metric_value === 500, "the profile widget too", widget);
const hours = (await a.get("postDetailsProviderRealtimeDataQuery", { rest_id: post }))?.data?.tweet_result_by_rest_id?.result?.uec_instant_refresh?.items ?? [];
check(hours.filter((r: any) => r.engagement_type === "Fav").reduce((n: number, r: any) => n + r.count, 0) === 500, "and the post's live chart", hours.length);

await boss.admin("setUserCounts", { id: userA.id, counts: { followers: 4242 } });
check((await overview(now - DAY, now + DAY)).followers === 4242, "the set follower count shows as the followers");
await boss.admin("setUserCounts", { id: userA.id, counts: {} });

// a moved date: the post and its engagements go back together
check((await a.admin("setPostDate", { id: post, at: new Date(now - DAY).toISOString() })).status === 403, "only staff move a post's date");
check((await boss.admin("setPostDate", { id: post, at: new Date(now + DAY).toISOString() })).status === 400, "a date in the future is refused");
check((await boss.admin("setPostDate", { id: post, at: "2001-01-01T00:00:00Z" })).status === 400, "and one before X's first post");
check((await boss.admin("setPostDate", { id: post, at: "soon" })).status === 400, "and one that isn't a date");
const back = now - 10 * DAY;
const moved = await boss.admin("setPostDate", { id: post, at: new Date(back).toISOString() });
check(moved.status === 200, "the admin moves the post 10 days back", moved);
const shown = (await a.get("TweetResultByRestId", { tweetId: post }))?.data?.tweetResult?.result;
check(Date.parse(shown?.legacy?.created_at) === Math.floor(back / 1000) * 1000, "the post shows the new date", shown?.legacy?.created_at);
const after = await overview(now - DAY, now + DAY);
check(!after.sum.Fav && !after.sum.Displayed && !after.sum.TweetCreate, "the overview's last day no longer has it", after.sum);
const then = await overview(back - DAY, back + DAY);
check(then.sum.Fav === 500 && then.sum.Displayed === 10000 && then.sum.TweetCreate === 1, "the day it now says has it all", then.sum);
check(!(await contentRow(now - DAY, now + DAY, post)) && (await contentRow(back - DAY, back + DAY, post))?.Likes === 500, "Content lists it under its new date");
const days = (await a.get("postDetailsProviderAudienceQuery", { rest_id: post }))?.data?.tweet_result_by_rest_id?.result?.uec_metrics_daily_time_series_count ?? [];
check(days.length > 0 && days.every((r: any) => Number(r.timestamp) >= Math.floor(back / DAY) * DAY && Number(r.timestamp) < back + DAY), "the post's daily chart starts on its new day", days.map((r: any) => r.timestamp));

// the real like (B's) moves with it, without any set count
await boss.admin("setPostCounts", { id: post, counts: {} });
const real = await overview(back - DAY, back + DAY);
check(real.sum.Fav === 1 && real.sum.Bookmark === 1 && real.sum.Displayed === 1, "real engagements keep their place after the post", real.sum);

// and moving it again adds up
await boss.admin("setPostDate", { id: post, at: new Date(now).toISOString() });
const [row] = await sql`select extract(epoch from created_shift)::float8 as s from posts where id = ${post}::bigint`;
check(Math.abs(row.s) < 2, "moving it back to now leaves next to no shift", row.s);
check((await overview(now - DAY, now + DAY)).sum.Fav === 1, "and its like is back on the last day");
const log = (await boss.admin("audit", { action: "set_post_date" })).entries ?? [];
check(log.some((e: any) => JSON.stringify(e).includes(post)), "the audit log records the move");

await a.gql("DeleteTweet", { tweet_id: post });
await sql.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
