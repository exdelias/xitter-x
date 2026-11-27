// Original Content Rewards: every 15 minutes, posts and replies going viral
// pay their authors in Equicoins (money.ts), straight into their wallets.
//
// Each window is a quarter of an hour (UTC, :00, :15, :30, :45), paid once it
// has ended: its row in content_reward_runs is written in the same
// transaction as its payouts, so a restart or a second process can't pay a
// window twice. Windows missed while the server was down are caught up, up
// to an hour back; switching the program on starts it from that moment.
//
// A post goes viral in a window when enough other accounts engaged with it
// (liked, reposted, replied, quoted or bookmarked it) or saw it for the first
// time. Each account counts once per post, ever: content_reward_engagers keeps
// whom a post was paid for, so unliking and liking again earns nothing. Only
// active local accounts some days old, not shadow banned, count; staff's
// counts (count_overrides) don't. It pays per engagement and per 1,000 views,
// held to a most per post and window and a most per account each 24 hours.
//
// The pay grows with the accounts that engaged and saw it, and the share of
// those who saw it that engaged (its engagement rate) scales it: 5% pays as
// is, less pays down to half, more up to double.
//
// What earns: posts, replies and quotes (reposts aren't posts here) made in
// the last few days by an active local account with at least min_followers
// followers (and a Premium plan, unless that's switched off), not hidden,
// limited (Fosnr), an ad or a Circle post.

import { sql } from "./db";
import { newId } from "./ids";
import { ensureWallet } from "./money";
import { feature, settings } from "./settings";

export const WINDOW_MS = 15 * 60_000;
// windows caught up at most after a pause, the latest included
const CATCH_UP = 4;

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

// what a viral post earns in one window, before the account's daily most
export const payoutFor = (engagements: number, views: number, r: RewardRules) =>
	Math.min(r.max_post_cents, Math.floor((engagements * r.cents_per_engagement + Math.floor((views * r.cents_per_1000_views) / 1000)) * rateFactor(engagements, views, r)));

// what each post got in the window: the other accounts' engagements, one
// row per account and post (the author's own left out)
const engagementsIn = (start: Date, end: Date) => sql`
	select post_id, user_id from likes where created_at >= ${start} and created_at < ${end}
	union select post_id, user_id from reposts where created_at >= ${start} and created_at < ${end}
	union select post_id, user_id from bookmarks where created_at >= ${start} and created_at < ${end}
	union select reply_to_id, user_id from posts where reply_to_id is not null and created_at >= ${start} and created_at < ${end}
	union select quote_id, user_id from posts where quote_id is not null and created_at >= ${start} and created_at < ${end}`;

// an account whose engagement or view counts
const counts = (r: RewardRules, end: Date) =>
	sql`e.instance is null and e.status = 'active' and not e.shadow_banned and e.deactivated_at is null
		and e.created_at <= ${end}::timestamptz - make_interval(days => ${r.min_account_days})`;

// Pays one window, in one transaction; false when it was paid already
async function payWindow(endMs: number, r: RewardRules): Promise<{ posts: number; cents: number } | false> {
	const end = new Date(endMs);
	const start = new Date(endMs - WINDOW_MS);
	return sql.begin(async (tx) => {
		const [run] = await tx`insert into content_reward_runs (window_end) values (${end}) on conflict do nothing returning window_end`;
		if (!run) return false;
		const candidates = await tx`
			with eng as (
				select ev.post_id, count(*)::int as n from (${engagementsIn(start, end)}) ev
					join posts p on p.id = ev.post_id join users e on e.id = ev.user_id
				where ev.user_id <> p.user_id and ${counts(r, end)}
					and not exists (select 1 from content_reward_engagers x where x.post_id = ev.post_id and x.user_id = ev.user_id)
				group by 1
			), vw as (
				select v.post_id, count(*)::int as n from post_views v join posts p on p.id = v.post_id join users e on e.id = v.user_id
				where v.created_at >= ${start} and v.created_at < ${end} and v.user_id <> p.user_id and ${counts(r, end)}
				group by 1
			)
			select p.id::text, p.user_id::text as author, coalesce(eng.n, 0) as engagements, coalesce(vw.n, 0) as views
			from (select post_id from eng union select post_id from vw) c
				join posts p on p.id = c.post_id join users a on a.id = p.user_id
				left join eng on eng.post_id = p.id left join vw on vw.post_id = p.id
				left join user_stats s on s.user_id = a.id
			where a.instance is null and coalesce(s.followers, 0) >= ${r.min_followers} and a.status = 'active' and not a.shadow_banned and a.deactivated_at is null
				${r.premium_only ? sql`and a.premium_tier is not null` : sql``}
				and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.notice->>'type' is distinct from 'Fosnr'
				and p.created_at < ${end} and p.created_at >= ${end}::timestamptz - make_interval(hours => ${r.max_post_age_hours})`;
		const viral = (candidates as any[]).filter((c) => isViral(c.engagements, c.views, r));
		if (!viral.length) return { posts: 0, cents: 0 };
		// each account's room under its daily most, lowered as its posts are paid
		const authors = [...new Set(viral.map((c) => c.author as string))];
		const room = new Map<string, number>(authors.map((a) => [a, r.daily_cap_cents]));
		for (const row of await tx`select author_id::text as id, sum(cents)::bigint as cents from content_rewards
			where author_id = any(${sql.array(authors, "INT8")}) and created_at > now() - interval '1 day' group by 1`)
			room.set(row.id, Math.max(0, r.daily_cap_cents - Number(row.cents)));
		// the most engaged first, so a daily most cuts the smallest
		viral.sort((a, b) => b.engagements - a.engagements || b.views - a.views);
		const paid: string[] = [];
		let total = 0;
		for (const c of viral) {
			const cents = Math.min(payoutFor(c.engagements, c.views, r), room.get(c.author) ?? 0);
			if (cents <= 0) continue;
			room.set(c.author, (room.get(c.author) ?? 0) - cents);
			await tx`insert into content_rewards (id, window_end, post_id, author_id, engagements, views, cents)
				values (${newId()}::bigint, ${end}, ${c.id}::bigint, ${c.author}::bigint, ${c.engagements}, ${c.views}, ${cents})`;
			await ensureWallet(c.author, tx);
			await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${c.author}::bigint`;
			paid.push(c.id);
			total += cents;
		}
		if (paid.length)
			await tx`insert into content_reward_engagers (post_id, user_id)
				select distinct ev.post_id, ev.user_id from (${engagementsIn(start, end)}) ev join posts p on p.id = ev.post_id join users e on e.id = ev.user_id
				where ev.post_id = any(${sql.array(paid, "INT8")}) and ev.user_id <> p.user_id and ${counts(r, end)} on conflict do nothing`;
		await tx`update content_reward_runs set posts = ${paid.length}, cents = ${total} where window_end = ${end}`;
		return { posts: paid.length, cents: total };
	});
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
		sql`select u.instance, u.status, u.shadow_banned, u.premium_tier, coalesce(s.followers, 0)::int as followers
			from users u left join user_stats s on s.user_id = u.id where u.id = ${userId}::bigint`,
		sql`select coalesce(sum(cents) filter (where created_at > now() - interval '1 day'), 0)::bigint as day,
			coalesce(sum(cents), 0)::bigint as total, count(*)::int as payouts from content_rewards where author_id = ${userId}::bigint`,
		sql`select c.window_end, c.post_id::text, c.engagements, c.views, c.cents, p.text, p.reply_to_id is not null as reply
			from content_rewards c left join posts p on p.id = c.post_id where c.author_id = ${userId}::bigint order by c.window_end desc, c.id desc limit 30`,
	]);
	const followers = u?.followers ?? 0;
	const why = !feature("money") || !r.enabled ? "off" : u?.instance ? "remote" : u?.status !== "active" ? "standing"
		: followers < r.min_followers ? "followers" : r.premium_only && !u?.premium_tier ? "premium" : null;
	return { rules: r, eligible: !why, why, followers, day: Number(totals[0].day), total: Number(totals[0].total), payouts: totals[0].payouts, recent };
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
