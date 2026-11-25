// The account's Premium page (/account/premium; the client shows it at
// /i/xpremium, tidy.ts): its plan, a request waiting for staff, and the plans
// to ask for. Staff decide in Admin > Premium (premium.ts).

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { PremiumError, TIERS, cancelPremium, isTier, keepPremium, planOf, requestPremium, requestsOf, withdrawRequest } from "./premium";
import { feature, settings } from "./settings";

const CSS = `.plans{display:grid;gap:12px;margin:0 0 16px}
.plan{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--border);border-radius:16px;padding:14px;cursor:pointer;color:var(--text)}
.plan:has(input:checked){border-color:var(--text)}
.plan input{width:20px;min-height:20px;height:20px;margin:2px 0 0;padding:0;flex:none;accent-color:var(--accent)}
.plan b{font-size:17px}
.plan ul,.card ul{margin:6px 0 0;padding-left:18px;font-size:15px;line-height:20px}
@media (hover:hover){.plan:hover{background:var(--hover)}}`;

const date = (d: Date) => new Date(d).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
const perks = (tier: keyof typeof TIERS) => `<ul>${TIERS[tier].perks.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`;
const DONE: Record<string, string> = {
	requested: "Your request was sent. Staff will look at it, and you'll get a message in Notifications either way.",
	withdrawn: "Your request was withdrawn.",
	cancelled: "Your plan is cancelled. You keep it until the end of its period.",
	kept: "You're keeping your plan.",
};

async function page(req: Request, viewer: Viewer, error = "") {
	const [plan, requests] = await Promise.all([planOf(viewer.id), requestsOf(viewer.id, 5)]);
	const pending = requests.find((r: any) => r.status === "pending");
	const last = requests[0];
	const done = DONE[new URL(req.url).searchParams.get("done") ?? ""];
	const offered = feature("premium");
	const csrf = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const parts: string[] = [`<h1>Premium</h1>`];
	parts.push(`<p class="dim">On ${esc(settings().instance_name)}, Premium isn't paid for: you ask for a plan and staff decide.</p>`);
	if (error) parts.push(`<p class="error" role="alert">${esc(error)}</p>`);
	if (done) parts.push(`<div class="card success" role="status"><p>${esc(done)}</p></div>`);
	if (plan) {
		const name = esc(TIERS[plan.tier].name);
		const checkmark = plan.checkmark ? ", and so does the checkmark that came with it" : "";
		const term = plan.cancel_at
			? `Since ${date(plan.since)}. Cancelled: it ends on ${date(plan.cancel_at)}`
			: `Since ${date(plan.since)}, ${plan.until ? `until ${date(plan.until)}` : "month to month with no end date"}`;
		const action = plan.cancel_at
			? `<form method="post" action="/account/premium" style="margin-top:12px">${csrf}<input type="hidden" name="action" value="keep"><button type="submit" class="small">Keep ${name}</button></form>`
			: `<details style="margin-top:12px"><summary>Cancel ${name}</summary>
<p class="dim">You keep it until ${date(plan.period_end)}, the end of ${plan.until ? "your plan" : "its current month"}. Then it ends${checkmark}. Until then you can keep it after all.</p>
<form method="post" action="/account/premium">${csrf}<input type="hidden" name="action" value="cancel"><button type="submit" class="danger small">Cancel ${name}</button></form></details>`;
		parts.push(`<div class="card ${plan.cancel_at ? "warning" : "success"}"><p><b>You have ${name}</b><br><span class="dim">${term}</span></p>${perks(plan.tier)}${action}</div>`);
	}
	if (pending)
		parts.push(`<div class="card"><p><b>Your request for ${esc(TIERS[pending.tier as keyof typeof TIERS].name)} is waiting for review</b><br><span class="dim">Sent ${date(pending.created_at)}</span></p>
<form method="post" action="/account/premium">${csrf}<input type="hidden" name="action" value="withdraw"><button type="submit" class="secondary small">Withdraw request</button></form></div>`);
	else if (last?.status === "declined")
		parts.push(`<div class="card warning"><p><b>Your request for ${esc(TIERS[last.tier as keyof typeof TIERS].name)} was declined</b><br><span class="dim">${date(last.reviewed_at)}</span>${last.reason ? `<br>${esc(last.reason)}` : ""}</p></div>`);
	if (!offered) parts.push(`<p>Premium isn't offered on this instance right now.</p>`);
	else if (!pending) {
		const choices = (Object.keys(TIERS) as (keyof typeof TIERS)[]).filter((t) => t !== plan?.tier);
		parts.push(`<h2>${plan ? "Switch plans" : "Plans"}</h2>
<form method="post" action="/account/premium">${csrf}<input type="hidden" name="action" value="request">
<div class="plans" role="radiogroup" aria-label="Plans">${choices.map((t, i) => `<label class="plan"><input type="radio" name="tier" value="${t}"${i === (choices.length > 1 ? 1 : 0) ? " checked" : ""}><span><b>${esc(TIERS[t].name)}</b>${perks(t)}</span></label>`).join("")}</div>
<label for="note">A note for staff (optional)</label>
<textarea id="note" name="note" maxlength="500" rows="3" placeholder="Why you'd like it"></textarea>
<button type="submit">Ask for ${plan ? "this plan" : "Premium"}</button>
</form>`);
	}
	return accountPage({ req, viewer, title: "Premium", css: CSS, status: error ? 400 : 200, body: parts.join("\n"), back: { href: "/home", label: "Back to Home" } });
}

export async function premiumRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer);
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, "That form is out of date. Try again.");
	const action = String(form?.get("action") ?? "");
	try {
		if (action === "request") {
			const tier = String(form?.get("tier") ?? "");
			await requestPremium(viewer.id, isTier(tier) ? tier : "", form?.get("note"));
		} else if (action === "withdraw") await withdrawRequest(viewer.id);
		else if (action === "cancel") await cancelPremium(viewer.id);
		else if (action === "keep") await keepPremium(viewer.id);
		else return page(req, viewer, "Unknown action.");
	} catch (e) {
		if (e instanceof PremiumError) return page(req, viewer, e.message);
		throw e;
	}
	const done = ({ request: "requested", withdraw: "withdrawn", cancel: "cancelled", keep: "kept" } as Record<string, string>)[action];
	return new Response(null, { status: 303, headers: { location: `/account/premium?done=${done}` } });
}
