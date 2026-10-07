const HOME = "https://www.nytimes.com/";
const RSS = "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml";
const MAX_ARTICLES = 250;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("playlist.html") });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "refresh") return;
  refreshPlaylist()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Refresh failed." }));
  return true;
});

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function decode(value = "") {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getText(url) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9" }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

function homepageLinks(html) {
  const seen = new Set();
  const links = [];
  const pattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    try {
      const url = new URL(match[2].replace(/&amp;/gi, "&"), HOME);
      url.search = "";
      url.hash = "";
      const attrs = `${match[1]} ${match[3]}`;
      const aria = attrs.match(/aria-label=["']([^"']+)["']/i)?.[1];
      const article = url.href;
      if (url.hostname !== "www.nytimes.com" || !url.pathname.endsWith(".html")) continue;
      if (url.pathname.includes("/podcasts/")) continue;
      if (!/\/\d{4}\/\d{2}\/\d{2}\//.test(url.pathname) || seen.has(article)) continue;
      seen.add(article);
      links.push({ article, title: decode(aria || match[4]) });
    } catch {
      continue;
    }
    if (links.length >= MAX_ARTICLES) break;
  }
  return links;
}

function rssLinks(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return items.map((item) => ({
    article: decode(item.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1] || ""),
    title: decode(item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "")
  })).filter((item) => {
    try {
      const url = new URL(item.article);
      return url.hostname === "www.nytimes.com" && url.pathname.endsWith(".html") && !url.pathname.includes("/podcasts/");
    } catch {
      return false;
    }
  }).slice(0, MAX_ARTICLES);
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i")
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || "";
}

function findAudio(html) {
  const normalized = html
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const matches = normalized.match(/https:\/\/[^"'<>\s]+\.mp3(?:\?[^"'<>\s\\]*)?/gi) || [];
  return matches.find((url) => /static\.nytimes\.com\/narrated-articles/i.test(url)) || matches[0] || "";
}

async function inspectArticle(candidate) {
  try {
    const html = await getText(candidate.article);
    const audio = findAudio(html);
    if (!audio) return null;
    return {
      title: decode(meta(html, "og:title") || candidate.title || "Untitled article"),
      article: candidate.article,
      audio,
      section: decode(meta(html, "article:section")),
      added: new Date().toISOString()
    };
  } catch (error) {
    console.warn("Could not inspect", candidate.article, error);
    return null;
  }
}

async function mapLimited(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function waitForTab(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The NYTimes tab took too long to load."));
    }, 30000);
    function listener(updatedId, change) {
      if (updatedId === tabId && change.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scanInBrowser() {
  const nytTabs = await chrome.tabs.query({ url: ["https://www.nytimes.com/*"] });
  let tab = nytTabs.find((candidate) => {
    try { return new URL(candidate.url).pathname === "/"; } catch { return false; }
  });
  if (!tab) tab = await chrome.tabs.create({ url: HOME, active: false });
  await waitForTab(tab.id);

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["scanner.js"] });
  }
  const result = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
  if (!result?.ok) throw new Error(result?.error || "The browser scan failed.");
  return result;
}

async function refreshPlaylist() {
  let found = [];
  let scanned = 0;
  let source = "browser session";
  try {
    const browserResult = await scanInBrowser();
    found = browserResult.entries || [];
    scanned = browserResult.scanned || 0;
  } catch (error) {
    console.warn("Browser-session scan unavailable, using extension fetch", error);
    let candidates = [];
    try {
      candidates = homepageLinks(await getText(HOME));
      source = "homepage";
    } catch {
      candidates = rssLinks(await getText(RSS));
      source = "homepage RSS";
    }
    if (!candidates.length) throw new Error("No article links were found.");
    found = (await mapLimited(candidates, 6, inspectArticle)).filter(Boolean);
    scanned = candidates.length;
  }
  const date = today();
  const { archive = {} } = await chrome.storage.local.get("archive");
  const allowed = (item) => {
    try { return !new URL(item.article).pathname.includes("/podcasts/"); } catch { return false; }
  };
  const merged = new Map((archive[date] || []).filter(allowed).map((item) => [item.article, item]));
  for (const item of found.filter(allowed)) merged.set(item.article, item);
  archive[date] = [...merged.values()];
  await chrome.storage.local.set({ archive, lastRefresh: new Date().toISOString() });
  return { date, found: found.length, scanned, source };
}
