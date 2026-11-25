// Video (the "video" feature): X's Video screen at /i/video, and the
// full-screen viewer a phone-sized client opens when a video is tapped, which
// swipes on through more videos (from a profile, that account's videos). Both are lists of posts with a video, picked
// by search.ts, so what the viewer may not see (blocks, protected accounts,
// hidden or limited posts, Circles, federation settings) stays out the same
// way it does in search. The client sends no cursor for either: one page each.

import type { Viewer } from "./auth";
import { newId } from "./ids";
import { tweetEntry } from "./model";
import { postsByIds } from "./posts";
import { searchPosts } from "./search";
import { feature } from "./settings";

type Vars = Record<string, any>;
const DAY = 86_400_000;
const TRENDING = 10;
const FOLLOWING = 10;
const LATEST = 40;
const IMMERSIVE = 30;

const empty = { instructions: [{ type: "TimelineAddEntries", entries: [] }] };

// posts with a video, in the order search gave them, leaving out `skip`
async function videos(viewerId: string, query: string, top: boolean, limit: number, skip: Set<string> = new Set()) {
	const ids = (await searchPosts(`filter:videos ${query}`.trim(), { viewerId, top, limit: limit + skip.size })).filter((id) => !skip.has(id)).slice(0, limit);
	const posts = await postsByIds(viewerId, ids);
	return ids.map((id) => posts.get(id)).filter((p) => !!p);
}

type Post = NonNullable<Awaited<ReturnType<typeof videos>>[number]>;

// a row of posts the Video screen shows side by side, under a heading
const carousel = (id: string, title: string, displayType: "Carousel" | "CompactCarousel", posts: Post[], sortIndex: string) => ({
	entryId: id,
	sortIndex,
	content: {
		__typename: "TimelineTimelineModule",
		entryType: "TimelineTimelineModule",
		displayType,
		header: { displayType: "Classic", text: title, sticky: false },
		items: posts.map((p) => {
			const e = tweetEntry(p, sortIndex);
			return { entryId: `${id}-${e.entryId}`, item: { itemContent: e.content.itemContent } };
		}),
	},
});

export const videoHandlers = {
	// the Video screen: trending videos of the last week, then the accounts the
	// viewer follows, then the newest videos from everyone
	MediaTabVideoMixer: async (v: Viewer) => {
		if (!feature("video")) return { data: { media_tab_video_mixer_timeline: { timeline: empty } } };
		const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
		const [trending, following] = await Promise.all([
			videos(v.id, `since:${since}`, true, TRENDING),
			videos(v.id, "filter:follows", false, FOLLOWING),
		]);
		const latest = await videos(v.id, "", false, LATEST, new Set(trending.map((p) => p.id)));
		const base = BigInt(newId());
		const sort = (i: number) => (base - BigInt(i)).toString();
		const entries: unknown[] = [];
		if (trending.length) entries.push(carousel("trending-videos", "Trending videos", "Carousel", trending, sort(0)));
		if (following.length) entries.push(carousel("following-videos", "From people you follow", "CompactCarousel", following, sort(1)));
		latest.forEach((p, i) => entries.push(tweetEntry(p, sort(i + 2))));
		return { data: { media_tab_video_mixer_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } };
	},
	// the full-screen viewer: the tapped post first, then other videos, trending first
	ImmersiveMedia: async (v: Viewer, vars: Vars) => {
		if (!feature("video")) return { data: { immersiveMedia: { timeline: empty } } };
		const first = await pinnedPost(v.id, vars.pinned_tweet_id);
		const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
		const skip = new Set(first ? [first.id] : []);
		const trending = await videos(v.id, `since:${since}`, true, IMMERSIVE, skip);
		for (const p of trending) skip.add(p.id);
		const rest = trending.length < IMMERSIVE ? await videos(v.id, "", false, IMMERSIVE - trending.length, skip) : [];
		return { data: { immersiveMedia: { timeline: list([...(first ? [first] : []), ...trending, ...rest]) } } };
	},
	// the same viewer opened from a profile: the tapped post, then the rest of
	// its author's videos, newest first
	ImmersiveProfile: async (v: Viewer, vars: Vars) => {
		if (!feature("video")) return { data: { immersiveProfile: { timeline: empty } } };
		const first = await pinnedPost(v.id, vars.pinned_tweet_id);
		if (!first) return { data: { immersiveProfile: { timeline: empty } } };
		const rest = await videos(v.id, `from:${first.author.screen_name}`, false, IMMERSIVE, new Set([first.id]));
		return { data: { immersiveProfile: { timeline: list([first, ...rest]) } } };
	},
};

async function pinnedPost(viewerId: string, id: unknown) {
	return typeof id === "string" && /^\d{1,19}$/.test(id) ? (await postsByIds(viewerId, [id])).get(id) : undefined;
}

function list(posts: Post[]) {
	const base = BigInt(newId());
	return { instructions: [{ type: "TimelineAddEntries", entries: posts.map((p, i) => tweetEntry(p, (base - BigInt(i)).toString())) }] };
}
