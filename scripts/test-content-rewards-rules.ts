// Original Content Rewards' rules that need no database: which 15-minute
// windows to pay, when a post counts as viral, and what it earns (content-rewards.ts).
import { expect, test } from "bun:test";
import { WINDOW_MS, isViral, payoutFor, rateFactor, windowEndBefore, windowsToRun } from "../src/content-rewards";
import { settings } from "../src/settings";

const at = (iso: string) => Date.parse(iso);

test("windows end every 3 minutes, UTC", () => {
	expect(WINDOW_MS).toBe(3 * 60_000);
	expect(windowEndBefore(at("2026-11-25T10:14:59.999Z"))).toBe(at("2026-11-25T10:12:00Z"));
	expect(windowEndBefore(at("2026-11-25T10:15:00Z"))).toBe(at("2026-11-25T10:15:00Z"));
	expect(windowEndBefore(at("2026-11-25T23:59:00Z"))).toBe(at("2026-11-25T23:57:00Z"));
});

test("the first run pays only the window that just ended", () => {
	expect(windowsToRun(null, at("2026-11-25T10:15:00Z"))).toEqual([at("2026-11-25T10:15:00Z")]);
});

test("each window is paid once, in order, and a pause is caught up an hour back", () => {
	const latest = at("2026-11-25T10:15:00Z");
	expect(windowsToRun(latest, latest)).toEqual([]);
	expect(windowsToRun(latest - WINDOW_MS, latest)).toEqual([latest]);
	expect(windowsToRun(latest - 2 * WINDOW_MS, latest)).toEqual([latest - WINDOW_MS, latest]);
	// down for a day: the last hour's 20 windows, oldest first
	expect(windowsToRun(latest - 480 * WINDOW_MS, latest)).toEqual([...Array(20).keys()].reverse().map((n) => latest - n * WINDOW_MS));
});

const rules = { ...settings().content_rewards, min_engagements: 20, min_views: 500, cents_per_engagement: 10, cents_per_1000_views: 100, max_post_cents: 5_000, rate_bonus: false };

test("viral takes enough engagements or enough views", () => {
	expect(isViral(19, 499, rules)).toBe(false);
	expect(isViral(20, 0, rules)).toBe(true);
	expect(isViral(0, 500, rules)).toBe(true);
	// a threshold of 0 is off, not "always"
	expect(isViral(0, 0, { ...rules, min_views: 0 })).toBe(false);
	expect(isViral(5, 10_000, { ...rules, min_views: 0 })).toBe(false);
});

test("a payout is per engagement and per 1,000 views, up to the most per post", () => {
	expect(payoutFor(20, 0, rules)).toBe(200);
	expect(payoutFor(20, 1_500, rules)).toBe(350);
	expect(payoutFor(0, 999, rules)).toBe(99);
	expect(payoutFor(1_000, 100_000, rules)).toBe(5_000);
});

test("the engagement rate scales the pay from half to double", () => {
	const r = { ...rules, rate_bonus: true };
	expect(rateFactor(10, 0, r)).toBe(1);
	expect(rateFactor(50, 1_000, r)).toBe(1);
	expect(rateFactor(0, 1_000, r)).toBe(0.5);
	expect(rateFactor(500, 1_000, r)).toBe(2);
	expect(payoutFor(100, 1_000, r)).toBe(1_650);
	expect(payoutFor(20, 2_000, r)).toBe(240);
	expect(rateFactor(50, 1_000, { ...r, rate_bonus: false })).toBe(1);
});
