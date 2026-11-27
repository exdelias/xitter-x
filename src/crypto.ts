// Crypto in Equicoins (money.ts): accounts buy and sell cryptocurrencies at
// their real market prices, paying with and selling back into their
// Equicoins balance. Equicoins are play money, so no real coin changes
// hands: the market only sets the price. Prices come from CoinGecko's public
// API, fetched by the server (never the browser) once a minute at most.
//
// A trade needs a price no older than FRESH_MS, and runs in one transaction
// with the wallet row locked, so a balance can't be spent twice. Units are
// kept as numeric to 18 places; the cents a sale pays are rounded down.

import { sql } from "./db";
import { newId } from "./ids";
import { MoneyError, ensureWallet } from "./money";
import { feature, settings } from "./settings";

export const ASSETS = [
	{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", color: "#f7931a" },
	{ id: "ethereum", symbol: "ETH", name: "Ethereum", color: "#627eea" },
	{ id: "solana", symbol: "SOL", name: "Solana", color: "#14f195" },
	{ id: "ripple", symbol: "XRP", name: "XRP", color: "#8a96a3" },
	{ id: "dogecoin", symbol: "DOGE", name: "Dogecoin", color: "#c2a633" },
	{ id: "cardano", symbol: "ADA", name: "Cardano", color: "#2a71d0" },
	{ id: "litecoin", symbol: "LTC", name: "Litecoin", color: "#a6a9aa" },
	{ id: "avalanche-2", symbol: "AVAX", name: "Avalanche", color: "#e84142" },
] as const;
export type Asset = (typeof ASSETS)[number];
export const assetOf = (symbol: string) => ASSETS.find((a) => a.symbol === symbol.toUpperCase());

export type Quote = { price: number; change24h: number; spark: number[]; marketCap: number; volume: number };

const MARKETS_URL = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&sparkline=true&price_change_percentage=24h&ids=${ASSETS.map((a) => a.id).join(",")}`;
const CACHE_MS = 60_000;
// a trade needs a price this recent
const FRESH_MS = 3 * 60_000;
// the smallest trade: one cent
const MIN_CENTS = 1;

let cache: { at: number; quotes: Map<string, Quote> } | null = null;
let inflight: Promise<void> | null = null;

async function refresh() {
	const res = await fetch(MARKETS_URL, { headers: { accept: "application/json", "user-agent": "Xitter" }, signal: AbortSignal.timeout(8_000) });
	if (!res.ok) throw new Error(`CoinGecko answered ${res.status}`);
	const rows = (await res.json()) as any[];
	const quotes = new Map<string, Quote>();
	for (const r of rows) {
		const a = ASSETS.find((x) => x.id === r.id);
		if (!a || typeof r.current_price !== "number" || !(r.current_price > 0)) continue;
		// the 7-day sparkline is hourly: every 4th point is plenty for a small chart
		const spark = Array.isArray(r.sparkline_in_7d?.price) ? (r.sparkline_in_7d.price as number[]).filter((_, i, all) => i % 4 === 0 || i === all.length - 1) : [];
		quotes.set(a.symbol, { price: r.current_price, change24h: Number(r.price_change_percentage_24h ?? 0), spark, marketCap: Number(r.market_cap ?? 0), volume: Number(r.total_volume ?? 0) });
	}
	if (!quotes.size) throw new Error("CoinGecko sent no prices");
	cache = { at: Date.now(), quotes };
}

// the latest prices, fetched when the cache is older than a minute; the old
// ones stay in use while the market can't be reached
export async function quotes(): Promise<{ at: number; quotes: Map<string, Quote> } | null> {
	if (!cache || Date.now() - cache.at > CACHE_MS) {
		inflight ??= refresh()
			.catch((e) => console.error("crypto prices:", e.message))
			.finally(() => (inflight = null));
		await inflight;
	}
	return cache;
}

export const cryptoOn = () => feature("money") && settings().money_crypto.enabled;

async function freshPrice(asset: Asset): Promise<number> {
	const q = await quotes();
	const price = q?.quotes.get(asset.symbol)?.price;
	if (!q || !price || Date.now() - q.at > FRESH_MS) throw new MoneyError("Prices can't be reached right now. Try again in a minute.");
	return price;
}

export async function holdingsOf(userId: string) {
	const rows = await sql`select asset, units::text, cost_cents from money_crypto_holdings where user_id = ${userId}::bigint and units > 0 order by asset`;
	return rows.map((r: any) => ({ symbol: r.asset as string, units: r.units as string, cost: Number(r.cost_cents) }));
}

export async function tradesOf(userId: string, limit = 30) {
	const rows = await sql`select id::text, asset, side, units::text, price::text, cents, created_at from money_crypto_trades
		where user_id = ${userId}::bigint order by id desc limit ${limit}`;
	return rows.map((r: any) => ({ id: r.id as string, symbol: r.asset as string, side: r.side as "buy" | "sell", units: r.units as string, price: Number(r.price), cents: Number(r.cents), at: new Date(r.created_at) }));
}

// spends `cents` of the balance on the asset at the market price
export async function buyCrypto(userId: string, symbol: string, cents: number) {
	const asset = assetOf(symbol);
	if (!asset) throw new MoneyError("Pick a coin.");
	if (!Number.isSafeInteger(cents) || cents < MIN_CENTS) throw new MoneyError("Enter an amount, like 5 or 12.50.");
	const price = await freshPrice(asset);
	await ensureWallet(userId);
	return sql.begin(async (tx) => {
		const [w] = await tx`update money_wallets set balance_cents = balance_cents - ${cents} where user_id = ${userId}::bigint and balance_cents >= ${cents} returning balance_cents`;
		if (!w) throw new MoneyError("You don't have that much.");
		const [h] = await tx`insert into money_crypto_holdings (user_id, asset, units, cost_cents)
			values (${userId}::bigint, ${asset.symbol}, round(${cents}::numeric / 100 / ${String(price)}::numeric, 18), ${cents})
			on conflict (user_id, asset) do update set units = money_crypto_holdings.units + excluded.units, cost_cents = money_crypto_holdings.cost_cents + excluded.cost_cents
			returning (round(${cents}::numeric / 100 / ${String(price)}::numeric, 18))::text as bought`;
		await tx`insert into money_crypto_trades (id, user_id, asset, side, units, price, cents)
			values (${newId()}::bigint, ${userId}::bigint, ${asset.symbol}, 'buy', ${h.bought}::numeric, ${String(price)}::numeric, ${cents})`;
		return { units: h.bought as string, price, cents };
	});
}

// sells the asset for `cents` at the market price, or all of it when `cents` is null
export async function sellCrypto(userId: string, symbol: string, cents: number | null) {
	const asset = assetOf(symbol);
	if (!asset) throw new MoneyError("Pick a coin.");
	if (cents !== null && (!Number.isSafeInteger(cents) || cents < MIN_CENTS)) throw new MoneyError("Enter an amount, like 5 or 12.50.");
	const price = await freshPrice(asset);
	await ensureWallet(userId);
	return sql.begin(async (tx) => {
		const [h] = await tx`select units::text, cost_cents from money_crypto_holdings where user_id = ${userId}::bigint and asset = ${asset.symbol} for update`;
		if (!h || Number(h.units) <= 0) throw new MoneyError(`You have no ${asset.name}.`);
		// what is sold, in units (rounded up, so it pays at least what was asked), and what it pays, in whole cents
		const [s] = await tx`select u::text as units, floor(u * ${String(price)}::numeric * 100)::bigint as cents from (
			select ${cents === null ? sql`${h.units}::numeric` : sql`least(${h.units}::numeric, ceil(${cents}::numeric / 100 / ${String(price)}::numeric * 1e18) / 1e18)`} as u) x`;
		if (cents !== null && Number(s.cents) < cents - 1 && Number(s.units) >= Number(h.units)) throw new MoneyError(`You have ${formatUnits(h.units)} ${asset.symbol}, worth less than that.`);
		const paid = Number(s.cents);
		if (paid < 1) throw new MoneyError("That's less than a cent.");
		// the cost leaves in proportion to the units sold
		await tx`update money_crypto_holdings set cost_cents = case when units - ${s.units}::numeric <= 0 then 0 else round(cost_cents * (1 - ${s.units}::numeric / units))::bigint end,
			units = greatest(units - ${s.units}::numeric, 0) where user_id = ${userId}::bigint and asset = ${asset.symbol}`;
		await tx`update money_wallets set balance_cents = balance_cents + ${paid} where user_id = ${userId}::bigint`;
		await tx`insert into money_crypto_trades (id, user_id, asset, side, units, price, cents)
			values (${newId()}::bigint, ${userId}::bigint, ${asset.symbol}, 'sell', ${s.units}::numeric, ${String(price)}::numeric, ${paid})`;
		return { units: s.units as string, price, cents: paid };
	});
}

// units for people: up to 8 places, no trailing zeros
export function formatUnits(units: string | number) {
	const n = Number(units);
	if (!n) return "0";
	return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 6 : 8 });
}

export function formatPrice(usd: number) {
	return usd.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 6 : 2 });
}

// the market value of holdings, in cents
export function valueOf(holdings: { symbol: string; units: string }[], q: Map<string, Quote> | undefined) {
	let cents = 0;
	for (const h of holdings) {
		const price = q?.get(h.symbol)?.price;
		if (price) cents += Math.floor(Number(h.units) * price * 100);
	}
	return cents;
}
