// Premium's rules that need no database: post limits by plan and badge, and
// the reply boost in a conversation's order (premium.ts, textlen.ts, threads.ts).
import { expect, test } from "bun:test";
import { TIERS, isTier, replyBoost, tierName } from "../src/premium";
import { settings } from "../src/settings";
import { postLimitFor } from "../src/textlen";
import { conversationThreads } from "../src/threads";

test("every plan gives at least the blue post limit, and never lowers a badge's", () => {
	const l = settings().post_limits;
	expect(postLimitFor(null)).toBe(l.none);
	for (const tier of Object.keys(TIERS)) {
		expect(postLimitFor(null, tier)).toBe(l.blue);
		expect(postLimitFor("blue", tier)).toBe(l.blue);
		expect(postLimitFor("business", tier)).toBe(l.business);
		expect(postLimitFor("government", tier)).toBe(l.government);
	}
});

test("plans are known by key, and the boost grows with the plan", () => {
	expect(isTier("premium_plus")).toBe(true);
	expect(isTier("toString")).toBe(false);
	expect(isTier("gold")).toBe(false);
	expect(tierName("premium_plus")).toBe("Premium+");
	expect(tierName(null)).toBe("");
	expect(replyBoost(null)).toBe(0);
	expect(replyBoost("basic")).toBeLessThan(replyBoost("premium"));
	expect(replyBoost("premium")).toBeLessThan(replyBoost("premium_plus"));
	expect(TIERS.basic.checkmark).toBe(false);
	expect(TIERS.premium.checkmark && TIERS.premium_plus.checkmark).toBe(true);
});

const post = (id: string, author: string, likes: number, tier: string | null = null, replyTo = "1") =>
	({ id, reply_to_id: replyTo, like_count: likes, reply_count: 0, author: { id: author, premium_tier: tier } }) as any;

test("a Premium reply moves up past a few likes, not past many", () => {
	const focal = post("1", "op", 0, null, null as any);
	const order = (below: any[]) => conversationThreads(focal, below, null).roots.map((p: any) => p.id);
	// 3 likes against 1 like and Premium (boost 5): Premium first
	expect(order([post("10", "a", 3), post("11", "b", 1, "premium")])).toEqual(["11", "10"]);
	// 50 likes stay ahead of any plan's boost
	expect(order([post("10", "a", 50), post("11", "b", 1, "premium_plus")])).toEqual(["10", "11"]);
	// without plans, likes alone decide, as before
	expect(order([post("10", "a", 1), post("11", "b", 3)])).toEqual(["11", "10"]);
});
