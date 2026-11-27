// Equicoins pages (money.ts): the balance and activity at /account/money,
// opened from the side bar (tidy.ts); sending, requesting, a payment's and a
// request's own page under it; and merchant mode at /account/merchant, in
// Settings.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { peers } from "./federation";
import { BADGE_TYPES, absolute } from "./media";
import { CARD_CSS } from "./money-ui";
import {
	MoneyError,
	type Party,
	badges,
	acceptDisclaimer,
	balanceOf,
	closeRequest,
	disclaimerAccepted,
	disclaimerText,
	date,
	economy,
	face,
	formatCents,
	merchantOf,
	parseAmount,
	parties,
	paymentCard,
	paymentUrl,
	payments,
	requestCard,
	requestMoney,
	requestUrl,
	requests,
	sendMoney,
	setMerchant,
	shortCents,
	NOTE_MAX,
} from "./money";
import { hit } from "./ratelimit";
import { feature, settings } from "./settings";
import { MONEY_ICON } from "./tidy";
import { buyShopItem, myShopOrders, shopItems, shopView, ShopError } from "./money-shop";
import { RewardsError, payOutRewards, rewardsOf } from "./content-rewards";
import { assetOf, buyCrypto, cryptoOn, sellCrypto } from "./crypto";
import { CRYPTO_CSS, cryptoAsset, cryptoHome, cryptoSummary } from "./money-crypto-page";

const CSS = `
main{padding:0;gap:0}
.hero{padding:24px 16px 20px;display:grid;justify-items:start;gap:2px;border-bottom:1px solid var(--border)}
.tile{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#000;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .12);margin-bottom:14px}
.tile svg{width:28px;height:28px;fill:#fff}
.hero .label{color:var(--muted)}
.hero .amount{font-size:52px;line-height:60px;font-weight:800;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
.actions{display:flex;gap:10px;margin-top:16px}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 24px;border-radius:9999px;font-weight:700;font-size:15px;text-decoration:none;border:1px solid var(--outline);color:var(--text);background:transparent;cursor:pointer}
.pill.primary{background:var(--text);color:var(--bg);border-color:var(--text)}
.pill.small{min-height:32px;padding:0 16px;font-size:14px}
.pill.wide{width:100%;min-height:52px;font-size:17px}
.pill svg{width:18px;height:18px;fill:currentColor}
@media (hover:hover){.pill:hover,button.pill:hover:not(:disabled){background:var(--hover);text-decoration:none}.pill.primary:hover,button.pill.primary:hover:not(:disabled){background:var(--text);opacity:.88}}
.notice{margin:12px 16px 0;padding:12px 16px;border-radius:12px;background:rgb(0 186 124 / .12);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.notice.error{background:rgb(244 33 46 / .12)}
.month{padding:20px 16px 8px;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.3px;text-transform:uppercase}
.tx{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:0 12px;padding:10px 16px;color:var(--text);text-decoration:none}
a.tx:hover{text-decoration:none}
@media (hover:hover){a.tx:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}}
.tx>img,.tx .icon{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--border)}
.tx>img.xm-sq{border-radius:8px}
.tx .icon{display:grid;place-items:center;background:rgb(249 24 128 / .12);color:rgb(249 24 128)}
.tx .icon svg{width:20px;height:20px;fill:currentColor}
.tx .icon.reward{background:rgb(29 155 240 / .12);color:rgb(29 155 240)}
.rules{margin:0;padding:8px 16px 16px 36px;display:grid;gap:6px;color:var(--text)}
.tx .who{display:flex;gap:4px;align-items:center;min-width:0;font-weight:700;white-space:nowrap}
.tx .who span{overflow:hidden;text-overflow:ellipsis}
.tx .sub{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx .amt{font-weight:700;font-variant-numeric:tabular-nums}
.tx .amt.in{color:var(--success)}
.tx .end{display:flex;gap:8px;align-items:center}
.tx form{display:contents}
.empty{color:var(--muted);text-align:center;padding:48px 16px}
.send{padding:8px 16px 24px;display:grid;gap:16px;justify-items:stretch}
.picks{display:flex;gap:16px;overflow-x:auto;padding:4px 2px;scrollbar-width:none}
.pick{flex:none;width:60px;display:grid;justify-items:center;gap:6px;border:0;background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer;padding:0;min-height:0}
.pick>img{width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--border);outline:2px solid transparent;outline-offset:2px;transition:outline-color .15s}
.pick>img.xm-sq{border-radius:10px}
/* buttons, not the page's blue pills: no fill on hover or press */
.pick:hover:not(:disabled),.pick:active:not(:disabled){background:none;scale:none}
.pick:focus-visible{outline:0}
@media (hover:hover){.pick:hover>img{outline-color:var(--outline)}.pick:hover{color:var(--text)}}
.pick:focus-visible>img{outline-color:var(--accent)}
.pick[aria-pressed="true"]{color:var(--text)}
.pick[aria-pressed="true"]>img{outline-color:var(--text)}
.pick span{max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.big{display:flex;justify-content:center;align-items:flex-start;padding:28px 0 20px}
.big span{font-size:36px;line-height:48px;font-weight:800;color:var(--muted)}
.big input{all:unset;width:1.2ch;min-width:1.2ch;font-size:72px;line-height:80px;font-weight:800;letter-spacing:-2px;font-variant-numeric:tabular-nums;caret-color:var(--accent)}
.big input::placeholder{color:var(--muted)}
.big input[readonly]{caret-color:transparent}
.balance{text-align:center;color:var(--muted);font-size:14px;margin-top:-12px}
.paying{display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--border);border-radius:16px}
.paying>img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.paying>img.xm-sq{border-radius:8px}
.paying .who{display:flex;gap:4px;align-items:center;font-weight:700}
.field{position:relative;display:grid}
.field input{padding-top:22px;padding-bottom:6px;min-height:56px}
.field label{position:absolute;left:13px;top:7px;margin:0;font-size:13px;color:var(--muted);pointer-events:none}
.field:focus-within label{color:var(--accent)}
/* the To and From fields' list of accounts, as X's typeahead */
.people{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:5;max-height:320px;overflow-y:auto;background:var(--bg);border-radius:8px;box-shadow:0 0 15px rgb(255 255 255 / .2),0 0 3px 1px rgb(255 255 255 / .15)}
:root[data-theme="light"] .people,:root:not([data-theme]) .people{box-shadow:0 0 15px rgb(101 119 134 / .2),0 0 3px 1px rgb(101 119 134 / .15)}
.people[hidden]{display:none}
.person{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer}
.person[aria-selected="true"]{background:var(--surface)}
.person>img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none;background:var(--border)}
.person>img.xm-sq{border-radius:8px}
.person .name{display:flex;align-items:center;gap:2px;font-weight:700;min-width:0}
.person .name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.person .handle{color:var(--muted);font-size:15px}
.people .none{padding:16px;color:var(--muted)}
.check{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--text);font-size:15px;margin:0}
.check small{display:block;color:var(--muted);font-size:13px}
.check input{appearance:none;width:40px;height:24px;min-height:0;padding:0;border:0;border-radius:9999px;background:var(--field);position:relative;cursor:pointer;transition:background .15s;flex:none}
.check input::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:translate .15s}
.check input:checked{background:var(--accent)}
.check input:checked::after{translate:16px 0}
.fine{color:var(--muted);font-size:13px;text-align:center}
.receipt{padding:16px;display:grid;gap:16px}
dl{margin:0;padding:16px;display:grid;grid-template-columns:auto 1fr;gap:14px 16px;border-top:1px solid var(--border)}
dt{color:var(--muted)}
dd{margin:0;text-align:right;overflow-wrap:anywhere;display:flex;justify-content:flex-end;align-items:center;gap:4px}
.settings{padding:16px;display:grid;gap:16px}
.settings h2{margin:8px 0 0}
.shop-hero .amount{font-size:36px;line-height:44px;letter-spacing:-1px}
.shop-hero .dim{margin:8px 0 0}
.shop-page{display:grid;gap:12px;padding:16px 16px 32px}
.shop-page h2{margin:0;font-size:20px}
.shop-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.shop-item{display:grid;grid-template-rows:1fr auto;gap:12px;min-width:0;padding:12px;border:1px solid var(--border);border-radius:16px}
.shop-item h3{margin:0;font-size:15px;line-height:20px;overflow-wrap:anywhere}
.shop-item-description{margin:2px 0 0;color:var(--muted);font-size:14px;line-height:18px;overflow-wrap:anywhere}
.shop-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin-top:8px}
.shop-price{font-weight:700;font-variant-numeric:tabular-nums}
.shop-kind{color:var(--muted);font-size:13px}
.shop-badge-preview{display:block;width:40px;height:40px;object-fit:contain;margin:0 0 8px}
.shop-remote{color:var(--muted);font-size:13px;line-height:17px}
.shop-form{display:grid;gap:8px;align-content:end}
.shop-form label{margin:0;color:var(--muted);font-size:13px}
.shop-hint{color:var(--muted);font-size:12px;line-height:16px}
.shop-form input:not([type=file]),.shop-form textarea{width:100%;min-width:0}
.shop-form textarea{min-height:88px}
.shop-form .pill{width:100%;padding:0 12px}
.shop-upload input[type=file]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.shop-upload label{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border:1px solid var(--field);border-radius:4px;color:var(--text);font-weight:700;cursor:pointer}
.shop-upload input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.shop-upload label>span:first-child{flex:none}
.shop-upload-name{min-width:0;overflow:hidden;color:var(--muted);font-size:14px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.shop-history{display:grid;margin-top:12px}
.order{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 0;border-bottom:1px solid var(--border)}
.order-name{font-weight:700;overflow-wrap:anywhere}
.order-status{color:var(--muted);font-size:13px}
.order-status.approved{color:var(--success)}
.order-price{grid-row:1/3;grid-column:2;font-weight:700;font-variant-numeric:tabular-nums}
@media(max-width:560px){.shop-grid{grid-template-columns:1fr}}
.preview{display:grid;gap:12px}
.xm-badge{width:18px;height:18px;flex:none}
.xm-card{margin:0;--xm-bg:var(--bg);--xm-fg:var(--text)}
/* the wallet: the balance, four actions, and cards (as X Money lays it out) */
.wallet{padding:28px 16px 8px}
.wallet .label{color:var(--muted);font-size:15px}
.wallet .total{font-size:56px;line-height:64px;font-weight:800;letter-spacing:-2px;font-variant-numeric:tabular-nums;margin:2px 0}
.wallet .total sup{font-size:26px;letter-spacing:-.5px;vertical-align:28px;margin-left:2px}
.wallet .split{color:var(--muted);font-size:14px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-start}
.qa{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:20px 16px 8px}
.qa a{display:grid;justify-items:center;gap:8px;padding:14px 4px 12px;border-radius:16px;background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text);font-weight:700;font-size:14px;text-decoration:none}
@media (hover:hover){.qa a:hover{background:color-mix(in srgb,var(--text) 10%,transparent);text-decoration:none}}
.qa svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:8px 16px 12px}
.wcard{display:grid;align-content:start;gap:6px;padding:14px;border-radius:16px;background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text);text-decoration:none;min-width:0}
a.wcard:hover{text-decoration:none}
@media (hover:hover){a.wcard:hover{background:color-mix(in srgb,var(--text) 10%,transparent)}}
.wcard h2{margin:0 0 4px;font-size:15px;font-weight:700}
.wcard .kv{display:flex;justify-content:space-between;gap:8px;font-size:14px}
.wcard .kv span:first-child{color:var(--muted)}
.wcard .kv b{font-variant-numeric:tabular-nums;white-space:nowrap}
.wcard .in{color:var(--success)}
.wcard .out{color:var(--danger)}
.more-links{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 8px}
@media(max-width:420px){.qa{gap:6px}.qa a{font-size:12px}.wallet .total{font-size:44px;line-height:52px}.wallet .total sup{font-size:20px;vertical-align:20px}}
/* Original Content Rewards: the total, then payouts (X's Creator Rewards) */
.rw-total{display:grid;justify-items:center;gap:6px;padding:36px 16px 28px;text-align:center}
.rw-total .amount{font-size:52px;line-height:60px;font-weight:800;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
.rw-total .label{color:var(--muted);font-size:17px}
.rw-h{margin:0;padding:16px 16px 4px;font-size:20px;font-weight:800}
.rw-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:0 16px;padding:12px 16px;color:var(--text);text-decoration:none}
a.rw-row:hover{text-decoration:none}
@media (hover:hover){a.rw-row:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}}
.rw-row svg{width:26px;height:26px;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.rw-row .t{font-weight:700;font-size:17px;font-variant-numeric:tabular-nums}
.rw-row .s{color:var(--muted);font-size:15px}
.rw-row .r{color:var(--muted);font-size:13px;text-align:right}
.rw-cal{stroke:rgb(29 155 240)}
.rw-bag{stroke:var(--success)}
.progress{height:8px;border-radius:9999px;background:color-mix(in srgb,var(--text) 10%,transparent);overflow:hidden;margin-top:8px}
.progress>span{display:block;height:100%;background:var(--accent);border-radius:inherit}
.rw-elig{margin:0 16px 8px;padding:14px 16px;border-radius:16px;background:color-mix(in srgb,var(--text) 6%,transparent)}
.rw-elig.ok{background:rgb(0 186 124 / .12)}
details.how{margin:8px 16px 24px;border:1px solid var(--border);border-radius:16px;padding:4px 16px}
details.how summary{cursor:pointer;font-weight:700;padding:12px 0}
details.how ul{margin:0 0 12px;padding-left:20px;display:grid;gap:8px}
${CRYPTO_CSS}
${CARD_CSS}`;

// links on the page that open the client's composer with a payment or request
// in it (money-ui.ts takes it from there); cards go to their page; picking a
// person fills the To field; the amount field grows as it's typed in
const SCRIPT = `[].forEach.call(document.querySelectorAll("time[data-local]"),function(t){var d=new Date(t.getAttribute("datetime"));if(!isNaN(d))t.textContent=d.toLocaleString(undefined,t.getAttribute("data-local")==="date"?{month:"short",day:"numeric",year:"numeric"}:{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})});
document.addEventListener("click",function(e){
	var b=e.target.closest("[data-compose]");
	if(b){e.preventDefault();var t=b.getAttribute("data-compose");try{parent.__xitterCompose(t)}catch(x){sessionStorage.setItem("xitter-compose",t);top.location.href="/compose/post"}return}
	var g=e.target.closest("[data-xm-go]");
	if(g){e.preventDefault();var to=g.getAttribute("data-xm-go");if(to.indexOf("/account/")===0)location.href=to;else try{parent.__xitterGo(to)}catch(x){top.location.href=to}}
});
document.querySelectorAll(".shop-file-input").forEach(function(input){input.addEventListener("change",function(){var name=input.nextElementSibling&&input.nextElementSibling.querySelector("[data-file-name]");var n=input.files?input.files.length:0;if(name)name.textContent=n>1?n+" images":n?input.files[0].name:"No image chosen"})});
document.querySelectorAll(".pick").forEach(function(p){p.addEventListener("click",function(){var to=document.getElementById("to");to.value="@"+p.dataset.handle;document.querySelectorAll(".pick").forEach(function(q){q.setAttribute("aria-pressed",q===p?"true":"false")});document.getElementById("amount").focus()})});
var amt=document.getElementById("amount");if(amt){var fit=function(){amt.style.width=Math.max(1,amt.value.length)*0.62+0.4+"em"};amt.addEventListener("input",fit);fit();if(!amt.value)amt.focus()}
var auto=document.querySelector("[data-compose][data-auto]");if(auto)auto.click();
document.querySelectorAll("input[data-people]").forEach(function(input){
	var box=document.createElement("div");
	box.className="people";box.id="people";box.setAttribute("role","listbox");box.hidden=true;
	input.parentNode.appendChild(box);
	var items=[],at=-1,timer=null,asked="";
	function show(open){box.hidden=!open;input.setAttribute("aria-expanded",open?"true":"false")}
	function mark(i){at=i;[].forEach.call(box.children,function(c,j){c.setAttribute("aria-selected",j===i?"true":"false");if(j===i)c.scrollIntoView({block:"nearest"})})}
	function pick(p){
		input.value="@"+p.screen_name;show(false);
		document.querySelectorAll(".pick").forEach(function(q){q.setAttribute("aria-pressed",q.dataset.handle.toLowerCase()===p.screen_name.toLowerCase()?"true":"false")});
		var next=document.getElementById("amount");
		if(!next||next.value)next=document.getElementById("note");
		if(next)next.focus();
	}
	function draw(list){
		items=list;box.innerHTML="";at=-1;
		if(!list.length){var n=document.createElement("div");n.className="none";n.textContent="No accounts match";box.appendChild(n);show(true);return}
		list.forEach(function(p,i){
			var row=document.createElement("div");
			row.className="person";row.setAttribute("role","option");row.setAttribute("aria-selected","false");
			var img=document.createElement("img");img.src=p.avatar;img.alt="";if(p.square)img.className="xm-sq";row.appendChild(img);
			var text=document.createElement("div");text.style.minWidth="0";
			var name=document.createElement("div");name.className="name";
			var nm=document.createElement("span");nm.textContent=p.name;name.appendChild(nm);
			name.insertAdjacentHTML("beforeend",p.badges);
			var handle=document.createElement("div");handle.className="handle";handle.textContent="@"+p.screen_name;
			text.appendChild(name);text.appendChild(handle);row.appendChild(text);
			row.addEventListener("mousedown",function(e){e.preventDefault();pick(p)});
			row.addEventListener("mousemove",function(){if(at!==i)mark(i)});
			box.appendChild(row);
		});
		show(true);mark(0);
	}
	function look(){
		var q=input.value.trim().replace(/^@/,"");
		if(!q){show(false);return}
		if(q===asked&&items.length){show(true);return}
		asked=q;
		fetch("/account/money/people?q="+encodeURIComponent(q)+(input.hasAttribute("data-local")?"&local=1":""),{credentials:"same-origin"}).then(function(r){return r.ok?r.json():[]}).then(function(list){
			if(asked===q&&document.activeElement===input)draw(list);
		},function(){});
	}
	input.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(look,120)});
	input.addEventListener("focus",function(){if(input.value.trim())look()});
	input.addEventListener("blur",function(){setTimeout(function(){show(false)},100)});
	input.addEventListener("keydown",function(e){
		if(box.hidden||!items.length)return;
		if(e.key==="ArrowDown"){e.preventDefault();mark((at+1)%items.length)}
		else if(e.key==="ArrowUp"){e.preventDefault();mark((at-1+items.length)%items.length)}
		else if(e.key==="Enter"&&at>=0){e.preventDefault();pick(items[at])}
		else if(e.key==="Tab"&&at>=0){pick(items[at])}
		else if(e.key==="Escape"){show(false)}
	});
});`;
const POST_ICON = "M23 3c-6.62-.1-10.38 2.421-13.05 6.03C7.29 12.61 6 17.331 6 22h2c0-1.007.07-2.012.19-3H12c4.1 0 7.48-3.082 7.94-7.054C22.79 10.147 23.17 6.359 23 3zm-7 8h-1.5v2H16c.63-.016 1.2-.08 1.72-.188C16.95 15.24 14.68 17 12 17H8.55c.57-2.512 1.57-4.851 3-6.78 2.16-2.912 5.29-4.911 9.45-5.187C20.95 8.079 19.9 11 16 11zM4 9V6H1V4h3V1h2v3h3v2H6v3H4z";
const HEART = "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z";
const tile = `<span class="tile" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${MONEY_ICON}"/></svg></span>`;
const HOME = { href: "/account/money", label: "Back to Equicoins" };
const page = (req: Request, viewer: Viewer, title: string, body: string, status = 200, back = HOME) =>
	accountPage({ req, viewer, status, title, back, css: CSS, head: `<script>addEventListener("DOMContentLoaded",function(){${SCRIPT}})</script>`, body });
const who = (p: Party) => `<span class="who"><span>${esc(p.merchant?.name ?? p.name)}</span>${badges(p)}</span>`;
const postButton = (url: string, label = "Post", auto = false) =>
	`<button type="button" class="pill primary" data-compose="${esc(url)}"${auto ? " data-auto" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${POST_ICON}"/></svg>${label}</button>`;

// a lightning bolt: Original Content Rewards (content-rewards.ts)
const BOLT = "M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.5L13.5 2z";

// what came and went, newest first: payments, each day's earnings from likes,
// and what viral posts earned
async function activity(userId: string, screenName: string) {
	const [rows, likes, rewards] = await Promise.all([
		sql`select id::text from money_transfers where sender_id = ${userId}::bigint or recipient_id = ${userId}::bigint order by id desc limit 60`,
		sql`select date_trunc('day', created_at) as day, max(created_at) as at, count(*)::int as likes, sum(cents)::bigint as cents
			from money_like_rewards where author_id = ${userId}::bigint group by 1 order by 1 desc limit 30`,
		sql`select cents, automatic, created_at from content_reward_payouts where user_id = ${userId}::bigint order by created_at desc limit 30`,
	]);
	const found = await payments(rows.map((r: any) => r.id));
	const items: { at: Date; html: string }[] = [];
	for (const r of rows) {
		const t = found.get(r.id);
		if (!t) continue;
		const sent = t.sender.id === userId;
		const other = sent ? t.recipient : t.sender;
		const what = t.reversed ? "Reversed" : t.status === "pending" ? "Sending…" : t.status === "failed" ? "Transfer failed · refunded" : sent ? (other.merchant ? "Purchase" : "Sent") : "Received";
		items.push({
			at: t.at,
			html: `<a class="tx" href="/account/money/p/${t.id}">${face(other)}<div>${who(other)}<div class="sub">${t.reversed ? "Reversed" : t.note ? esc(t.note) : what} · ${date(t.at)}</div></div>
<div class="amt${sent || t.reversed ? "" : " in"}"${t.reversed ? ' style="text-decoration:line-through;color:var(--muted)"' : ""}>${sent ? "−" : "+"}${shortCents(t.amount)}</div></a>`,
		});
	}
	for (const l of likes)
		items.push({
			at: new Date(l.at),
			html: `<div class="tx"><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${HEART}"/></svg></span><div><div class="who"><span>Likes on your posts</span></div>
<div class="sub">${l.likes} like${l.likes === 1 ? "" : "s"} · ${date(l.day)}</div></div><div class="amt in">+${shortCents(Number(l.cents))}</div></div>`,
		});
	for (const r of rewards)
		items.push({
			at: new Date(r.created_at),
			html: `<a class="tx" href="/account/money/rewards"><span class="icon reward" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${BOLT}"/></svg></span><div><div class="who"><span>Original Content Rewards payout</span></div>
<div class="sub">${r.automatic ? "Automatic" : "Paid out"} · ${date(r.created_at)}</div></div><div class="amt in">+${shortCents(Number(r.cents))}</div></a>`,
		});
	return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// Original Content Rewards: the total paid, whether the account earns (and
// how far it is from the followers it needs), the next payout and each one
// since, as X's Creator Rewards page shows them
const CALENDAR = `<svg class="rw-cal" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;
const BAG = `<svg class="rw-bag" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5h6l-2 3.5h-2L9 3.5zM11 7c-4 1.5-7 5.5-7 9.5 0 2.5 2 4 4.5 4h7c2.5 0 4.5-1.5 4.5-4 0-4-3-8-7-9.5"/><path d="M14 11.5c-.4-.6-1.1-1-2-1-1.2 0-2 .7-2 1.5 0 2 4 1 4 3 0 .8-.8 1.5-2 1.5-.9 0-1.6-.4-2-1M12 9.5v1M12 16.5v1"/></svg>`;
const isoTime = (d: Date | number, kind = "time") => `<time data-local="${kind}" datetime="${new Date(d).toISOString()}">${esc(new Date(d).toISOString().slice(0, 16).replace("T", " "))} UTC</time>`;

async function rewardsPage(req: Request, viewer: Viewer, status = 200, notice = "", error = "") {
	const r = await rewardsOf(viewer.id);
	const money = (c: number) => (c < 100 ? `${c}¢` : formatCents(c));
	const rules = r.rules;
	const why: Record<string, string> = {
		off: "The program isn't running on this instance right now.",
		remote: "Only accounts of this instance earn here.",
		standing: "Your account can't earn right now.",
		followers: `You need ${rules.min_followers.toLocaleString("en-US")} followers to earn. You have ${r.followers.toLocaleString("en-US")}.`,
		premium: `It's for accounts with Premium. <a href="/i/xpremium">Get Premium</a>.`,
	};
	const share = rules.min_followers ? Math.min(100, Math.round((r.followers / rules.min_followers) * 100)) : 100;
	const elig = r.eligible
		? ""
		: `<div class="rw-elig" role="status"><b>Not earning yet.</b> ${why[r.why ?? "off"]}${r.why === "followers" ? `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share}" aria-label="Followers toward the minimum"><span style="width:${share}%"></span></div>` : ""}</div>`;
	const cap = rules.payout_cap_cents;
	const full = Math.min(100, Math.round((r.pending / cap) * 100));
	const due = r.capReachedAt ? new Date(new Date(r.capReachedAt).getTime() + rules.payout_hours * 3_600_000) : null;
	const ready = `<div class="rw-elig${r.pending ? " ok" : ""}"><div class="row2"><span style="color:var(--text)"><b>${formatCents(r.pending)}</b> ready to pay out</span><span>of ${formatCents(cap)}</span></div>
<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${full}" aria-label="Earnings held toward the most"><span style="width:${full}%"></span></div>
${viewer.actor ? "" : `<form method="post" action="/account/money/rewards" style="margin-top:12px"><input type="hidden" name="action" value="payout"><button type="submit" class="pill primary wide"${r.pending ? "" : " disabled"}>Pay out now</button></form>`}</div>`;
	const nextText = due ? `Paying out by itself by ${isoTime(due)}` : `When you pay out, or by itself once you reach ${formatCents(cap)}`;
	const payouts = r.payoutList
		.map((x: any) => `<div class="rw-row">${BAG}<div><div class="t">${formatCents(Number(x.cents))}</div><div class="s">${isoTime(x.created_at, "date")}</div></div><div class="r">${x.automatic ? "Automatic" : "You paid out"}</div></div>`)
		.join("\n");
	const n = (v: number) => Number(v).toLocaleString("en-US");
	const earnings = r.recent
		.map((x: any) => {
			const rate = x.views ? `${((x.engagements / x.views) * 100).toFixed(1)}% engagement` : "";
			const inner = `<span class="icon reward" aria-hidden="true" style="width:28px;height:28px;display:grid;place-items:center"><svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:rgb(29 155 240);stroke:none"><path d="${BOLT}"/></svg></span><div><div class="t">+${formatCents(x.cents)}</div><div class="s">${isoTime(x.window_end)}</div></div>
<div class="r">+${x.engagements.toLocaleString("en-US")} engagements · +${x.views.toLocaleString("en-US")} views${rate ? `<br>${rate}` : ""}${x.likes != null ? `<br>${n(x.likes)} likes · ${n(x.reposts)} reposts · ${n(x.replies)} replies<br>${n(x.quotes)} quotes · ${n(x.bookmarks)} bookmarks · ${n(x.total_views)} views` : ""}</div>`;
			return x.post_id ? `<a class="rw-row" href="/${esc(viewer.screen_name)}/status/${x.post_id}">${inner}</a>` : `<div class="rw-row">${inner}</div>`;
		})
		.join("\n");
	const viral = [rules.min_engagements > 0 ? `${rules.min_engagements} engagements` : "", rules.min_views > 0 ? `${rules.min_views.toLocaleString("en-US")} views` : ""].filter(Boolean).join(" or ");
	const body = `<section class="rw-total" aria-label="Total earnings"><div class="amount">${formatCents(r.total)}</div><div class="label">Total earnings</div>
<div class="dim">${formatCents(r.paidOut)} paid out${r.day ? ` · ${formatCents(r.day)} in the last 24 hours` : ""}</div></section>
${notice ? `<div class="notice" role="status" style="margin:0 16px 8px">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert" style="margin:0 16px 8px">${esc(error)}</div>` : ""}
${elig}
${ready}
<h2 class="rw-h">Payouts</h2>
<div class="rw-row">${CALENDAR}<div><div class="t">Next payout</div><div class="s">${nextText}</div></div><div class="r"></div></div>
${payouts}
<h2 class="rw-h">Earnings</h2>
${earnings || `<p class="empty">Nothing earned yet.</p>`}
<details class="how"><summary>How it works</summary><ul>
<li>Every 3 minutes, posts and replies of yours from the last ${rules.max_post_age_hours} hours that drew ${viral || "enough attention"} in those 3 minutes have gone viral, and earn. Earnings update every 3 minutes.</li>
<li>The more people engage, the more you earn: ${money(rules.cents_per_engagement)} for each new like, repost, reply, quote or bookmark, and ${money(rules.cents_per_1000_views)} for each 1,000 new views. A post counts what it shows, and each gain earns once.</li>
${rules.rate_bonus ? `<li>Your engagement rate (engagements per view) scales the payout: around 5% pays as above, lower pays down to half, higher up to double.</li>` : ""}
<li>Earnings wait here until you pay them out into your Equicoins balance, whenever you like. You can hold up to ${formatCents(cap)}: reaching it pays everything out by itself within ${rules.payout_hours} hours.</li>
<li>You need ${rules.min_followers.toLocaleString("en-US")} followers${rules.premium_only ? " and Premium" : ""} to take part.</li>
<li>No limits: every new engagement and view is paid in full. Only what's new earns, so a post earns again only when its counts rise. Hidden or limited posts don't count.</li>
</ul></details>`;
	return page(req, viewer, "Original Content Rewards", body, status);
}

// requests still waiting: of the viewer (pay or decline), and the viewer's own
async function waiting(userId: string) {
	const rows = await sql`select id::text from money_requests where status = 'open'
		and (payer_id = ${userId}::bigint or (requester_id = ${userId}::bigint and payer_id is not null)) order by id desc limit 40`;
	const found = await requests(rows.map((r: any) => r.id));
	return rows
		.map((r: any) => found.get(r.id))
		.filter((q: any) => !!q)
		.map((q: any) => {
			const mine = q.requester.id === userId;
			const other: Party = mine ? q.payer : q.requester;
			const actions = mine
				? `<form method="post" action="/account/money/r/${q.id}"><input type="hidden" name="action" value="cancel"><button type="submit" class="pill small">Cancel</button></form>`
				: `<form method="post" action="/account/money/r/${q.id}"><input type="hidden" name="action" value="decline"><button type="submit" class="pill small">Decline</button></form><a class="pill small primary" href="/account/money/send?request=${q.id}">Pay</a>`;
			return `<div class="tx">${face(other)}<a href="/account/money/r/${q.id}" style="color:inherit;min-width:0">${who(other)}<div class="sub">${mine ? "You asked for" : "Asks for"} ${shortCents(q.amount)}${q.note ? ` · ${esc(q.note)}` : ""}</div></a><div class="end">${actions}</div></div>`;
		});
}

// line icons for the wallet's actions
const QA_ICON = {
	send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7z"/></svg>',
	request: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v13M6 11l6 6 6-6M5 20h14"/></svg>',
	crypto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 7.5h4a2 2 0 0 1 0 4h-4m0 0h4.5a2 2 0 0 1 0 4H9.5v-8m1.5-1.5v1.5m0 8V17m2-10.5V7.5m0 8V17"/></svg>',
	rewards: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
	shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2"/></svg>',
};

// what the account earned, from likes and Original Content Rewards, in all and this month
async function earnings(userId: string) {
	const [e] = await sql`select
		(select coalesce(sum(cents), 0) from money_like_rewards where author_id = ${userId}::bigint)::bigint
			+ (select coalesce(sum(cents), 0) from content_rewards where author_id = ${userId}::bigint)::bigint as total,
		(select coalesce(sum(cents), 0) from money_like_rewards where author_id = ${userId}::bigint and created_at >= date_trunc('month', now()))::bigint
			+ (select coalesce(sum(cents), 0) from content_rewards where author_id = ${userId}::bigint and created_at >= date_trunc('month', now()))::bigint as month`;
	return { total: Number(e.total), month: Number(e.month) };
}

async function home(req: Request, viewer: Viewer, status = 200, notice = "", error = "") {
	const crypto = cryptoOn();
	const [balance, items, asks, earned, coins] = await Promise.all([
		balanceOf(viewer.id),
		activity(viewer.id, viewer.screen_name),
		waiting(viewer.id),
		earnings(viewer.id),
		crypto ? cryptoSummary(viewer.id) : null,
	]);
	let month = "";
	const list = items.length
		? items
				.map((i) => {
					const m = i.at.toLocaleDateString("en-US", { month: "long", year: "numeric" });
					const head = m !== month ? `<div class="month">${m}</div>` : "";
					month = m;
					return head + i.html;
				})
				.join("\n")
		: `<p class="empty">No activity yet.<br>Equicoins you send, receive and earn shows up here.</p>`;
	const likes = economy().like_cents;
	const s = settings();
	const total = balance + (coins?.value ?? 0);
	const [whole, cents] = formatCents(total).split(".");
	const gain = coins ? coins.value - coins.cost : 0;
	const four = crypto && s.content_rewards.enabled;
	const actions = viewer.actor
		? `<p class="dim" style="padding:0 16px">Only @${esc(viewer.screen_name)} can send money from this account.</p>`
		: `<nav class="qa" aria-label="Actions"><a href="/account/money/send">${QA_ICON.send}Send</a><a href="/account/money/request">${QA_ICON.request}Request</a>${crypto ? `<a href="/account/money/crypto">${QA_ICON.crypto}Crypto</a>` : ""}${s.content_rewards.enabled ? `<a href="/account/money/rewards">${QA_ICON.rewards}Rewards</a>` : ""}${s.money_shop.enabled && !four ? `<a href="/account/money/shop">${QA_ICON.shop}Shop</a>` : ""}</nav>
${s.money_shop.enabled && four ? `<div class="more-links"><a class="pill small" href="/account/money/shop">Shop</a></div>` : ""}`;
	const latest = items.slice(0, 2).map((i) => i.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
	const second = coins
		? `<a class="wcard" href="/account/money/crypto"><h2>Crypto</h2><div class="kv"><span>Holdings</span><b>${formatCents(coins.value)}</b></div><div class="kv"><span>All time</span><b class="${gain >= 0 ? "in" : "out"}">${gain >= 0 ? "+" : "−"}${formatCents(Math.abs(gain))}</b></div></a>`
		: `<div class="wcard"><h2>Activity</h2>${latest.length ? latest.map((l) => `<div class="kv"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l}</span></div>`).join("") : `<div class="kv"><span>Nothing yet</span></div>`}</div>`;
	return page(
		req,
		viewer,
		"Equicoins",
		`<section class="wallet" aria-label="Balance"><div class="label">Total balance</div><div class="total">${whole}<sup>.${cents ?? "00"}</sup></div>
<div class="split"><span>Cash ${formatCents(balance)}</span>${coins ? `<span aria-hidden="true">·</span><span>Crypto ${formatCents(coins.value)}</span>` : ""}</div></section>
${actions}
<div class="cards">
<a class="wcard" href="${s.content_rewards.enabled ? "/account/money/rewards" : "/account/money"}"><h2>Earnings</h2><div class="kv"><span>Lifetime</span><b>${formatCents(earned.total)}</b></div><div class="kv"><span>This month</span><b class="in">+${formatCents(earned.month)}</b></div></a>
${second}
</div>
${likes > 0 ? `<p class="dim" style="padding:0 16px;margin:0 0 4px;font-size:14px">You earn ${likes < 100 ? `${likes}¢` : formatCents(likes)} for each like on your posts.</p>` : ""}
${notice ? `<div class="notice" role="status">${notice}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
${asks.length ? `<section aria-label="Requests"><div class="month">Requests</div>${asks.join("\n")}</section>` : ""}
<section aria-label="Activity">${list}</section>
`,
		status,
		{ href: "/home", label: "Back to home" },
	);
}

// people to pay in one tap: the latest the viewer paid or was paid by, then accounts they follow
async function quickPicks(userId: string) {
	const rows = await sql`select p.o::text as id from (
			select o, max(at) as at from (
				select case when sender_id = ${userId}::bigint then recipient_id else sender_id end as o, created_at as at from money_transfers
				where sender_id = ${userId}::bigint or recipient_id = ${userId}::bigint
				union all select followee_id, created_at - interval '100 years' from follows where follower_id = ${userId}::bigint
			) x group by o order by at desc limit 8
		) p join users u on u.id = p.o
		where u.instance is null and u.status <> 'suspended' and u.deactivated_at is null
			and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = ${userId}::bigint) or (b.blocker_id = ${userId}::bigint and b.blocked_id = u.id))
		order by p.at desc`;
	const found = await parties(rows.map((r: any) => r.id));
	return rows.map((r: any) => found.get(r.id)).filter((p: Party | undefined): p is Party => !!p);
}

// GET /account/money/people?q=: accounts for the To and From fields' list,
// matched by handle or name; people the viewer follows and has paid first.
// Money goes to accounts here and on peers; requests (`local`) stay here.
async function peopleApi(viewer: Viewer, query: string, local: boolean): Promise<Response> {
	const q = query.trim().replace(/^@/, "").toLowerCase().slice(0, 300);
	if (!q) return Response.json([]);
	const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const reachable = local ? [] : peers().map((p) => p.id);
	const rows = await sql`select u.id::text from users u
		where u.status <> 'suspended' and u.deactivated_at is null and u.id <> ${viewer.id}::bigint
			and (u.instance is null or u.instance = any(${sql.array(reachable, "TEXT")}))
			and (lower(u.screen_name) like ${like} or lower(u.name) like ${like} or lower(u.name) like ${`% ${like}`})
			and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = ${viewer.id}::bigint) or (b.blocker_id = ${viewer.id}::bigint and b.blocked_id = u.id))
		order by lower(u.screen_name) = ${q} desc,
			exists (select 1 from money_transfers t where t.sender_id = ${viewer.id}::bigint and t.recipient_id = u.id) desc,
			exists (select 1 from follows f where f.follower_id = ${viewer.id}::bigint and f.followee_id = u.id) desc,
			lower(u.screen_name) like ${like} desc, length(u.screen_name), u.id
		limit 8`;
	const found = await parties(rows.map((r: any) => r.id));
	return Response.json(
		rows
			.map((r: any) => found.get(r.id))
			.filter((x: Party | undefined): x is Party => !!x)
			.map((x: Party) => ({ screen_name: x.screen_name, name: x.merchant?.name ?? x.name, avatar: x.avatar, square: x.square, badges: badges(x) })),
		{ headers: { "cache-control": "private, no-store" } },
	);
}

// sending, on a screen of its own: who, how much, a note; or paying a request
async function sendView(req: Request, viewer: Viewer, status = 200, form: { to?: string; amount?: string; note?: string; request?: string } = {}, error = "") {
	const url = new URL(req.url);
	const requestId = form.request ?? url.searchParams.get("request") ?? "";
	const q = /^\d{1,19}$/.test(requestId) ? (await requests([requestId], viewer.id)).get(requestId) : undefined;
	if (q && (q.status !== "open" || q.requester.id === viewer.id || (q.payer && q.payer.id !== viewer.id)))
		return page(req, viewer, "Pay", `<p class="empty">This request isn't open to you any more.</p>`, 410);
	const [balance, picks] = await Promise.all([balanceOf(viewer.id), q ? Promise.resolve([]) : quickPicks(viewer.id)]);
	const to = q ? `@${q.requester.screen_name}` : (form.to ?? url.searchParams.get("to") ?? "");
	const amount = q?.amount ? (q.amount / 100).toFixed(2).replace(/\.00$/, "") : (form.amount ?? url.searchParams.get("amount") ?? "");
	const note = form.note ?? q?.note ?? "";
	const chosen = to.replace(/^@/, "").toLowerCase();
	return page(
		req,
		viewer,
		q ? "Pay" : "Send",
		`${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/account/money/send" class="send" autocomplete="off">
<input type="hidden" name="idem" value="${crypto.randomUUID()}">${q ? `<input type="hidden" name="request" value="${q.id}">` : ""}
<div class="big"><span>$</span><input id="amount" name="amount" required inputmode="decimal" placeholder="0" aria-label="Amount" value="${esc(amount)}"${q?.amount ? " readonly" : ""}></div>
<div class="balance">${formatCents(balance)} available</div>
${
	q
		? `<input type="hidden" name="to" value="${esc(to)}"><div class="paying">${face(q.requester)}<div>${who(q.requester)}<div class="dim">@${esc(q.requester.screen_name)}${q.note ? ` · ${esc(q.note)}` : ""}</div></div></div>`
		: `${
				picks.length
					? `<div class="picks" role="group" aria-label="People">${picks
							.map((p: Party) => `<button type="button" class="pick" data-handle="${esc(p.screen_name)}" aria-pressed="${chosen === p.screen_name.toLowerCase()}">${face(p)}<span>${esc(p.merchant?.name ?? p.name)}</span></button>`)
							.join("")}</div>`
					: ""
			}
<div class="field"><input id="to" name="to" required placeholder=" " value="${esc(to)}" autocapitalize="off" autocomplete="off" spellcheck="false" data-people role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="people"><label for="to">To</label></div>`
}
<div class="field"><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder=" " value="${esc(note)}"><label for="note">What's it for?</label></div>
<label class="check">Share it in a post<input type="checkbox" name="share" value="1"></label>
<button type="submit" class="pill primary wide">${q ? "Pay" : "Send"}</button>
<p class="fine">Instant and free. ${esc(settings().instance_name)} Equicoins has no cash value.${
	settings().money.feed ? ` Payments are posted publicly by <a href="/${esc(settings().money.feed)}">@${esc(settings().money.feed)}</a>, without your note.` : ""
}</p>
</form>`,
		status,
	);
}

async function requestView(req: Request, viewer: Viewer, status = 200, form: { from?: string; amount?: string; note?: string } = {}, error = "") {
	const url = new URL(req.url);
	const from = form.from ?? url.searchParams.get("from") ?? "";
	return page(
		req,
		viewer,
		"Request",
		`${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/account/money/request" class="send" autocomplete="off">
<div class="big"><span>$</span><input id="amount" name="amount" inputmode="decimal" placeholder="0" aria-label="Amount" value="${esc(form.amount ?? "")}"></div>
<div class="balance">Leave it at 0 to let people choose</div>
<div class="field"><input id="from" name="from" placeholder=" " value="${esc(from)}" autocapitalize="off" autocomplete="off" spellcheck="false" data-people data-local role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="people"><label for="from">From (@username, or empty for anyone)</label></div>
<div class="field"><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder=" " value="${esc(form.note ?? "")}"><label for="note">What's it for?</label></div>
<label class="check"><span>Share it in a post<small>A Pay button anyone who sees the post can use</small></span><input type="checkbox" name="share" value="1" checked></label>
<button type="submit" class="pill primary wide">Request</button>
<p class="fine">Asking one account sends them a notification to pay or decline.</p>
</form>`,
		status,
	);
}

// one payment, for either side, or anyone once a side put it in a post
async function paymentPage(req: Request, viewer: Viewer, id: string) {
	const t = (await payments([id], viewer.id)).get(id);
	if (!t) return page(req, viewer, "Payment", `<p class="empty">This payment doesn't exist, or isn't yours to see.</p>`, 404);
	const mine = viewer.id === t.sender.id || viewer.id === t.recipient.id;
	const other = viewer.id === t.sender.id ? t.recipient : t.sender;
	const post = new URL(req.url).searchParams.has("post");
	const link = (p: Party) => `<a href="/${esc(p.screen_name)}">${esc(p.name)}</a>${badges(p)}`;
	return page(
		req,
		viewer,
		"Payment",
		`<section class="receipt">${paymentCard(t, (mine ? viewer.screen_name : t.sender.screen_name).toLowerCase(), !t.shared)}
${mine ? `<div class="row">${postButton(paymentUrl(t.id), "Post", post)}<a class="pill" href="/account/money/send?to=${encodeURIComponent(other.screen_name)}">${viewer.id === t.sender.id ? "Pay again" : "Pay back"}</a></div>` : ""}</section>
<dl>
<dt>From</dt><dd>${link(t.sender)}</dd>
<dt>To</dt><dd>${link(t.recipient)}</dd>
<dt>Amount</dt><dd>${formatCents(t.amount)}</dd>
<dt>Date</dt><dd>${t.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</dd>
<dt>Status</dt><dd${t.reversed || t.status !== "complete" ? "" : ' style="color:var(--success)"'}>${t.reversed ? "Reversed: the money went back to the sender" : t.status === "pending" ? "Waiting for the recipient’s instance to confirm" : t.status === "failed" ? "Could not deliver; the money was refunded" : "Completed"}</dd>
</dl>`,
	);
}

// one request: pay or decline it, or as its requester share or cancel it
async function requestPage(req: Request, viewer: Viewer, id: string, status = 200, notice = "") {
	const q = (await requests([id], viewer.id)).get(id);
	if (!q) return page(req, viewer, "Request", `<p class="empty">This request doesn't exist, or isn't yours to see.</p>`, 404);
	const mine = q.requester.id === viewer.id;
	const post = new URL(req.url).searchParams.has("post");
	const open = q.status === "open";
	const link = (p: Party) => `<a href="/${esc(p.screen_name)}">${esc(p.name)}</a>${badges(p)}`;
	const actions = mine
		? `${open ? postButton(requestUrl(q.id), "Post", post) : ""}${open ? `<form method="post"><input type="hidden" name="action" value="cancel"><button type="submit" class="pill">Cancel request</button></form>` : ""}`
		: q.payer?.id === viewer.id && open
			? `<a class="pill primary" href="/account/money/send?request=${q.id}">Pay</a><form method="post"><input type="hidden" name="action" value="decline"><button type="submit" class="pill">Decline</button></form>`
			: "";
	return page(
		req,
		viewer,
		"Request",
		`${notice ? `<div class="notice" role="status">${notice}</div>` : ""}<section class="receipt">${requestCard(q, viewer.id)}${actions ? `<div class="row">${actions}</div>` : ""}</section>
<dl>
<dt>Requested by</dt><dd>${link(q.requester)}</dd>
<dt>From</dt><dd>${q.payer ? link(q.payer) : "Anyone"}</dd>
<dt>Amount</dt><dd>${q.amount ? formatCents(q.amount) : "Payer chooses"}</dd>
${q.note ? `<dt>For</dt><dd>${esc(q.note)}</dd>` : ""}
<dt>Asked</dt><dd>${q.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</dd>
<dt>Status</dt><dd>${open ? (q.payer ? "Waiting" : "Open") : q.status === "paid" ? `<span style="color:var(--success)">Paid</span>` : q.status === "declined" ? "Declined" : "Cancelled"}</dd>
${!q.payer && mine ? `<dt>Paid</dt><dd>${q.paidCount} time${q.paidCount === 1 ? "" : "s"} · ${formatCents(q.paidCents)}</dd>` : ""}
</dl>`,
		status,
	);
}

// Settings > Equicoins: merchant mode, for gold organisations
export async function merchantRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance) return accountPage({ req, viewer, status: 404, title: "Equicoins", body: `<p>Equicoins isn't available on ${esc(settings().instance_name)}.</p>` });
	let notice = "";
	let error = "";
	if (req.method === "POST") {
		const m = await merchantOf(viewer.id);
		const form = await req.formData();
		if (!m.gold) error = "Merchant mode is for organisations with a gold checkmark.";
		else if (viewer.actor && viewer.actor.role !== "Admin") error = "Only the account or its admins can change this.";
		else
			try {
				await setMerchant(viewer.id, form.get("on") === "1", String(form.get("name") ?? ""), form.get("banner") === "1");
				notice = "Saved.";
			} catch (e) {
				if (!(e instanceof MoneyError)) throw e;
				error = e.message;
			}
	}
	const m = await merchantOf(viewer.id);
	const me = (await parties([viewer.id])).get(viewer.id)!;
	const [{ banner_url }] = await sql`select banner_url from users where id = ${viewer.id}::bigint`;
	const sample = { id: "0", amount: 352, note: "", at: new Date(), sender: me, recipient: me };
	const banner = m.showBanner && banner_url ? absolute(banner_url) : null;
	const asMerchant = { ...me, merchant: { name: m.name || me.name, banner: banner && /^(https?:\/\/|\/)[^\s"'()\\<>]+$/.test(banner) ? banner : null } };
	return accountPage({
		req,
		viewer,
		title: "Equicoins",
		back: { href: "/account/", label: "Back to Xitter settings" },
		css: CSS,
		body: `<section class="settings">${tile}
${notice ? `<div class="notice" role="status" style="margin:0">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert" style="margin:0">${esc(error)}</div>` : ""}
<h2>Merchant mode</h2>
<p class="dim">Payments to your organisation read as purchases, like “${shortCents(352)} at ${esc(m.name || me.name)}”, and your Pay button carries your logo.${m.gold ? "" : " It's for organisations with a gold checkmark."}</p>
${
	m.gold
		? `<form method="post" class="send" style="padding:0">
<label class="check">Merchant mode<input type="checkbox" name="on" value="1"${m.on ? " checked" : ""}></label>
<div class="field"><input id="name" name="name" maxlength="50" placeholder=" " value="${esc(m.name)}"><label for="name">Name on purchases (empty: ${esc(me.name)})</label></div>
<label class="check"><span>Show your banner<small>Purchase cards show your header picture above your logo</small></span><input type="checkbox" name="banner" value="1"${m.showBanner ? " checked" : ""}></label>
<button type="submit" class="pill primary wide">Save</button></form>
<h2>Preview</h2><div class="preview">${paymentCard({ ...sample, recipient: asMerchant }, "")}${requestCard({ id: "0", amount: null, note: "", status: "open", at: new Date(), requester: asMerchant, payer: null, paidCount: 0, paidCents: 0 }, "")}</div>`
		: ""
}</section>`,
	});
}

// The first time Equicoins opens, before anything else: what its money is. The
// page asked for comes back once it's accepted.
function disclaimer(req: Request, viewer: Viewer, back: string) {
	const name = esc(`${settings().instance_name} Equicoins`);
	return page(
		req,
		viewer,
		"Equicoins",
		`<section class="settings" style="padding:32px 16px">${tile}
<h1>Welcome to ${name}</h1>
<p><b>Disclaimer:</b> ${esc(disclaimerText())}</p>
<form method="post" action="/account/money" class="send" style="padding:8px 0 0"><input type="hidden" name="action" value="accept"><input type="hidden" name="back" value="${esc(back)}">
<button type="submit" class="pill primary wide">I understand</button></form></section>`,
		200,
		{ href: "/home", label: "Back to home" },
	);
}

export async function moneyRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance)
		return accountPage({ req, viewer, status: 404, title: "Equicoins", body: `<h1>Equicoins</h1><p>Equicoins isn't available on ${esc(settings().instance_name)}.</p>` });
	const url = new URL(req.url);
	const p = url.pathname;
	const remoteBadge = /^\/account\/money\/shop\/badge\/([^/]{1,300})\/(\d{1,19})$/.exec(p);
	if (req.method === "GET" && remoteBadge) {
		let origin = "";
		try { origin = decodeURIComponent(remoteBadge[1]).toLowerCase(); } catch {}
		if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(origin)) return new Response("Not found", { status: 404 });
		const [image] = await sql`select badge_image, badge_mime from money_remote_shop_items
			where origin = ${origin} and remote_id = ${remoteBadge[2]}::bigint and source_active and active and status = 'approved'`;
		if (!image?.badge_image || !BADGE_TYPES.includes(image.badge_mime)) return new Response("Not found", { status: 404 });
		return new Response(image.badge_image, { headers: { "content-type": image.badge_mime, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
	}
	// a picture sent with a shop request, for the staff who review it (Admin > Equicoins)
	const orderFile = /^\/account\/money\/shop\/file\/(\d{1,19})\/(\d{1,2})$/.exec(p);
	if (req.method === "GET" && orderFile) {
		if (viewer.role !== "admin" && viewer.role !== "moderator") return new Response("Not found", { status: 404 });
		const [f] = await sql`select image, mime from money_shop_order_files where order_id = ${orderFile[1]}::bigint and position = ${Number(orderFile[2])}`;
		if (!f) return new Response("Not found", { status: 404 });
		return new Response(f.image, { headers: { "content-type": f.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
	}
	if (!(await disclaimerAccepted(viewer.id))) {
		if (req.method !== "POST") return disclaimer(req, viewer, p + url.search);
		const form = await req.formData();
		if (form.get("action") !== "accept" || (viewer.actor && viewer.actor.role !== "Admin")) return disclaimer(req, viewer, "/account/money");
		await acceptDisclaimer(viewer.id);
		// only back to one of Money's own pages
		const back = String(form.get("back") ?? "");
		return new Response(null, { status: 303, headers: { location: /^\/account\/money(\/[\w/]*)?(\?[\w=&%.-]*)?$/.test(back) ? back : "/account/money" } });
	}
	const payment = /^\/account\/money\/p\/(\d{1,19})$/.exec(p);
	if (payment) return paymentPage(req, viewer, payment[1]);
	const asked = /^\/account\/money\/r\/(\d{1,19})$/.exec(p);
	if (asked) {
		if (req.method !== "POST") return requestPage(req, viewer, asked[1]);
		const action = String((await req.formData()).get("action") ?? "");
		if ((action !== "decline" && action !== "cancel") || viewer.actor) return requestPage(req, viewer, asked[1], 400);
		const done = await closeRequest(viewer.id, asked[1], action);
		// from the Money page's list, back to it
		if (done && (req.headers.get("referer") ?? "").replace(/\?.*$/, "").endsWith("/account/money"))
			return new Response(null, { status: 303, headers: { location: `/account/money?${action === "decline" ? "declined" : "cancelled"}=1` } });
		return requestPage(req, viewer, asked[1], done ? 200 : 409, done ? (action === "decline" ? "Declined." : "Cancelled.") : "");
	}
	if (p === "/account/money/request") {
		if (viewer.actor) return home(req, viewer, 403, "", `Only @${viewer.screen_name} can ask for money for this account.`);
		if (req.method !== "POST") return requestView(req, viewer);
		const form = await req.formData();
		const values = { from: String(form.get("from") ?? ""), amount: String(form.get("amount") ?? ""), note: String(form.get("note") ?? "") };
		if (!hit("write", viewer.id).ok) return requestView(req, viewer, 429, values, "You're asking too fast. Wait a few minutes and try again.");
		try {
			const id = await requestMoney(viewer.id, values.from, values.amount.trim() === "0" ? "" : values.amount, values.note);
			return new Response(null, { status: 303, headers: { location: `/account/money/r/${id}${form.get("share") ? "?post=1" : ""}` } });
		} catch (e) {
			if (e instanceof MoneyError) return requestView(req, viewer, 400, values, e.message);
			throw e;
		}
	}
	if (p === "/account/money/rewards") {
		if (req.method !== "POST") return rewardsPage(req, viewer, 200, url.searchParams.has("paid") ? "Paid out into your balance." : "");
		const form = await req.formData();
		if (form.get("action") !== "payout") return rewardsPage(req, viewer, 400);
		if (viewer.actor) return rewardsPage(req, viewer, 403, "", `Only @${viewer.screen_name} can pay out for this account.`);
		if (!hit("write", viewer.id).ok) return rewardsPage(req, viewer, 429, "", "You're going too fast. Wait a few minutes and try again.");
		try {
			await payOutRewards(viewer.id);
		} catch (e) {
			if (e instanceof RewardsError) return rewardsPage(req, viewer, 400, "", e.message);
			throw e;
		}
		return new Response(null, { status: 303, headers: { location: "/account/money/rewards?paid=1" } });
	}
	if (p === "/account/money/crypto" || p.startsWith("/account/money/crypto/")) {
		if (!cryptoOn()) return page(req, viewer, "Crypto", `<p class="empty">Crypto isn't available here.</p>`, 404);
		if (p === "/account/money/crypto") return page(req, viewer, "Crypto", await cryptoHome(viewer.id, await balanceOf(viewer.id)));
		const asset = assetOf(p.slice("/account/money/crypto/".length));
		if (!asset) return new Response("not found", { status: 404 });
		const back = { href: "/account/money/crypto", label: "Back to Crypto" };
		const show = async (code = 200, form: { side?: string; amount?: string } = {}, err = "", done = "") =>
			page(req, viewer, asset.name, `${done ? `<div class="notice" role="status">${esc(done)}</div>` : ""}${err ? `<div class="notice error" role="alert">${esc(err)}</div>` : ""}${await cryptoAsset(viewer.id, asset, await balanceOf(viewer.id), form)}`, code, back);
		if (req.method !== "POST") {
			const done = url.searchParams.get("done");
			return show(200, {}, "", done === "buy" ? `Bought ${asset.name}.` : done === "sell" ? `Sold ${asset.name}.` : "");
		}
		const form = await req.formData();
		const values = { side: String(form.get("side") ?? "buy"), amount: String(form.get("amount") ?? "") };
		if (viewer.actor) return show(403, values, `Only @${viewer.screen_name} can trade for this account.`);
		if (!hit("write", viewer.id).ok) return show(429, values, "You're trading too fast. Wait a few minutes and try again.");
		const all = values.side === "sell" && form.get("all") === "1";
		const cents = all ? null : parseAmount(values.amount);
		if (!all && cents === null) return show(400, values, "Enter an amount, like 5 or 12.50.");
		try {
			if (values.side === "sell") await sellCrypto(viewer.id, asset.symbol, cents);
			else await buyCrypto(viewer.id, asset.symbol, cents as number);
		} catch (e) {
			if (e instanceof MoneyError) return show(400, values, e.message);
			throw e;
		}
		return new Response(null, { status: 303, headers: { location: `/account/money/crypto/${asset.symbol}?done=${values.side === "sell" ? "sell" : "buy"}` } });
	}
	if (p === "/account/money/shop") {
		if (!settings().money_shop.enabled) return page(req, viewer, "Equicoins shop", `<p class="empty">The shop is closed.</p>`, 404);
		let error = "";
		if (req.method === "POST") {
			if (viewer.actor) error = `Only @${esc(viewer.screen_name)} can buy from this account.`;
			else if (!hit("write", viewer.id).ok) error = "You're sending requests too fast. Wait a few minutes and try again.";
			else {
				const form = await req.formData();
				const text = (k: string) => String(form.get(k) ?? "");
				const image = async (f: FormDataEntryValue | null) => (f instanceof File && f.size ? Buffer.from(await f.arrayBuffer()) : undefined);
				try {
					const stickers: Buffer[] = [];
					for (const f of form.getAll("stickers").slice(0, 7)) {
						const b = await image(f);
						if (b) stickers.push(b);
					}
					const bought = await buyShopItem(viewer.id, text("item"), {
						text: text("text"),
						link: text("link"),
						badgeName: text("badgeName"),
						badgeImage: await image(form.get("badgeImage")),
						gift: text("gift"),
						hashtag: text("hashtag"),
						emoji: await image(form.get("emoji")),
						packName: text("packName"),
						stickers,
						title: text("title"),
						summary: text("summary"),
						query: text("query"),
						picture: await image(form.get("picture")),
						post: text("post"),
					});
					return new Response(null, { status: 303, headers: { location: `/account/money/shop?${bought.auto ? "ready" : "requested"}=1` } });
				} catch (e) {
					if (e instanceof ShopError) error = e.message;
					else throw e;
				}
			}
		}
		const [items, orders, balance] = await Promise.all([shopItems(true), myShopOrders(viewer.id), balanceOf(viewer.id)]);
		const notice = url.searchParams.has("ready") ? "It's ready: find it under Your requests." : url.searchParams.has("requested") ? "Your request is waiting for staff approval." : "";
		return page(req, viewer, "Equicoins shop", await shopView(items, orders, balance, error, notice));
	}
	if (p === "/account/money/people") return peopleApi(viewer, url.searchParams.get("q") ?? "", url.searchParams.has("local"));
	const sending = p === "/account/money/send";
	if (!sending && p !== "/account/money") return new Response("not found", { status: 404 });
	if (req.method !== "POST") {
		if (sending) return viewer.actor ? home(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`) : sendView(req, viewer);
		const sent = url.searchParams.get("sent");
		const [t] = sent && /^\d{1,19}$/.test(sent) ? await sql`select t.id::text, t.amount_cents, u.screen_name from money_transfers t join users u on u.id = t.recipient_id where t.id = ${sent}::bigint and t.sender_id = ${viewer.id}::bigint` : [];
		const notice = t
			? `<span>Sent ${formatCents(Number(t.amount_cents))} to @${esc(t.screen_name)}.</span><button type="button" class="pill small" data-compose="${esc(paymentUrl(t.id))}">Post it</button>`
			: url.searchParams.has("declined")
				? "Request declined."
				: url.searchParams.has("cancelled")
					? "Request cancelled."
					: "";
		return home(req, viewer, 200, notice);
	}
	const form = await req.formData();
	const field = (k: string) => String(form.get(k) ?? "");
	const values = { to: field("to"), amount: field("amount"), note: field("note"), request: field("request") || undefined };
	if (viewer.actor) return home(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`);
	if (!hit("write", viewer.id).ok) return sendView(req, viewer, 429, values, "You're sending too fast. Wait a few minutes and try again.");
	const cents = parseAmount(values.amount);
	if (cents === null) return sendView(req, viewer, 400, values, "Enter an amount, like 5 or 12.50.");
	try {
		const r = await sendMoney(viewer.id, values.to, cents, values.note, field("idem"), values.request);
		// after a send the page reloads by GET, so going back or refreshing can't send it twice
		const to = field("share") ? `/account/money/p/${r.id}?post=1` : `/account/money?sent=${r.id}`;
		return new Response(null, { status: 303, headers: { location: to } });
	} catch (e) {
		if (e instanceof MoneyError) return sendView(req, viewer, 400, values, e.message);
		throw e;
	}
}

