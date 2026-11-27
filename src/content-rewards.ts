// Original Content Rewards: every 3 minutes, posts and replies going viral
// earn their authors Equicoins (money.ts), held for payout.
//
// Each window is 3 minutes (UTC, :00, :03, :06, ...), paid once it has
// ended: its row in content_reward_runs is written in the same transaction
// as its earnings, so a restart or a second process can't pay a window
// twice. Windows missed while the server was down are caught up, up to an
// hour back; switching the program on starts it from that moment.
//
// A post's counts are the ones it shows: its likes, reposts, replies, quotes,
// bookmarks and views: the real count plus the custom one (count_overrides),
// exactly as posts.ts counts them. content_reward_credited keeps, per post, the counts
// it showed when it last earned; each window, what it shows above that is
// new, and the post goes viral when enough is new (engagements, or views).
// When it earns, everything new is paid in full and everything it shows is
// rewarded, so a post earns again only when its counts rise,
// and a count lowered and raised again earns nothing twice. Each earning
// keeps the post's full counts at that moment (content_rewards).
//
// Earnings don't go straight into the wallet: they wait in
// content_reward_balances until the account pays them out, up to
// payout_cap_cents. Reaching that pays them out by themselves within
// payout_hours (autoPayouts, run every minute).
//
// The pay grows with what's new, and the share of new viewers who engaged
// (the engagement rate) scales it: 5% pays as is, less pays down to half,
// more up to double.
//
// What earns: posts, replies and quotes (reposts aren't posts here) made in
// the last few days by an active local account with at least min_followers
// followers (and a Premium plan, unless that's switched off), not hidden,
// limited (Fosnr), an ad or a Circle post.

import { sql } from "./db";
import { newId } from "./ids";
import { ensureWallet } from "./money";
import { feature, settings } from "./settings";

export const WINDOW_MS = 3 * 60_000;
// windows caught up at most after a pause, the latest included
const CATCH_UP = 20;

export type RewardRules = ReturnType<typeof settings>["content_rewards"];

// the end of the last window that has ended by `ms`
export const windowEndBefore = (ms: number) => Math.floor(ms / WINDOW_MS) * WINDOW_MS;

// the window ends still to pay after `last` (the last one paid), up to `latest`
export function windowsToRun(last: number | null, latest: number, most = CATCH_UP): number[] {
	const from = last === null ? latest : Math.max(last + WINDOW_MS, latest - (most - 1) * WINDOW_MS);
	const out: number[] = [];
	for (let at = from; at <= latest; at += WINDOW_MS) out.push(at);
	return out;
}

export const isViral = (engagements: number, views: number, r: RewardRules) =>
	(r.min_engagements > 0 && engagements >= r.min_engagements) || (r.min_views > 0 && views >= r.min_views);

// the engagement rate's weight on the pay: 1 at 5%, from 0.5 to 2
export function rateFactor(engagements: number, views: number, r: RewardRules) {
	if (!r.rate_bonus || views <= 0) return 1;
	return Math.min(2, Math.max(0.5, 0.5 + (engagements / views) * 10));
}

// what a viral post earns in one window: every new engagement and view, in full
export const payoutFor = (engagements: number, views: number, r: RewardRules) =>
	Math.floor((engagements * r.cents_per_engagement + Math.floor((views * r.cents_per_1000_views) / 1000)) * rateFactor(engagements, views, r));

export const METRICS = ["likes", "reposts", "replies", "quotes", "bookmarks", "views"] as const;
export type Metric = (typeof METRICS)[number];
export type Counts = Record<Metric, number>;
const ENGAGING = ["likes", "reposts", "replies", "quotes", "bookmarks"] as const;

// a post's counts as it shows them (posts.ts): a custom count wins over the real one
const SUSPENDED = sql`(select id from users where status = 'suspended' or instance_blocked)`;
const shownCounts = (p: any) => sql`
	(coalesce((${p}.count_overrides->>'likes')::int, 0) + (select count(*)::int from likes x where x.post_id = ${p}.id and x.user_id not in ${SUSPENDED})) as likes,
	(coalesce((${p}.count_overrides->>'reposts')::int, 0) + (select count(*)::int from reposts x where x.post_id = ${p}.id and x.user_id not in ${SUSPENDED})) as reposts,
	(coalesce((${p}.count_overrides->>'replies')::int, 0) + (select count(*)::int from posts x where x.reply_to_id = ${p}.id and x.user_id not in ${SUSPENDED})) as replies,
	(coalesce((${p}.count_overrides->>'quotes')::int, 0) + (select count(*)::int from posts x where x.quote_id = ${p}.id and x.user_id not in ${SUSPENDED})) as quotes,
	(coalesce((${p}.count_overrides->>'bookmarks')::int, 0) + (select count(*)::int from bookmarks x where x.post_id = ${p}.id)) as bookmarks,
	(coalesce((${p}.count_overrides->>'views')::int, 0) + (select count(*)::int from post_views x where x.post_id = ${p}.id)) as views`;

// what of `shown` hasn't earned yet, per count
export function fresh(shown: Counts, credited: Counts) {
	const d = {} as Counts;
	for (const m of METRICS) d[m] = Math.max(0, shown[m] - credited[m]);
	return { d, engagements: ENGAGING.reduce((n, m) => n + d[m], 0), views: d.views };
}

// credited after a post earns: everything it shows, so only a rise earns again
export function creditAfter(shown: Counts, credited: Counts) {
	const out = {} as Counts;
	for (const m of METRICS) out[m] = Math.max(shown[m], credited[m]);
	return out;
}

// Pays one window, in one transaction; false when it was paid already.
// `run` runs it in a transaction (a test passes a savepoint)
type Run = <T>(fn: (tx: typeof sql) => Promise<T>) => Promise<T>;
const begin: Run = (fn) => sql.begin(fn as any) as any;

export async function payWindow(endMs: number, r: RewardRules, run: Run = begin): Promise<{ posts: number; cents: number } | false> {
	const end = new Date(endMs);
	return run(async (tx) => {
		const [ran] = await tx`insert into content_reward_runs (window_end) values (${end}) on conflict do nothing returning window_end`;
		if (!ran) return false;
		// every post that may earn, with what it shows and what has earned
		const rows = await tx`
			select p.id::text, p.user_id::text as author, ${shownCounts(sql`p`)},
				coalesce(k.likes, 0) as c_likes, coalesce(k.reposts, 0) as c_reposts, coalesce(k.replies, 0) as c_replies,
				coalesce(k.quotes, 0) as c_quotes, coalesce(k.bookmarks, 0) as c_bookmarks, coalesce(k.views, 0) as c_views
			from posts p join users a on a.id = p.user_id left join user_stats s on s.user_id = a.id
				left join content_reward_credited k on k.post_id = p.id
			where a.instance is null and a.status = 'active' and not a.shadow_banned and a.deactivated_at is null
				and ${followersOf(sql`a`, sql`s`)} >= ${r.min_followers} ${r.premium_only ? sql`and a.premium_tier is not null` : sql``}
				and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.notice->>'type' is distinct from 'Fosnr'
				and p.created_at < ${end} and p.created_at >= ${end}::timestamptz - make_interval(hours => ${r.max_post_age_hours})`;
		const viral = (rows as any[])
			.map((x) => {
				const shown = Object.fromEntries(METRICS.map((m) => [m, Number(x[m])])) as Counts;
				const credited = Object.fromEntries(METRICS.map((m) => [m, Number(x[`c_${m}`])])) as Counts;
				return { id: x.id as string, author: x.author as string, shown, credited, ...fresh(shown, credited) };
			})
			.filter((c) => isViral(c.engagements, c.views, r))
			// the most engaged first
			.sort((a, b) => b.engagements - a.engagements || b.views - a.views);
		let posts = 0;
		let total = 0;
		for (const c of viral) {
			const cents = payoutFor(c.engagements, c.views, r);
			if (cents <= 0) continue;
			const next = creditAfter(c.shown, c.credited);
			await tx`insert into content_reward_credited (post_id, likes, reposts, replies, quotes, bookmarks, views, updated_at)
				values (${c.id}::bigint, ${next.likes}, ${next.reposts}, ${next.replies}, ${next.quotes}, ${next.bookmarks}, ${next.views}, now())
				on conflict (post_id) do update set likes = excluded.likes, reposts = excluded.reposts, replies = excluded.replies,
					quotes = excluded.quotes, bookmarks = excluded.bookmarks, views = excluded.views, updated_at = now()`;
			await tx`insert into content_rewards (id, window_end, post_id, author_id, engagements, views, cents,
					likes, reposts, replies, quotes, bookmarks, total_views)
				values (${newId()}::bigint, ${end}, ${c.id}::bigint, ${c.author}::bigint, ${c.engagements}, ${c.views}, ${cents},
					${c.shown.likes}, ${c.shown.reposts}, ${c.shown.replies}, ${c.shown.quotes}, ${c.shown.bookmarks}, ${c.shown.views})`;
			await hold(tx, c.author, cents, r);
			posts++;
			total += cents;
		}
		await tx`update content_reward_runs set posts = ${posts}, cents = ${total} where window_end = ${end}`;
		return { posts, cents: total };
	});
}

// an account's followers as its profile shows them: a custom count wins
export const followersOf = (u: any, s: any) => sql`coalesce((${u}.count_overrides->>'followers')::int, ${s}.followers, 0)`;

// earnings wait for payout; reaching the most an account may hold notes when
async function hold(tx: typeof sql, userId: string, cents: number, r: RewardRules) {
	await tx`insert into content_reward_balances (user_id, pending_cents, cap_reached_at)
		values (${userId}::bigint, ${cents}, case when ${cents} >= ${r.payout_cap_cents} then now() end)
		on conflict (user_id) do update set pending_cents = content_reward_balances.pending_cents + excluded.pending_cents,
			cap_reached_at = coalesce(content_reward_balances.cap_reached_at,
				case when content_reward_balances.pending_cents + excluded.pending_cents >= ${r.payout_cap_cents} then now() end)`;
}

export class RewardsError extends Error {}

// everything waiting goes into the wallet, by the account or by itself
export async function payOutRewards(userId: string, automatic = false, run: Run = begin) {
	return run(async (tx) => {
		await ensureWallet(userId, tx);
		const [b] = await tx`select pending_cents from content_reward_balances where user_id = ${userId}::bigint for update`;
		const cents = Number(b?.pending_cents ?? 0);
		if (cents <= 0) {
			if (automatic) return 0;
			throw new RewardsError("There's nothing to pay out yet.");
		}
		await tx`update content_reward_balances set pending_cents = 0, cap_reached_at = null where user_id = ${userId}::bigint`;
		await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${userId}::bigint`;
		await tx`insert into content_reward_payouts (id, user_id, cents, automatic) values (${newId()}::bigint, ${userId}::bigint, ${cents}, ${automatic})`;
		return cents;
	});
}

// balances at the most an account may hold, paid out at the next run, well
// inside payout_hours; run every minute (server.ts)
export async function autoPayouts() {
	const r = settings().content_rewards;
	if (!feature("money")) return 0;
	const due = await sql`select user_id::text from content_reward_balances
		where pending_cents > 0 and (pending_cents >= ${r.payout_cap_cents} or cap_reached_at <= now() - make_interval(hours => ${r.payout_hours}))`;
	let paid = 0;
	for (const d of due) if (await payOutRewards(d.user_id, true)) paid++;
	return paid;
}

// the windows that have ended and aren't paid yet; run every minute (server.ts)
export async function payContentRewards(now = Date.now()) {
	const r = settings().content_rewards;
	if (!feature("money") || !r.enabled) return [];
	const [last] = await sql`select max(window_end) as at from content_reward_runs`;
	const done: { window_end: number; posts: number; cents: number }[] = [];
	for (const end of windowsToRun(last?.at ? new Date(last.at).getTime() : null, windowEndBefore(now))) {
		const result = await payWindow(end, r);
		if (result) done.push({ window_end: end, ...result });
	}
	return done;
}

// switched on: start from the window that is running, not from what came before
export async function markRewardsStart(now = Date.now()) {
	await sql`insert into content_reward_runs (window_end, marker) values (${new Date(windowEndBefore(now))}, true) on conflict do nothing`;
}

// an account's standing in the program and what it earned (the Rewards page)
export async function rewardsOf(userId: string) {
	const r = settings().content_rewards;
	const [[u], totals, recent] = await Promise.all([
		sql`select u.instance, u.status, u.shadow_banned, u.premium_tier, ${followersOf(sql`u`, sql`s`)}::int as followers,
			coalesce(b.pending_cents, 0)::bigint as pending, b.cap_reached_at,
			(select coalesce(sum(cents), 0) from content_reward_payouts where user_id = u.id)::bigint as paid_out
			from users u left join user_stats s on s.user_id = u.id left join content_reward_balances b on b.user_id = u.id where u.id = ${userId}::bigint`,
		sql`select coalesce(sum(cents) filter (where created_at > now() - interval '1 day'), 0)::bigint as day,
			coalesce(sum(cents), 0)::bigint as total, count(*)::int as payouts from content_rewards where author_id = ${userId}::bigint`,
		sql`select c.window_end, c.post_id::text, c.engagements, c.views, c.cents, c.likes, c.reposts, c.replies, c.quotes, c.bookmarks, c.total_views, p.text, p.reply_to_id is not null as reply
			from content_rewards c left join posts p on p.id = c.post_id where c.author_id = ${userId}::bigint order by c.window_end desc, c.id desc limit 30`,
	]);
	const followers = u?.followers ?? 0;
	const why = !feature("money") || !r.enabled ? "off" : u?.instance ? "remote" : u?.status !== "active" ? "standing"
		: followers < r.min_followers ? "followers" : r.premium_only && !u?.premium_tier ? "premium" : null;
	const payouts = await sql`select cents, automatic, created_at from content_reward_payouts where user_id = ${userId}::bigint order by created_at desc limit 30`;
	return { rules: r, eligible: !why, why, followers, pending: Number(u?.pending ?? 0), capReachedAt: u?.cap_reached_at ?? null, paidOut: Number(u?.paid_out ?? 0), payoutList: payouts, day: Number(totals[0].day), total: Number(totals[0].total), payouts: totals[0].payouts, recent };
}

// Admin > Equicoins: what the program paid
export async function rewardStats() {
	const [[t], top, [last]] = await Promise.all([
		sql`select coalesce(sum(cents) filter (where created_at > now() - interval '1 day'), 0)::bigint as day,
			coalesce(sum(cents) filter (where created_at > now() - interval '7 days'), 0)::bigint as week, coalesce(sum(cents), 0)::bigint as total from content_rewards`,
		sql`select u.id::text, u.screen_name, sum(c.cents)::bigint as cents, count(*)::int as payouts from content_rewards c join users u on u.id = c.author_id
			where c.created_at > now() - interval '7 days' group by 1, 2 order by 3 desc limit 10`,
		sql`select window_end, posts, cents from content_reward_runs where not marker order by window_end desc limit 1`,
	]);
	return { day: Number(t.day), week: Number(t.week), total: Number(t.total), top: top.map((x: any) => ({ ...x, cents: Number(x.cents) })), last: last ?? null };
}
