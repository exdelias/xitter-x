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
// active local accounts some days old, not shadow banned, count. A post's
// custom counts (count_overrides) count too: what they show above the real
// counts is credited as it grows, in the window it grew in
// (content_reward_override_seen keeps what was credited).
//
// Earnings don't go straight into the wallet: they wait in
// content_reward_balances until the account pays them out, up to
// payout_cap_cents. Reaching that pays them out by themselves within
// payout_hours (autoPayouts, run every minute). It pays per engagement and per 1,000 views,
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
// `run` runs it in a transaction (a test passes a savepoint)
type Run = <T>(fn: (tx: typeof sql) => Promise<T>) => Promise<T>;
const begin: Run = (fn) => sql.begin(fn as any) as any;

export async function payWindow(endMs: number, r: RewardRules, run: Run = begin): Promise<{ posts: number; cents: number } | false> {
	const end = new Date(endMs);
	const start = new Date(endMs - WINDOW_MS);
	return run(async (tx) => {
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
			where a.instance is null and ${followersOf(sql`a`, sql`s`)} >= ${r.min_followers} and a.status = 'active' and not a.shadow_banned and a.deactivated_at is null
				${r.premium_only ? sql`and a.premium_tier is not null` : sql``}
				and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.notice->>'type' is distinct from 'Fosnr'
				and p.created_at < ${end} and p.created_at >= ${end}::timestamptz - make_interval(hours => ${r.max_post_age_hours})`;
		// custom counts raised since they were last credited, on the posts that may earn
		const boosted = await tx`
			with o as (
				select p.id, p.count_overrides c,
					(select count(*) from likes where post_id = p.id)::int as likes, (select count(*) from reposts where post_id = p.id)::int as reposts,
					(select count(*) from posts r where r.reply_to_id = p.id)::int as replies, (select count(*) from posts q where q.quote_id = p.id)::int as quotes,
					(select count(*) from bookmarks where post_id = p.id)::int as bookmarks, (select count(*) from post_views where post_id = p.id)::int as views
				from posts p join users a on a.id = p.user_id left join user_stats s on s.user_id = a.id
				where p.count_overrides is not null and p.count_overrides <> '{}'::jsonb
					and a.instance is null and a.status = 'active' and not a.shadow_banned and a.deactivated_at is null
					and ${followersOf(sql`a`, sql`s`)} >= ${r.min_followers} ${r.premium_only ? sql`and a.premium_tier is not null` : sql``}
					and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.notice->>'type' is distinct from 'Fosnr'
					and p.created_at < ${end} and p.created_at >= ${end}::timestamptz - make_interval(hours => ${r.max_post_age_hours})
			), extra as (
				select o.id, (greatest(coalesce((c->>'likes')::int, likes) - likes, 0) + greatest(coalesce((c->>'reposts')::int, reposts) - reposts, 0)
					+ greatest(coalesce((c->>'replies')::int, replies) - replies, 0) + greatest(coalesce((c->>'quotes')::int, quotes) - quotes, 0)
					+ greatest(coalesce((c->>'bookmarks')::int, bookmarks) - bookmarks, 0)) as eng,
					greatest(coalesce((c->>'views')::int, views) - views, 0) as vw
				from o
			), upd as (
				insert into content_reward_override_seen (post_id, engagements, views) select id, eng, vw from extra
				on conflict (post_id) do update set engagements = greatest(content_reward_override_seen.engagements, excluded.engagements),
					views = greatest(content_reward_override_seen.views, excluded.views)
				returning 1
			)
			select e.id::text, p.user_id::text as author, greatest(e.eng - coalesce(seen.engagements, 0), 0) as engagements, greatest(e.vw - coalesce(seen.views, 0), 0) as views
			from extra e join posts p on p.id = e.id left join content_reward_override_seen seen on seen.post_id = e.id
			where e.eng > coalesce(seen.engagements, 0) or e.vw > coalesce(seen.views, 0)`;
		const all = new Map<string, any>((candidates as any[]).map((c) => [c.id, c]));
		for (const b of boosted as any[]) {
			const c = all.get(b.id);
			if (c) {
				c.engagements += b.engagements;
				c.views += b.views;
			} else all.set(b.id, { id: b.id, author: b.author, engagements: b.engagements, views: b.views });
		}
		const viral = [...all.values()].filter((c) => isViral(c.engagements, c.views, r));
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
			await hold(tx, c.author, cents, r);
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
		sql`select c.window_end, c.post_id::text, c.engagements, c.views, c.cents, p.text, p.reply_to_id is not null as reply
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
