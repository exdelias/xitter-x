// End-to-end check of Original Content Rewards (content-rewards.ts) against a
// running server: which engagements count, what a viral post earns, that
// each 15-minute window and each engaging account pay once, the daily most,
// and what the author sees. It runs the payout itself with a chosen "now"
// rather than waiting for windows to end, and clears reward windows around
// now, so it refuses a database whose name doesn't contain "test".
// Needs an admin and two plain accounts with the same password; makes its own
// engaging accounts and removes them, and leaves the program off.
// usage: DATABASE_URL=<the server's database> bun scripts/test-content-rewards.ts <admin> <author> <other author> <password>

import { createUser } from "../src/auth";
import { WINDOW_MS, payContentRewards, windowEndBefore } from "../src/content-rewards";
import { sql } from "../src/db";
import { pushItems } from "../src/notifications";
import { loadSettings } from "../src/settings";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, authorName, otherName, password] = process.argv.slice(2);
if (!adminName || !authorName || !otherName || !password) throw new Error("usage: bun scripts/test-content-rewards.ts <admin> <author> <other author> <password>");
if (!/test/.test(new URL(process.env.DATABASE_URL ?? "postgres://x@localhost/xitter").pathname)) throw new Error("Use a throwaway database with \"test\" in its name: this clears reward windows.");

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
	const page = async (path: string) => (await fetch(`${origin}${path}`, { headers: { cookie: headers.cookie } })).text();
	// Equicoins' one-time disclaimer, before its pages open
	const accept = async () => fetch(`${origin}/account/money`, { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams({ action: "accept", back: "/account/money" }), redirect: "manual" });
	return { gql, get, admin, page, accept };
}

const boss = await session(adminName);
const author = await session(authorName);
const other = await session(otherName);
const idOf = async (name: string) => (await sql`select id::text from users where lower(screen_name) = lower(${name})`)[0].id as string;
const [authorId, otherId] = await Promise.all([idOf(authorName), idOf(otherName)]);
const balance = async (id: string) => Number((await sql`select balance_cents from money_wallets where user_id = ${id}::bigint`)[0]?.balance_cents ?? 0);

// the rules the checks below count on
const rules = { enabled: true, premium_only: true, min_engagements: 3, min_views: 0, per_engagement: "0.10", per_1000_views: "1", max_post: "50", daily_cap: "1", max_post_age_hours: 72, min_account_days: 7 };
await boss.admin("saveSettings", { features: { money: true, premium: true } });
await boss.admin("saveContentRewards", { ...rules, enabled: false });
await sql`delete from content_reward_runs where window_end > now() - interval '3 hours'`;
await sql`delete from content_rewards where author_id in (${authorId}::bigint, ${otherId}::bigint)`;

check((await author.admin("saveContentRewards", rules)).status === 403, "an account without staff powers can't change the rules");
check((await boss.admin("saveContentRewards", { ...rules, min_engagements: 0, min_views: 0 })).status === 400, "switching on with nothing that makes a post viral is refused");
check((await boss.admin("saveContentRewards", rules)).status === 200, "staff switch the program on");
const marker = (await sql`select window_end from content_reward_runs where marker order by window_end desc limit 1`)[0];
check(!!marker && new Date(marker.window_end).getTime() === windowEndBefore(Date.now()), "it starts from the 15 minutes running now");
await loadSettings();

// engaging accounts: 13 a month old, one made today
const tag = `rw${Date.now().toString(36).slice(-6)}`;
const fans: { id: string; name: string }[] = [];
for (let i = 0; i < 13; i++) {
	const name = `${tag}f${i}`;
	fans.push({ id: await createUser(name, name, password), name });
}
await sql`update users set created_at = now() - interval '30 days' where id = any(${sql.array(fans.map((f) => f.id), "INT8")})`;
const fresh = { name: `${tag}new`, id: "" };
fresh.id = await createUser(fresh.name, fresh.name, password);
const sessions = await Promise.all(fans.slice(0, 5).map((f) => session(f.name)));
const freshSession = await session(fresh.name);

await author.accept();
await other.accept();
// premium only: the author has a plan, the other author doesn't
await boss.admin("setPremium", { user: authorName, tier: "basic", until: "" });
await boss.admin("endPremium", { id: otherId }).catch(() => {});
check((await other.page("/account/money/rewards")).includes("Premium plan"), "the other author's Rewards page says a Premium plan is needed");
check((await author.page("/account/money/rewards")).includes("earn when they go viral"), "the author's says their posts earn");

const post = async (who: typeof author, text: string, extra: object = {}) => (await who.gql("CreateTweet", { tweet_text: text, ...extra }))?.data?.create_tweet?.tweet_results?.result?.rest_id as string;
const viral = await post(author, `going viral ${tag}`);
const quiet = await post(author, `barely noticed ${tag}`);
const hidden = await post(author, `hidden by staff ${tag}`);
const otherPost = await post(other, `no plan here ${tag}`);
// five accounts each like the viral post; some also repost, reply and bookmark it (still one each)
for (const s of sessions) {
	await s.gql("FavoriteTweet", { tweet_id: viral });
	await s.get("TweetDetail", { focalTweetId: viral });
	await s.gql("FavoriteTweet", { tweet_id: hidden });
	await s.gql("FavoriteTweet", { tweet_id: otherPost });
}
await sessions[0].gql("CreateRetweet", { tweet_id: viral });
const reply = await post(sessions[1], `nice ${tag}`, { reply: { in_reply_to_tweet_id: viral, exclude_reply_user_ids: [] } });
await sessions[2].gql("CreateBookmark", { tweet_id: viral });
await sessions[0].gql("FavoriteTweet", { tweet_id: quiet });
// neither the author's own like nor a new account's counts
await author.gql("FavoriteTweet", { tweet_id: viral });
await freshSession.gql("FavoriteTweet", { tweet_id: viral });
await boss.admin("setPostVisibility", { id: hidden, hidden: true, sensitive: false });

const before = await balance(authorId);
const first = windowEndBefore(Date.now()) + WINDOW_MS;
const ran = await payContentRewards(first + 1000);
check(ran.length === 1 && ran[0].window_end === first, "the window the engagements fell in is paid once it has ended", ran);
const paid = await sql`select post_id::text, engagements, views, cents from content_rewards where window_end = ${new Date(first)} order by cents desc`;
const forViral = paid.find((p: any) => p.post_id === viral);
check(forViral?.engagements === 5, "five accounts engaged: a like, repost, reply and bookmark from one account count once, the author's own and a new account's not at all", forViral);
check(forViral?.views === 5, "and five saw it", forViral?.views);
check(forViral?.cents === 50, "5 engagements at 10¢ (5 views earn under a cent)", forViral?.cents);
check(!paid.some((p: any) => p.post_id === quiet), "a post with one like isn't viral");
check(!paid.some((p: any) => p.post_id === hidden), "a hidden post earns nothing");
check(!paid.some((p: any) => p.post_id === otherPost), "an author without Premium earns nothing while Premium is required");
check((await balance(authorId)) - before === 50, "the 50¢ went straight into the author's wallet");
check((await payContentRewards(first + 1000)).length === 0 && (await balance(authorId)) - before === 50, "running again pays that window no more");

// the next window: three new accounts, and one that unliked and liked again
const second = first + WINDOW_MS;
const inSecond = new Date(second - 5 * 60_000);
await sessions[0].gql("UnfavoriteTweet", { tweet_id: viral });
await sessions[0].gql("FavoriteTweet", { tweet_id: viral });
await sql`update likes set created_at = ${inSecond} where post_id = ${viral}::bigint and user_id = ${fans[0].id}::bigint`;
for (const f of fans.slice(5, 8)) await sql`insert into likes (user_id, post_id, created_at) values (${f.id}::bigint, ${viral}::bigint, ${inSecond})`;
await payContentRewards(second + 1000);
const [again] = await sql`select engagements, cents from content_rewards where window_end = ${new Date(second)} and post_id = ${viral}::bigint`;
check(again?.engagements === 3 && again?.cents === 30, "the next 15 minutes pay the three new accounts; liking again doesn't count twice", again);

// the daily most: $1.00, of which 80¢ is paid
const third = second + WINDOW_MS;
for (const f of fans.slice(8, 13)) await sql`insert into likes (user_id, post_id, created_at) values (${f.id}::bigint, ${viral}::bigint, ${new Date(third - 60_000)})`;
await payContentRewards(third + 1000);
const [capped] = await sql`select engagements, cents from content_rewards where window_end = ${new Date(third)} and post_id = ${viral}::bigint`;
check(capped?.engagements === 5 && capped?.cents === 20, "past the daily most of $1.00, only the 20¢ left is paid", capped);
check((await balance(authorId)) - before === 100, "$1.00 in all");

// what the author sees
const rewardsPage = await author.page("/account/money/rewards");
check(rewardsPage.includes("$1.00") && rewardsPage.includes("Original content reward"), "the Rewards page shows the total and each payout");
check((await author.page("/account/money")).includes("Original content reward"), "and so does Equicoins' activity");
const pushes = await pushItems(authorId, Date.now() - 60 * 60_000);
check(pushes.some((p) => p.text.includes("earned $0.50 from Original Content Rewards")), "a notification says what the post earned", pushes.map((p) => p.text).filter((t) => t.includes("Rewards")));
const stats = await boss.admin("money");
check(stats.rewards?.stats?.top?.some((t: any) => t.id === authorId && t.cents === 100), "staff see the author among the top earners", stats.rewards?.stats?.top);

// switched off, nothing is paid
await boss.admin("saveContentRewards", { ...rules, enabled: false });
await loadSettings();
await sql`insert into likes (user_id, post_id, created_at) values (${fresh.id}::bigint, ${quiet}::bigint, ${new Date(third + WINDOW_MS - 60_000)}) on conflict do nothing`;
check((await payContentRewards(third + WINDOW_MS + 1000)).length === 0, "switched off, no window is paid");

// clean up: the engaging accounts, the posts, the plan and the windows
for (const id of [viral, quiet, hidden, reply]) if (id) await author.gql("DeleteTweet", { tweet_id: id }).catch(() => {});
if (reply) await sessions[1].gql("DeleteTweet", { tweet_id: reply });
if (otherPost) await other.gql("DeleteTweet", { tweet_id: otherPost });
await sql`delete from posts where id = any(${sql.array([viral, quiet, hidden, otherPost].filter(Boolean), "INT8")})`;
await sql`delete from users where id = any(${sql.array([...fans.map((f) => f.id), fresh.id], "INT8")})`;
await boss.admin("endPremium", { id: authorId });
await sql`delete from content_reward_runs where window_end > now() - interval '3 hours'`;
await sql.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
