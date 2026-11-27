// The Crypto pages of Equicoins (crypto.ts): the markets and the account's
// coins at /account/money/crypto, and one coin's page with its chart, buy and
// sell at /account/money/crypto/<symbol>. money-page.ts wraps them in the page.

import { esc } from "./account-page";
import { ASSETS, type Asset, type Quote, assetOf, formatPrice, formatUnits, holdingsOf, quotes, tradesOf, valueOf } from "./crypto";
import { date, formatCents } from "./money";

export const CRYPTO_CSS = `
.coin{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;font-weight:800;font-size:11px;letter-spacing:-.2px;color:#fff;flex:none}
.mkt{display:grid;grid-template-columns:40px minmax(0,1fr) 84px auto;align-items:center;gap:0 12px;padding:12px 16px;color:var(--text);text-decoration:none}
a.mkt:hover{text-decoration:none}
@media (hover:hover){a.mkt:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}}
.mkt .nm{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mkt .sym{color:var(--muted);font-size:14px}
.mkt .px{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.mkt .ch{text-align:right;font-size:14px;font-variant-numeric:tabular-nums}
.up{color:var(--success)}.down{color:var(--danger)}
.spark{width:84px;height:32px;display:block}
.chart{width:100%;height:160px;display:block}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 16px 16px}
.stat{padding:12px 14px;border:1px solid var(--border);border-radius:16px}
.stat .k{color:var(--muted);font-size:13px}
.stat .v{font-weight:700;font-size:17px;font-variant-numeric:tabular-nums;margin-top:2px}
.trade{display:grid;gap:12px;padding:16px;border-top:1px solid var(--border)}
.tabs2{position:relative;width:100%;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;border-radius:9999px;background:var(--surface,color-mix(in srgb,var(--text) 6%,transparent))}
.tabs2 input{position:absolute;left:0;top:0;width:1px;height:1px;min-height:0;opacity:0;pointer-events:none}
.tabs2 label{display:grid;place-items:center;min-height:36px;margin:0;border-radius:9999px;font-weight:700;color:var(--muted);cursor:pointer}
.tabs2 input:checked+label{background:var(--bg);color:var(--text);box-shadow:0 1px 3px rgb(0 0 0 / .2)}
.tabs2 input:focus-visible+label{outline:2px solid var(--accent)}
.amt-in{display:flex;align-items:center;gap:6px;padding:0 16px;min-height:56px;border:1px solid var(--outline);border-radius:12px;font-size:24px;font-weight:800}
.amt-in input{all:unset;flex:1;min-width:0;font-variant-numeric:tabular-nums}
.amt-in:focus-within{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.row2{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--muted);font-size:14px}
.row2 label{margin:0;display:flex;gap:8px;align-items:center;color:var(--text)}
.src{color:var(--muted);font-size:13px;padding:12px 16px 24px;text-align:center}
`;

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const tone = (n: number) => (n >= 0 ? "up" : "down");
const coin = (a: Asset) => `<span class="coin" style="background:${a.color}" aria-hidden="true">${esc(a.symbol.slice(0, 4))}</span>`;

// a line through the prices, scaled to the box; green when it ended higher
function line(points: number[], w: number, h: number, cls: string, label: string) {
	if (points.length < 2) return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" role="img" aria-label="No chart"></svg>`;
	const lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
	const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)} ${(h - 2 - ((p - lo) / span) * (h - 4)).toFixed(1)}`).join("");
	const color = points[points.length - 1] >= points[0] ? "var(--success)" : "var(--danger)";
	return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

const unavailable = `<div class="notice error" role="alert">Market prices can't be reached right now, so buying and selling are paused. Try again in a minute.</div>`;
export const CRYPTO_NOTE = "Prices are real market prices from CoinGecko. You trade with Equicoins, which are play money: no real cryptocurrency is bought or sold, and nothing here has cash value.";

// the account's coins, valued at the market, and what they cost
export async function cryptoSummary(userId: string) {
	const [q, holdings] = await Promise.all([quotes(), holdingsOf(userId)]);
	const value = valueOf(holdings, q?.quotes);
	const cost = holdings.reduce((s, h) => s + h.cost, 0);
	return { q, holdings, value, cost };
}

export async function cryptoHome(userId: string, balance: number) {
	const { q, holdings, value, cost } = await cryptoSummary(userId);
	const gain = value - cost;
	const mine = holdings
		.map((h) => {
			const a = assetOf(h.symbol);
			if (!a) return "";
			const p = q?.quotes.get(a.symbol);
			const v = p ? Math.floor(Number(h.units) * p.price * 100) : 0;
			const g = v - h.cost;
			return `<a class="mkt" href="/account/money/crypto/${a.symbol}">${coin(a)}<div style="min-width:0"><div class="nm">${esc(a.name)}</div><div class="sym">${formatUnits(h.units)} ${a.symbol}</div></div><span></span>
<div><div class="px">${p ? formatCents(v) : "—"}</div><div class="ch ${tone(g)}">${p ? `${g >= 0 ? "+" : "−"}${formatCents(Math.abs(g))}` : ""}</div></div></a>`;
		})
		.join("\n");
	const markets = ASSETS.map((a) => {
		const p = q?.quotes.get(a.symbol);
		return `<a class="mkt" href="/account/money/crypto/${a.symbol}">${coin(a)}<div style="min-width:0"><div class="nm">${esc(a.name)}</div><div class="sym">${a.symbol}</div></div>
${p ? line(p.spark, 84, 32, "spark", `${a.name}, last 7 days`) : "<span></span>"}<div><div class="px">${p ? formatPrice(p.price) : "—"}</div><div class="ch ${p ? tone(p.change24h) : ""}">${p ? pct(p.change24h) : ""}</div></div></a>`;
	}).join("\n");
	return `<section class="hero" aria-label="Crypto"><div class="label">Your crypto</div><div class="amount">${formatCents(value)}</div>
${holdings.length ? `<p class="dim ${tone(gain)}" style="margin:0">${gain >= 0 ? "+" : "−"}${formatCents(Math.abs(gain))}${cost ? ` (${pct((gain / cost) * 100)})` : ""} all time</p>` : ""}
<p class="dim" style="margin:6px 0 0">${formatCents(balance)} available to buy with</p></section>
${q ? "" : unavailable}
${holdings.length ? `<div class="month">Your coins</div>${mine}` : ""}
<div class="month">Markets</div>
${markets}
<p class="src">${esc(CRYPTO_NOTE)}${q ? ` Updated ${new Date(q.at).toISOString().slice(11, 16)} UTC.` : ""}</p>`;
}

const compact = (n: number) => (n ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 })}` : "—");

export async function cryptoAsset(userId: string, a: Asset, balance: number, form: { side?: string; amount?: string } = {}) {
	const [q, holdings, trades] = await Promise.all([quotes(), holdingsOf(userId), tradesOf(userId, 100)]);
	const p: Quote | undefined = q?.quotes.get(a.symbol);
	const h = holdings.find((x) => x.symbol === a.symbol);
	const worth = h && p ? Math.floor(Number(h.units) * p.price * 100) : 0;
	const side = form.side === "sell" ? "sell" : "buy";
	const mine = trades.filter((t) => t.symbol === a.symbol).slice(0, 20);
	return `<section class="hero" aria-label="${esc(a.name)}"><div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">${coin(a)}<div><b>${esc(a.name)}</b> <span class="dim">${a.symbol}</span></div></div>
<div class="amount">${p ? formatPrice(p.price) : "—"}</div>${p ? `<p class="${tone(p.change24h)}" style="margin:0;font-weight:700">${pct(p.change24h)} <span class="dim" style="font-weight:400">past 24 hours</span></p>` : ""}</section>
${p ? `<div style="padding:12px 16px 4px">${line(p.spark, 600, 160, "chart", `${a.name} price, last 7 days`)}<div class="row2"><span>7 days ago</span><span>Now</span></div></div>` : unavailable}
<div class="stats" style="margin-top:12px">
<div class="stat"><div class="k">You hold</div><div class="v">${h ? formatUnits(h.units) : "0"} ${a.symbol}</div></div>
<div class="stat"><div class="k">Worth</div><div class="v">${formatCents(worth)}</div></div>
<div class="stat"><div class="k">Market cap</div><div class="v">${p ? compact(p.marketCap) : "—"}</div></div>
<div class="stat"><div class="k">Volume, 24 hours</div><div class="v">${p ? compact(p.volume) : "—"}</div></div>
</div>
<form method="post" class="trade" action="/account/money/crypto/${a.symbol}">
<div class="tabs2" role="radiogroup" aria-label="Buy or sell"><input type="radio" id="tb" name="side" value="buy"${side === "buy" ? " checked" : ""}><label for="tb">Buy</label><input type="radio" id="ts" name="side" value="sell"${side === "sell" ? " checked" : ""}${h ? "" : " disabled"}><label for="ts">Sell</label></div>
<label class="amt-in" for="ta"><span class="dim">$</span><input id="ta" name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(form.amount ?? "")}" aria-label="Amount in dollars"></label>
<div class="row2"><span>${formatCents(balance)} available</span>${h ? `<label><input type="checkbox" name="all" value="1"> Sell all</label>` : ""}</div>
<button type="submit" class="pill primary wide"${p ? "" : " disabled"}>Confirm</button>
<p class="fine" style="margin:0">Trades go through at the market price the moment you confirm.</p>
</form>
${mine.length ? `<div class="month">Your trades</div>${mine.map((t) => `<div class="tx">${coin(a)}<div><div class="who"><span>${t.side === "buy" ? "Bought" : "Sold"} ${formatUnits(t.units)} ${a.symbol}</span></div><div class="sub">at ${formatPrice(t.price)} · ${date(t.at)}</div></div><div class="amt${t.side === "sell" ? " in" : ""}">${t.side === "buy" ? "−" : "+"}${formatCents(t.cents)}</div></div>`).join("\n")}` : ""}
<p class="src">${esc(CRYPTO_NOTE)}</p>`;
}
