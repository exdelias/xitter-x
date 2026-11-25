// End-to-end check of the Bookmarks screen's search box (BookmarkSearchTimeline)
// and "Clear all bookmarks" (BookmarksAllDelete), against a running server.
// Uses two existing accounts with the same password; removes what it creates.
// usage: bun scripts/test-bookmark-search.ts <user A> <user B> <password>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-bookmark-search.ts <user A> <user B> <password>");

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
	return { gql, get };
}

const a = await session(nameA);
const b = await session(nameB);
const tag = `bms${Date.now()}`;
const made: string[] = [];
const post = async (who: typeof a, text: string) => {
	const id = (await who.gql("CreateTweet", { tweet_text: text }))?.data?.create_tweet?.tweet_results?.result?.rest_id;
	made.push(id);
	return id as string;
};
const entries = (res: any) => res?.data?.search_by_raw_query?.bookmarks_search_timeline?.timeline?.instructions?.flatMap((i: any) => i.entries ?? []) ?? [];
const found = (res: any) => entries(res).map((e: any) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
const bottom = (res: any) => entries(res).find((e: any) => e.content?.cursorType === "Bottom")?.content?.value;
const search = (rawQuery: string, extra: object = {}) => a.get("BookmarkSearchTimeline", { rawQuery, count: 20, querySource: "typed_query", ...extra });

const cats = await post(b, `cats are great ${tag}`);
const dogs = await post(b, `dogs are fine ${tag}`);
const mine = await post(a, `my own cats ${tag}`);
const unsaved = await post(b, `cats nobody saved ${tag}`);
for (const id of [cats, dogs, mine]) await a.gql("CreateBookmark", { tweet_id: id });

const all = await search(tag);
check(!all.errors, "the search answers without errors", all.errors);
check(found(all).length === 3 && found(all)[0] === mine, "it finds every bookmark that matches, newest bookmark first", found(all));
check(!found(all).includes(unsaved), "and nothing that isn't bookmarked");
check(JSON.stringify(found(await search(`cats ${tag}`)).sort()) === JSON.stringify([cats, mine].sort()), "words narrow it down");
check(JSON.stringify(found(await search(`from:${nameB} ${tag}`)).sort()) === JSON.stringify([cats, dogs].sort()), "search operators work (from:)");
check(found(await search(`-cats ${tag}`)).join() === dogs, "and so does a minus");
check(found(await search(`nothing-like-this-${tag}`)).length === 0, "no match gives an empty list");
check(found(await search("lang:en")).length === 0 && !(await search("lang:en")).errors, "a query of only unknown operators matches nothing, quietly");
check(found(await b.get("BookmarkSearchTimeline", { rawQuery: tag, count: 20 })).length === 0, "someone else searches their own bookmarks, not A's");

// one per page: the cursor walks through all three, in order, once each
const seen: string[] = [];
let cursor: string | undefined;
for (let i = 0; i < 5; i++) {
	const res = await search(tag, { count: 1, ...(cursor ? { cursor } : {}) });
	seen.push(...found(res));
	cursor = bottom(res);
	if (!cursor) break;
}
check(seen.join() === found(all).join(), "pages follow on without repeats or gaps", seen);
check(!!(await search(tag, { cursor: "not-a-cursor" })).errors, "a made-up cursor is refused");

await b.gql("DeleteTweet", { tweet_id: dogs });
check(!found(await search(tag)).includes(dogs), "a deleted post drops out");

// Clear all bookmarks: every bookmark goes, folders stay but are empty
const folder = (await a.gql("createBookmarkFolder", { name: `f${tag}`.slice(0, 25) }))?.data?.bookmark_collection_create?.id;
await a.gql("bookmarkTweetToFolder", { bookmark_collection_id: folder, tweet_id: cats });
const cleared = await a.gql("BookmarksAllDelete", {});
check(cleared?.data?.bookmark_all_delete === "Done", "Clear all bookmarks answers Done", cleared);
const left = await a.get("Bookmarks", { count: 20 });
const leftIds = (left?.data?.bookmark_timeline_v2?.timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []).filter((e: any) => e.content?.itemContent);
check(leftIds.length === 0, "the Bookmarks list is empty afterwards", leftIds.length);
check(found(await search(tag)).length === 0, "and so is the search");
const inFolder = await a.get("BookmarkFolderTimeline", { bookmark_collection_id: folder });
const folderIds = (inFolder?.data?.bookmark_collection_timeline?.timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []).filter((e: any) => e.content?.itemContent);
check(!inFolder.errors && folderIds.length === 0, "the folder is still there, empty", inFolder.errors ?? folderIds.length);
const bSaved = await post(a, `B keeps this ${tag}`);
await b.gql("CreateBookmark", { tweet_id: bSaved });
await a.gql("BookmarksAllDelete", {});
check(found(await b.get("BookmarkSearchTimeline", { rawQuery: tag, count: 20 })).join() === bSaved, "clearing touches only the viewer's own bookmarks");

await a.gql("DeleteBookmarkFolder", { bookmark_collection_id: folder });
for (const id of made) {
	await a.gql("DeleteTweet", { tweet_id: id });
	await b.gql("DeleteTweet", { tweet_id: id });
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
