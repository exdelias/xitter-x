// Admin > Premium (admin.html): requests to approve or decline, and the
// plans accounts hold, which staff give, change and end (premium.ts). Every
// change is in the audit log.

import { AdminError, type Action, audit, guard, idOf } from "./admin";
import { sql } from "./db";
import { PremiumError, approveRequest, declineRequest, endPremium, grantPlan, premiumOverview } from "./premium";

// an end date from the panel: an ISO time, or nothing for no end
function endOf(v: unknown): Date | null {
	if (v === undefined || v === null || v === "") return null;
	const d = typeof v === "string" || typeof v === "number" ? new Date(v) : new Date(NaN);
	if (Number.isNaN(d.getTime())) throw new AdminError("Pick an end date, or none.");
	return d;
}

const premiumErrors = async <T>(run: () => Promise<T>) => {
	try {
		return await run();
	} catch (e) {
		if (e instanceof PremiumError) throw new AdminError(e.message, e.status);
		throw e;
	}
};

// an account by id, or by @handle typed in the panel
async function accountOf(v: unknown) {
	const raw = typeof v === "string" ? v.trim().replace(/^@/, "") : "";
	if (!raw) throw new AdminError("Name an account.");
	const [u] = /^\d{1,19}$/.test(raw)
		? await sql`select id::text, screen_name from users where id = ${raw}::bigint`
		: await sql`select id::text, screen_name from users where lower(screen_name) = lower(${raw})`;
	if (!u) throw new AdminError("No such account.", 404);
	return u as { id: string; screen_name: string };
}

export const premiumActions: Record<string, Action> = {
	premium: { role: "admin", run: async () => premiumOverview() },
	// approve: true with `until` (none for no end), or false with an optional reason
	decidePremium: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [r] = await sql`select user_id::text, tier from premium_requests where id = ${id}::bigint and status = 'pending'`;
			if (!r) throw new AdminError("That request isn't waiting any more.", 404);
			await guard(a, r.user_id);
			if (b.approve === true) {
				const until = endOf(b.until);
				await premiumErrors(() => approveRequest(a.id, id, until));
				await audit(a, "premium_approve", r.user_id, { request: id, tier: r.tier, until: until?.toISOString() ?? null });
			} else if (b.approve === false) {
				await premiumErrors(() => declineRequest(a.id, id, b.reason));
				await audit(a, "premium_decline", r.user_id, { request: id, tier: r.tier, reason: typeof b.reason === "string" ? b.reason.trim() || null : null });
			} else throw new AdminError("Approve or decline.");
			return {};
		},
	},
	// give an account a plan, or change its plan or end date
	setPremium: {
		role: "admin",
		run: async (a, b) => {
			const u = await accountOf(b.user);
			await guard(a, u.id, true);
			const until = endOf(b.until);
			await premiumErrors(() => grantPlan(a.id, u.id, b.tier, until));
			await audit(a, "premium_set", u.id, { tier: b.tier, until: until?.toISOString() ?? null });
			return {};
		},
	},
	endPremium: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id, true);
			await premiumErrors(() => endPremium(id, a.id));
			await audit(a, "premium_end", id);
			return {};
		},
	},
};
