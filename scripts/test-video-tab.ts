// End-to-end check of the Video screen (/i/video, MediaTabVideoMixer) and the
// full-screen video viewer (ImmersiveMedia), against a running server. Needs
// ffmpeg for the clips, an admin and two plain accounts with the same
// password; removes what it creates and leaves the feature on.
// usage: bun scripts/test-video-tab.ts <admin> <user A> <user B> <password>

import { mkdirSync, readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, nameA, nameB, password] = process.argv.slice(2);
if (!adminName || !nameA || !nameB || !password) throw new Error("usage: bun scripts/test-video-tab.ts <admin> <user A> <user B> <password>");

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
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	const upload = async (clip: Uint8Array) => {
		const call = async (query: string, body?: FormData) => fetch(`${origin}/i/media/upload.json?${query}`, { method: "POST", headers, body });
		const id = (await (await call(`command=INIT&total_bytes=${clip.length}&media_type=video/mp4&media_category=tweet_video`)).json()).media_id_string;
		const form = new FormData();
		form.set("media", new Blob([clip]));
		await call(`command=APPEND&media_id=${id}&segment_index=0`, form);
		await call(`command=FINALIZE&media_id=${id}`);
		for (let i = 0; i < 120; i++) {
			const state = (await (await fetch(`${origin}/i/media/upload.json?command=STATUS&media_id=${id}`, { headers })).json()).processing_info?.state;
			if (state === "succeeded" || state === undefined) return id as string;
			if (state === "failed") throw new Error("video processing failed");
			await Bun.sleep(500);
		}
		throw new Error("video processing timed out");
	};
	return { gql, get, admin, upload, headers };
}

mkdirSync(".probe", { recursive: true });
const clipPath = ".probe/video-tab-clip.mp4";
const ff = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath], { stdout: "ignore", stderr: "inherit" });
if ((await ff.exited) !== 0) throw new Error("ffmpeg could not make the test clip");
const clip = readFileSync(clipPath);

const boss = await session(adminName);
const a = await session(nameA);
const b = await session(nameB);
const userA = (await b.get("UserByScreenName", { screen_name: nameA }))?.data?.user?.result;
if (!userA?.rest_id) throw new Error(`no account ${nameA}`);
const made: { who: typeof a; id: string }[] = [];
const post = async (who: typeof a, text: string, video: boolean) => {
	const media = video ? { media: { media_entities: [{ media_id: await who.upload(clip), tagged_users: [] }], possibly_sensitive: false } } : {};
	const id = (await who.gql("CreateTweet", { tweet_text: text, ...media }))?.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	made.push({ who, id });
	return id;
};

const tag = `vt${Date.now()}`;
const popular = await post(a, `a popular clip ${tag}`, true);
const quiet = await post(a, `a quiet clip ${tag}`, true);
const words = await post(a, `just words ${tag}`, false);
const hidden = await post(a, `a clip staff hid ${tag}`, true);
check(!!popular && !!quiet && !!words && !!hidden, "A posts three videos and a text post");
await b.gql("FavoriteTweet", { tweet_id: popular });
await boss.gql("FavoriteTweet", { tweet_id: popular });
await boss.admin("setPostVisibility", { id: hidden, hidden: true, sensitive: false });

const screen = async (who: typeof a) => {
	const res = await who.get("MediaTabVideoMixer", {});
	const entries: any[] = res?.data?.media_tab_video_mixer_timeline?.timeline?.instructions?.[0]?.entries ?? [];
	const module = (id: string) => entries.find((e) => e.entryId === id)?.content;
	const ids = (m: any) => (m?.items ?? []).map((i: any) => i.item?.itemContent?.tweet_results?.result?.rest_id);
	return {
		errors: res.errors,
		trending: module("trending-videos"),
		trendingIds: ids(module("trending-videos")),
		followingIds: ids(module("following-videos")),
		latestIds: entries.filter((e) => e.entryId.startsWith("tweet-")).map((e) => e.content.itemContent.tweet_results.result.rest_id),
	};
};

let s = await screen(b);
check(!s.errors, "the Video screen answers without errors", s.errors);
check(s.trending?.displayType === "Carousel" && s.trending?.header?.text === "Trending videos", "it starts with a Trending videos carousel", s.trending?.header);
check(s.trendingIds.includes(popular) && s.trendingIds.includes(quiet), "which has A's videos", s.trendingIds);
check(s.trendingIds.indexOf(popular) < s.trendingIds.indexOf(quiet), "the liked one first");
check(![...s.trendingIds, ...s.latestIds].includes(words), "a post without a video isn't there");
check(![...s.trendingIds, ...s.followingIds, ...s.latestIds].includes(hidden), "nor one staff hid");
check(!s.latestIds.some((id: string) => s.trendingIds.includes(id)), "the list below doesn't repeat the carousel");
check(!s.followingIds.includes(popular), "From people you follow is empty while B follows nobody with videos", s.followingIds);

await fetch(`${origin}/i/api/1.1/friendships/create.json`, { method: "POST", headers: { ...b.headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user_id: userA.rest_id }) });
s = await screen(b);
check(s.followingIds.includes(popular) && s.followingIds.includes(quiet), "after following A, A's videos are under From people you follow", s.followingIds);

// a blocked author's videos leave the screen
await fetch(`${origin}/i/api/1.1/blocks/create.json`, { method: "POST", headers: { ...a.headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ screen_name: nameB }) });
s = await screen(b);
check(![...s.trendingIds, ...s.followingIds, ...s.latestIds].includes(popular), "once A blocks B, B sees none of A's videos", s.trendingIds);
await fetch(`${origin}/i/api/1.1/blocks/destroy.json`, { method: "POST", headers: { ...a.headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ screen_name: nameB }) });

// the full-screen viewer: the tapped post first, then more videos
const immersive = async (pinned?: string) => {
	const res = await b.get("ImmersiveMedia", { pinned_tweet_id: pinned, page_name: "home", includePromotedContent: false });
	const entries = res?.data?.immersiveMedia?.timeline?.instructions?.[0]?.entries ?? [];
	return { errors: res.errors, ids: entries.map((e: any) => e.content?.itemContent?.tweet_results?.result?.rest_id) };
};
let im = await immersive(quiet);
check(!im.errors && im.ids[0] === quiet, "the viewer starts at the tapped video", im.ids.slice(0, 3));
check(im.ids.includes(popular) && new Set(im.ids).size === im.ids.length, "and goes on through others, each once");
im = await immersive(hidden);
check(!im.ids.includes(hidden), "a hidden post tapped by id doesn't open in it");
check(!(await immersive()).errors, "it answers without a tapped post too");
const unseen = await post(a, `nobody has seen this clip ${tag}`, true);
check((await immersive(quiet)).ids.includes(unseen), "a new video comes up in the viewer");
const views = (await a.get("TweetResultByRestId", { tweetId: unseen }))?.data?.tweetResult?.result?.views?.count;
check(!views || views === "0", "loading it there, behind the tapped one, doesn't count as a view", views);
const block = (path: string) => fetch(`${origin}/i/api/1.1/blocks/${path}`, { method: "POST", headers: { ...a.headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ screen_name: nameB }) });
await block("create.json");
check(!(await immersive(quiet)).ids.includes(quiet), "a video by someone who blocked the viewer doesn't open in it by id");
await block("destroy.json");
const other = await post(b, `B's own clip ${tag}`, true);
const profile = async (pinned: string) => {
	const res = await b.get("ImmersiveProfile", { pinned_tweet_id: pinned });
	return (res?.data?.immersiveProfile?.timeline?.instructions?.[0]?.entries ?? []).map((e: any) => e.content?.itemContent?.tweet_results?.result?.rest_id);
};
const fromProfile = await profile(quiet);
check(fromProfile[0] === quiet && fromProfile.includes(popular), "opened from A's profile, it goes through A's videos", fromProfile);
check(!fromProfile.includes(other) && !fromProfile.includes(words) && !fromProfile.includes(hidden), "and only those, without text posts or hidden ones");
check((await profile(hidden)).length === 0, "a hidden post opens nothing there either");

// the switch: off hides the screen and the viewer, in the page and the API
await boss.admin("saveSettings", { features: { video: false } });
const page = await (await fetch(`${origin}/home`, { headers: b.headers })).text();
check(page.includes('"rweb_video_screen_enabled":{"value":false}'), "switched off, the page turns the client's Video screen off");
s = await screen(b);
check(!s.trending && s.latestIds.length === 0, "and the screen comes back empty");
check((await immersive(quiet)).ids.length === 0, "and so does the viewer");
await boss.admin("saveSettings", { features: { video: true } });
const on = await (await fetch(`${origin}/home`, { headers: b.headers })).text();
check(on.includes('"rweb_video_screen_enabled":{"value":true}') && on.includes('"explore_relaunch_enable_immersive_web":{"value":true}'), "switched on again, both are on");

await fetch(`${origin}/i/api/1.1/friendships/destroy.json`, { method: "POST", headers: { ...b.headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user_id: userA.rest_id }) });
for (const m of made) await m.who.gql("DeleteTweet", { tweet_id: m.id });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
