import { NextRequest, NextResponse } from "next/server";
import ytdl from "ytdl-core";
import { lookup } from "node:dns/promises";

export const runtime = "nodejs";

const hosts = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
  "instagram.com", "www.instagram.com", "facebook.com", "www.facebook.com",
  "m.facebook.com", "fb.watch", "tiktok.com", "www.tiktok.com",
  "twitter.com", "www.twitter.com", "x.com", "www.x.com",
  "pinterest.com", "www.pinterest.com", "linkedin.com", "www.linkedin.com"
]);

const hits = new Map<string, { n: number; until: number }>();

function limit(ip: string) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.until < now) {
    hits.set(ip, { n: 1, until: now + 60_000 });
    return false;
  }
  entry.n += 1;
  return entry.n > 8;
}

function privateIP(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length === 4) {
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") ||
    s.startsWith("fd") || s.startsWith("fe80:");
}

function meta(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp("<meta[^>]+property=['\\\"]" + escaped + "['\\\"][^>]+content=['\\\"]([^'\\\"]+)['\\\"]", "i"),
    new RegExp("<meta[^>]+content=['\\\"]([^'\\\"]+)['\\\"][^>]+property=['\\\"]" + escaped + "['\\\"]", "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/&amp;/g, "&");
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limit(ip)) {
    return NextResponse.json({ error: "Too many requests. Wait one minute." }, { status: 429 });
  }

  try {
    const body = await req.json();
    if (body?.confirmed !== true) {
      return NextResponse.json({ error: "Confirm that you own this video or have permission." }, { status: 400 });
    }
    if (typeof body.url !== "string" || body.url.length > 2048) {
      throw new Error("Enter a valid URL under 2,048 characters.");
    }

    const url = new URL(body.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Only public HTTP(S) URLs are accepted.");
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hosts.has(host)) throw new Error("This platform domain is not supported.");

    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((item) => privateIP(item.address))) {
      throw new Error("Destination could not be safely verified.");
    }

    const platform = host.includes("youtube") || host === "youtu.be" ? "YouTube"
      : host.includes("instagram") ? "Instagram"
      : host.includes("facebook") || host === "fb.watch" ? "Facebook"
      : host.includes("tiktok") ? "TikTok"
      : host.includes("twitter") || host.includes("x.com") ? "X / Twitter"
      : host.includes("pinterest") ? "Pinterest" : "LinkedIn";

    if (platform === "YouTube") {
      if (!ytdl.validateURL(url.toString())) throw new Error("Unsupported public YouTube URL.");
      const info = await ytdl.getBasicInfo(url.toString());
      return NextResponse.json({
        title: info.videoDetails.title || "Video",
        thumbnail: info.videoDetails.thumbnails?.slice(-1)[0]?.url,
        platform,
        formats: [],
        note: "Metadata only. Use YouTube Studio to download your own video; direct extraction is disabled."
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "SnapFetchLegal/1.0", Accept: "text/html" }
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Redirects are not accepted. Paste the final public URL.");
      }
      if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) {
        throw new Error("Source did not return a public HTML page.");
      }
      const html = await response.text();
      if (html.length > 2_000_000) throw new Error("Page is too large to inspect.");
      const video = meta(html, "og:video:secure_url") || meta(html, "og:video");
      return NextResponse.json({
        title: meta(html, "og:title") || "Public video page",
        thumbnail: meta(html, "og:image"),
        platform,
        formats: [],
        note: video
          ? "Public metadata found; direct media downloading is disabled by default. Use official export tools."
          : "No public video metadata found. Use official export tools."
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error." },
      { status: 422 }
    );
  }
}
