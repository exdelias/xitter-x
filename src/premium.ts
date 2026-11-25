// Premium: plans an account asks for and staff approve or decline (Admin >
// Premium). Nothing is paid; staff decide who gets a plan and for how long.
// X's own sign-up screen is a checkout on grok.com, so the client's Premium
// links open our page instead (premium-page.ts, tidy.ts).
//
// What a plan gives here: longer posts (the blue limit, Admin > Settings) and
// a boost for its replies in conversations (threads.ts); Premium and Premium+
// also give the blue checkmark. A checkmark that came with a plan goes when
// the plan ends or drops to Basic; a badge staff gave, or an organisation's or
// government's, is never touched. Decisions reach the account as a staff
// message (its Notifications tab and Settings > Notices).

import { sql } from "./db";
import { newId } from "./ids";
import { feature } from "./settings";

export const TIERS = {
	basic: { name: "Basic", checkmark: false, boost: 2, perks: ["Longer posts", "A small boost for your replies"] },
	premium: { name: "Premium", checkmark: true, boost: 5, perks: ["The blue checkmark", "Longer posts", "A larger boost for your replies"] },
	premium_plus: { name: "Premium+", checkmark: true, boost: 10, perks: ["The blue checkmark", "Longer posts", "The largest boost for your replies"] },
} as const;
export type Tier = keyof typeof TIERS;
export const isTier = (t: unknown): t is Tier => typeof t === "string" && Object.hasOwn(TIERS, t);
export const tierName = (t: string | null | undefined) => (isTier(t) ? TIERS[t].name : "");
// how much a reply counts extra in a conversation's order (threads.ts), as likes and replies
export const replyBoost = (t: string | null | undefined) => (isTier(t) ? TIERS[t].boost : 0);

export class PremiumError extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message);
	}
}

type Db = typeof sql;
const NOTE_MAX = 500;
const date = (d: Date) => new Date(d).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
const until = (d: Date | null) => (d ? `until ${date(d)}` : "with no end date");

const message = (db: Db, userId: string, actorId: string | null, body: string) =>
	db`insert into staff_messages (id, user_id, actor_id, kind, body) values (${newId()}::bigint, ${userId}::bigint, ${actorId}::bigint, 'message', ${body})`;

const cleanText = (v: unknown, what: string) => {
	const text = typeof v === "string" ? v.trim() : "";
	if ([...text].length > NOTE_MAX) throw new PremiumError(`${what} can be up to ${NOTE_MAX} characters.`);
	return text || null;
};

export async function planOf(userId: string) {
	const [u] = await sql`select premium_tier as tier, premium_since as since, premium_until as until, premium_checkmark as checkmark from users where id = ${userId}::bigint`;
	return u?.tier ? (u as { tier: Tier; since: Date; until: Date | null; checkmark: boolean }) : null;
}

export async function requestsOf(userId: string, limit = 10) {
	return sql`select id::text, tier, note, status, reason, created_at, reviewed_at from premium_requests where user_id = ${userId}::bigint order by id desc limit ${limit}`;
}

// an account asks for a plan; one waiting request at a time
export async function requestPremium(userId: string, tier: unknown, note: unknown) {
	if (!feature("premium")) throw new PremiumError("Premium isn't offered on this instance.", 403);
	if (!isTier(tier)) throw new PremiumError("Pick a plan.");
	const text = cleanText(note, "A note");
	const [u] = await sql`select status, instance, premium_tier from users where id = ${userId}::bigint`;
	if (!u || u.instance) throw new PremiumError("Only accounts of this instance can ask for Premium here.", 403);
	if (u.status !== "active") throw new PremiumError("Your account can't ask for Premium right now.", 403);
	if (u.premium_tier === tier) throw new PremiumError(`You already have ${TIERS[tier].name}.`);
	const id = newId();
	const rows = await sql`insert into premium_requests (id, user_id, tier, note) values (${id}::bigint, ${userId}::bigint, ${tier}, ${text})
		on conflict (user_id) where status = 'pending' do nothing returning id`;
	if (!rows.length) throw new PremiumError("You already have a request waiting for review. Withdraw it to ask for another plan.");
	return id;
}

export async function withdrawRequest(userId: string) {
	const rows = await sql`update premium_requests set status = 'withdrawn', reviewed_at = now() where user_id = ${userId}::bigint and status = 'pending' returning id`;
	if (!rows.length) throw new PremiumError("You have no request waiting.");
}

// Gives an account a plan (or changes it), in a transaction. The checkmark
// follows the plan only where there was none, or one from the plan or the
// shop (whose days the plan takes over).
async function setPlan(tx: Db, userId: string, tier: Tier, end: Date | null) {
	const [u] = await tx`select verified_type, shop_verified_until, premium_tier, premium_checkmark from users where id = ${userId}::bigint for update`;
	if (!u) throw new PremiumError("No such account.", 404);
	const ours = u.premium_checkmark || u.shop_verified_until !== null || u.verified_type === null;
	if (TIERS[tier].checkmark && ours)
		await tx`update users set verified_type = 'blue', verified_at = case when premium_checkmark and verified_type = 'blue' then verified_at else now() end,
			shop_verified_until = null, premium_checkmark = true where id = ${userId}::bigint`;
	else if (!TIERS[tier].checkmark && u.premium_checkmark)
		await tx`update users set verified_type = null, verified_at = null, premium_checkmark = false where id = ${userId}::bigint`;
	await tx`update users set premium_tier = ${tier}, premium_since = case when premium_tier is null then now() else premium_since end, premium_until = ${end}
		where id = ${userId}::bigint`;
}

async function endPlan(tx: Db, userId: string) {
	await tx`update users set verified_type = case when premium_checkmark and verified_type = 'blue' then null else verified_type end,
		verified_at = case when premium_checkmark and verified_type = 'blue' then null else verified_at end,
		premium_tier = null, premium_since = null, premium_until = null, premium_checkmark = false where id = ${userId}::bigint`;
}

const checkEnd = (end: Date | null) => {
	if (end && (Number.isNaN(end.getTime()) || end.getTime() <= Date.now())) throw new PremiumError("Pick an end date in the future, or none.");
	return end;
};

// staff approve a waiting request: the plan starts now and lasts until `end`
export async function approveRequest(actorId: string, requestId: string, end: Date | null) {
	checkEnd(end);
	return sql.begin(async (tx) => {
		const [r] = await tx`select user_id::text, tier from premium_requests where id = ${requestId}::bigint and status = 'pending' for update`;
		if (!r) throw new PremiumError("That request isn't waiting any more.", 404);
		await setPlan(tx, r.user_id, r.tier, end);
		await tx`update premium_requests set status = 'approved', reviewed_by = ${actorId}::bigint, reviewed_at = now() where id = ${requestId}::bigint`;
		await message(tx, r.user_id, actorId, `Your request for ${TIERS[r.tier as Tier].name} was approved. You have it ${until(end)}.`);
		return r as { user_id: string; tier: Tier };
	});
}

export async function declineRequest(actorId: string, requestId: string, reason: unknown) {
	const why = cleanText(reason, "A reason");
	return sql.begin(async (tx) => {
		const [r] = await tx`update premium_requests set status = 'declined', reason = ${why}, reviewed_by = ${actorId}::bigint, reviewed_at = now()
			where id = ${requestId}::bigint and status = 'pending' returning user_id::text, tier`;
		if (!r) throw new PremiumError("That request isn't waiting any more.", 404);
		await message(tx, r.user_id, actorId, `Your request for ${TIERS[r.tier as Tier].name} was declined.${why ? ` Reason: ${why}` : ""}`);
		return r as { user_id: string; tier: Tier };
	});
}

// staff give or change a plan directly (Admin > Premium); a waiting request
// for the same plan counts as approved
export async function grantPlan(actorId: string, userId: string, tier: unknown, end: Date | null) {
	if (!isTier(tier)) throw new PremiumError("Pick a plan.");
	checkEnd(end);
	await sql.begin(async (tx) => {
		const [u] = await tx`select instance, premium_tier from users where id = ${userId}::bigint`;
		if (!u) throw new PremiumError("No such account.", 404);
		if (u.instance) throw new PremiumError("That account lives on another instance.", 403);
		await setPlan(tx, userId, tier, end);
		await tx`update premium_requests set status = 'approved', reviewed_by = ${actorId}::bigint, reviewed_at = now()
			where user_id = ${userId}::bigint and status = 'pending' and tier = ${tier}`;
		await message(tx, userId, actorId, u.premium_tier
			? `Your plan is now ${TIERS[tier].name}, ${until(end)}.`
			: `You've been given ${TIERS[tier].name}, ${until(end)}.`);
	});
}

// the account cancels its own plan, or staff end it; it ends at once
export async function endPremium(userId: string, actorId: string | null) {
	await sql.begin(async (tx) => {
		const [u] = await tx`select premium_tier from users where id = ${userId}::bigint for update`;
		if (!u?.premium_tier) throw new PremiumError(actorId ? "That account has no plan." : "You have no plan to cancel.");
		await endPlan(tx, userId);
		if (actorId) await message(tx, userId, actorId, `Your ${TIERS[u.premium_tier as Tier].name} plan was ended by staff.`);
	});
}

// plans whose end date has passed; run every minute (server.ts)
export async function expirePremium() {
	const ended = await sql.begin(async (tx) => {
		const rows = await tx`select id::text, premium_tier from users where premium_until is not null and premium_until <= now() for update skip locked`;
		for (const r of rows) {
			await endPlan(tx, r.id);
			await message(tx, r.id, null, `Your ${TIERS[r.premium_tier as Tier]?.name ?? "Premium"} plan has ended.`);
		}
		return rows.length;
	});
	return ended as number;
}

// Admin > Premium: what's waiting and who has a plan
export async function premiumOverview() {
	const [requests, members, decided] = await Promise.all([
		sql`select r.id::text, r.tier, r.note, r.created_at, u.id::text as user_id, u.screen_name, u.name, u.verified_type, u.premium_tier as current_tier
			from premium_requests r join users u on u.id = r.user_id where r.status = 'pending' order by r.id limit 200`,
		sql`select id::text as user_id, screen_name, name, premium_tier as tier, premium_since as since, premium_until as until, premium_checkmark as checkmark, verified_type
			from users where premium_tier is not null order by premium_since desc, id limit 500`,
		sql`select r.id::text, r.tier, r.status, r.reason, r.reviewed_at, u.screen_name, s.screen_name as reviewer
			from premium_requests r join users u on u.id = r.user_id left join users s on s.id = r.reviewed_by
			where r.status in ('approved', 'declined') order by r.reviewed_at desc nulls last, r.id desc limit 50`,
	]);
	return { offered: feature("premium"), requests, members, decided, tiers: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, t.name])) };
}
