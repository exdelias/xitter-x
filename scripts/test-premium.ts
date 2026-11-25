// End-to-end check of Premium (premium.ts, premium-page.ts, premium-admin.ts)
// against a running server: asking for a plan, staff approving and declining,
// what a plan gives and takes back, badges it must leave alone, expiry, and
// who may do what. Needs an admin, two plain accounts and a gold organisation,
// all with the same password; puts everything back and leaves Premium on.
// usage: bun scripts/test-premium.ts <admin> <user A> <user B> <organisation> <password>

import { sql } from "../src/db";
import { expirePremium } from "../src/premium";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, nameA, nameB, orgName, password] = process.argv.slice(2);
if (!adminName || !nameA || !nameB || !orgName || !password) throw new Error("usage: bun scripts/test-premium.ts <admin> <user A> <user B> <organisation> <password>");

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
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	// the Premium page's forms
	const form = async (fields: Record<string, string>, token = csrf) => {
		const res = await fetch(`${origin}/account/premium`, { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams({ csrf: token, ...fields }), redirect: "manual" });
		return { status: res.status, location: res.headers.get("location"), text: await res.text() };
	};
	const page = async () => (await fetch(`${origin}/account/premium`, { headers: { cookie: headers.cookie } })).text();
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	return { admin, form, page, gql, headers };
}

const boss = await session(adminName);
const a = await session(nameA);
const b = await session(nameB);
const idOf = async (name: string) => (await sql`select id::text from users where lower(screen_name) = lower(${name})`)[0].id as string;
const [idA, idB, idOrg] = await Promise.all([idOf(nameA), idOf(nameB), idOf(orgName)]);
const userRow = async (id: string) => (await sql`select verified_type, premium_tier, premium_since, premium_until, premium_checkmark, premium_cancel_at, shop_verified_until from users where id = ${id}::bigint`)[0];
const lastMessage = async (id: string) => (await sql`select body from staff_messages where user_id = ${id}::bigint order by id desc limit 1`)[0]?.body as string | undefined;
const waiting = async () => (await boss.admin("premium")).requests as any[];

// a clean start: no plans or requests for the test accounts, plain badges
const reset = async () => {
	await sql`delete from premium_requests where user_id in (${idA}::bigint, ${idB}::bigint, ${idOrg}::bigint)`;
	await sql`update users set premium_tier = null, premium_since = null, premium_until = null, premium_checkmark = false, premium_cancel_at = null where id in (${idA}::bigint, ${idB}::bigint, ${idOrg}::bigint)`;
	await sql`update users set verified_type = null, verified_at = null, shop_verified_until = null where id in (${idA}::bigint, ${idB}::bigint)`;
};
await reset();
const [org] = await sql`select verified_type from users where id = ${idOrg}::bigint`;

// switched off: nobody can ask
await boss.admin("saveSettings", { features: { premium: false } });
check((await a.page()).includes("isn't offered"), "with Premium off, the page says it isn't offered");
const off = await a.form({ action: "request", tier: "premium" });
check(off.status === 400 && off.text.includes("isn't offered"), "and a request is refused", off.status);
await boss.admin("saveSettings", { features: { premium: true } });

// asking, once at a time, and withdrawing
const sent = await a.form({ action: "request", tier: "premium", note: "I write long posts" });
check(sent.status === 303 && sent.location === "/account/premium?done=requested", "A asks for Premium", sent.status);
check((await a.page()).includes("is waiting for review"), "the page shows the request waiting");
const req1 = (await waiting()).find((r) => r.user_id === idA);
check(req1?.tier === "premium" && req1.note === "I write long posts", "staff see it with its note", req1);
check((await a.form({ action: "request", tier: "basic" })).text.includes("already have a request"), "a second request waits for the first");
check((await a.form({ action: "request", tier: "gold" })).status === 400, "an unknown plan is refused");
check((await a.form({ action: "request", tier: "basic", note: "x".repeat(501) })).status === 400, "and so is a note over 500 characters");
check((await a.form({ action: "request", tier: "basic" }, "wrong")).text.includes("out of date"), "a form without the right token does nothing");
check((await a.form({ action: "withdraw" })).status === 303 && !(await waiting()).some((r) => r.user_id === idA), "A withdraws it, and it leaves the staff list");

// declined, with a reason the account sees
await a.form({ action: "request", tier: "premium_plus" });
const req2 = (await waiting()).find((r) => r.user_id === idA);
check((await a.admin("premium")).status === 403 && (await a.admin("decidePremium", { id: req2.id, approve: true })).status === 403, "an account without staff powers can't see or decide requests");
check((await boss.admin("decidePremium", { id: req2.id, approve: false, reason: "Not this month" })).status === 200, "staff decline it with a reason");
check((await lastMessage(idA))?.includes("declined") && (await lastMessage(idA))?.includes("Not this month"), "A gets a message with the reason", await lastMessage(idA));
check((await a.page()).includes("was declined") && (await a.page()).includes("Not this month"), "and the page shows it");
check((await boss.admin("decidePremium", { id: req2.id, approve: true })).status === 404, "a decided request can't be decided again");
check((await userRow(idA)).premium_tier === null, "A has no plan");

// approved: the plan, its checkmark and longer posts
await a.form({ action: "request", tier: "premium" });
const req3 = (await waiting()).find((r) => r.user_id === idA);
check((await boss.admin("decidePremium", { id: req3.id, approve: true, until: new Date(Date.now() - 60_000).toISOString() })).status === 400, "an end date in the past is refused");
const end = new Date(Date.now() + 30 * 86_400_000);
check((await boss.admin("decidePremium", { id: req3.id, approve: true, until: end.toISOString() })).status === 200, "staff approve it for 30 days");
let row = await userRow(idA);
check(row.premium_tier === "premium" && Math.abs(new Date(row.premium_until).getTime() - end.getTime()) < 2000, "A has Premium until then", row);
check(row.verified_type === "blue" && row.premium_checkmark, "with the blue checkmark, from the plan");
check((await lastMessage(idA))?.includes("approved"), "and a message saying so");
const profile = (await b.gql("UserByScreenName", { screen_name: nameA }))?.data?.user?.result;
check(profile?.is_blue_verified === true, "others see the checkmark");
const long = "word ".repeat(1100).trim();
const made = await a.gql("CreateNoteTweet", { tweet_text: long });
const longId = made?.data?.notetweet_create?.tweet_results?.result?.rest_id;
check(!!longId, "A can post 5,500 characters now", made?.errors?.[0]?.message);
const home = await (await fetch(`${origin}/home`, { headers: { cookie: a.headers.cookie } })).text();
check(/"longform_notetweets_max_weighted_character_length":\{"value":25000\}/.test(home), "and the composer knows the longer limit");
const audit = (await boss.admin("audit", { action: "premium_approve" })).entries ?? [];
check(audit.some((e: any) => JSON.stringify(e).includes(req3.id)), "the approval is in the audit log");

// changed to Basic: the checkmark goes, longer posts stay
check((await boss.admin("setPremium", { user: `@${nameA}`, tier: "basic", until: "" })).status === 200, "staff change A to Basic with no end");
row = await userRow(idA);
check(row.premium_tier === "basic" && row.premium_until === null && row.verified_type === null && !row.premium_checkmark, "the checkmark that came with Premium goes", row);
const again = await a.gql("CreateNoteTweet", { tweet_text: long });
check(!!again?.data?.notetweet_create?.tweet_results?.result?.rest_id, "Basic still allows long posts");
const plain = await b.gql("CreateNoteTweet", { tweet_text: long });
check(!!plain?.errors?.length, "an account without a plan still can't", plain?.data);

// cancelled by the account: it runs to the end of its period
const DAY = 86_400_000;
const monthsLater = (d: Date, n: number) => {
	const x = new Date(d);
	x.setUTCMonth(x.getUTCMonth() + n);
	return x.getTime();
};
check((await a.form({ action: "cancel" })).status === 303, "A cancels Basic");
row = await userRow(idA);
check(row.premium_tier === "basic" && row.verified_type === null, "A still has Basic after cancelling", row.premium_tier);
check(new Date(row.premium_cancel_at).getTime() === monthsLater(row.premium_since, 1), "it ends a month after it started, the end of its first period", { since: row.premium_since, ends: row.premium_cancel_at });
check((await a.page()).includes("Cancelled: it ends on"), "the page says when it ends");
check((await a.form({ action: "cancel" })).text.includes("already cancelled"), "cancelling twice says it's already cancelled");
check(!!(await a.gql("CreateNoteTweet", { tweet_text: long }))?.data?.notetweet_create, "until then, long posts still work");
check((await a.form({ action: "keep" })).status === 303 && (await userRow(idA)).premium_cancel_at === null, "A keeps the plan after all");
check((await a.form({ action: "keep" })).text.includes("isn't cancelled"), "keeping a plan that isn't cancelled says so");
// 40 days in, the current period is the second month
await sql`update users set premium_since = now() - interval '40 days' where id = ${idA}::bigint`;
await a.form({ action: "cancel" });
row = await userRow(idA);
const ends = new Date(row.premium_cancel_at).getTime();
check(ends === monthsLater(row.premium_since, 2) && ends > Date.now() && ends - Date.now() < 31 * DAY, "40 days in, it ends at the end of the second month", row.premium_cancel_at);
check(!(await expirePremium()) || (await userRow(idA)).premium_tier === "basic", "nothing ends before the period is over");
// a plan with an end date runs to it
await boss.admin("setPremium", { user: nameA, tier: "premium", until: new Date(Date.now() + 10 * DAY).toISOString() });
row = await userRow(idA);
check(row.premium_cancel_at === null && row.premium_tier === "premium", "staff changing the plan undoes the cancellation");
await a.form({ action: "cancel" });
row = await userRow(idA);
check(new Date(row.premium_cancel_at).getTime() === new Date(row.premium_until).getTime() && row.verified_type === "blue", "a plan with an end date, cancelled, runs to that date, checkmark and all");
const listed = (await boss.admin("premium")).members.find((m: any) => m.user_id === idA);
check(!!listed?.cancel_at, "staff see that it's cancelled");
// the period is over
await sql`update users set premium_cancel_at = now() - interval '1 second' where id = ${idA}::bigint`;
await expirePremium();
row = await userRow(idA);
check(row.premium_tier === null && row.verified_type === null && row.premium_cancel_at === null, "when the period is over, the plan and its checkmark end", row);
check((await lastMessage(idA))?.includes("has ended"), "and A is told");
check((await a.form({ action: "cancel" })).text.includes("no plan"), "with no plan, there's nothing to cancel");

// a badge staff gave stays when the plan ends
await boss.admin("setBadge", { id: idB, badge: "blue" });
await boss.admin("setPremium", { user: nameB, tier: "premium_plus", until: "" });
row = await userRow(idB);
check(row.premium_tier === "premium_plus" && !row.premium_checkmark, "B's staff checkmark isn't counted as the plan's", row);
check((await boss.admin("endPremium", { id: idB })).status === 200 && (await userRow(idB)).verified_type === "blue", "ending B's plan leaves the staff checkmark");
check((await lastMessage(idB))?.includes("ended by staff"), "B is told");
await boss.admin("setBadge", { id: idB, badge: "" });

// an organisation keeps its gold badge
await boss.admin("setPremium", { user: orgName, tier: "premium", until: "" });
check((await userRow(idOrg)).verified_type === org.verified_type, "an organisation's badge stays under a plan", (await userRow(idOrg)).verified_type);
await boss.admin("endPremium", { id: idOrg });
check((await userRow(idOrg)).verified_type === org.verified_type, "and after it");

// a shop checkmark: the plan takes it over, and it goes with the plan
await sql`update users set verified_type = 'blue', verified_at = now(), shop_verified_until = now() + interval '3 days' where id = ${idB}::bigint`;
await boss.admin("setPremium", { user: nameB, tier: "premium", until: "" });
row = await userRow(idB);
check(row.premium_checkmark && row.shop_verified_until === null, "a plan takes over a shop checkmark", row);
await boss.admin("endPremium", { id: idB });
check((await userRow(idB)).verified_type === null, "which goes when the plan ends");

// an approval for a plan staff gave directly, and expiry
await b.form({ action: "request", tier: "premium" });
await boss.admin("setPremium", { user: nameB, tier: "premium", until: new Date(Date.now() + 86_400_000).toISOString() });
check(!(await waiting()).some((r) => r.user_id === idB), "giving the plan an account asked for approves its request");
await sql`update users set premium_until = now() - interval '1 second' where id = ${idB}::bigint`;
check((await expirePremium()) >= 1, "an ended plan is picked up");
row = await userRow(idB);
check(row.premium_tier === null && row.verified_type === null, "and comes off with its checkmark", row);
check((await lastMessage(idB))?.includes("has ended"), "B is told it ended");

// staff below admin need the permission
await sql`update users set role = 'moderator' where id = ${idB}::bigint`;
const mod = await session(nameB);
check((await mod.admin("premium")).status === 403, "a moderator can't open Premium without the permission");
await sql`update users set role = null where id = ${idB}::bigint`;

// the page opens inside the client
const doc = await fetch(`${origin}/account/premium`, { headers: { cookie: a.headers.cookie, "sec-fetch-dest": "document" }, redirect: "manual" });
check(doc.status === 302 && doc.headers.get("location") === "/i/xpremium", "opened on its own, the page goes to /i/xpremium in the client", doc.headers.get("location"));

for (const id of [longId, again?.data?.notetweet_create?.tweet_results?.result?.rest_id]) if (id) await a.gql("DeleteTweet", { tweet_id: id });
await reset();
await sql.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
