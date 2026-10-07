(() => {
  if (globalThis.__nytAudioScannerInstalled) return;
  globalThis.__nytAudioScannerInstalled = true;

  const HOME = "https://www.nytimes.com/";
  const MAX_ARTICLES = 250;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (message?.type !== "scan") return;
    scan()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Scan failed." }));
    return true;
  });

  function linksFromDocument(sourceDocument) {
    const seen = new Set();
    return [...sourceDocument.querySelectorAll("a[href]")].map((anchor) => {
      try {
        const url = new URL(anchor.getAttribute("href"), HOME);
        url.search = "";
        url.hash = "";
        return {
          article: url.href,
          title: (anchor.getAttribute("aria-label") || anchor.textContent || "").replace(/\s+/g, " ").trim()
        };
      } catch {
        return null;
      }
    }).filter((item) => {
      if (!item) return false;
      const url = new URL(item.article);
      if (url.hostname !== "www.nytimes.com" || !url.pathname.endsWith(".html")) return false;
      if (url.pathname.includes("/podcasts/")) return false;
      if (!/\/\d{4}\/\d{2}\/\d{2}\//.test(url.pathname) || seen.has(item.article)) return false;
      seen.add(item.article);
      return true;
    }).slice(0, MAX_ARTICLES);
  }

  function mergeLinks(...groups) {
    const merged = new Map();
    for (const group of groups) {
      for (const item of group) {
        if (!merged.has(item.article)) merged.set(item.article, item);
      }
    }
    return [...merged.values()].slice(0, MAX_ARTICLES);
  }

  function metadata(document, name) {
    return document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || "";
  }

  function audioFrom(html, document) {
    const element = document.querySelector("audio[src], audio source[src], meta[property='og:audio'], meta[property='og:audio:url']");
    const direct = element?.src || element?.content || "";
    if (/\.mp3(?:$|\?)/i.test(direct)) return direct;
    const normalized = html
      .replace(/\\u002F/gi, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    const matches = normalized.match(/https:\/\/[^"'<>\s]+\.mp3(?:\?[^"'<>\s\\]*)?/gi) || [];
    return matches.find((url) => /static\.nytimes\.com\/narrated-articles/i.test(url)) || matches[0] || "";
  }

  async function inspect(candidate) {
    try {
      const response = await fetch(candidate.article, { credentials: "include", cache: "no-store" });
      if (!response.ok) return null;
      const html = await response.text();
      const document = new DOMParser().parseFromString(html, "text/html");
      const audio = audioFrom(html, document);
      if (!audio) return null;
      return {
        title: metadata(document, "og:title") || candidate.title || "Untitled article",
        article: candidate.article,
        audio,
        section: metadata(document, "article:section"),
        added: new Date().toISOString()
      };
    } catch {
      return null;
    }
  }

  async function mapLimited(values, limit, mapper) {
    const output = new Array(values.length);
    let cursor = 0;
    async function worker() {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await mapper(values[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return output;
  }

  async function scan() {
    // The live homepage DOM contains client-rendered and lower-page links that
    // are sometimes absent from the HTML returned by a separate fetch.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const liveLinks = location.pathname === "/" ? linksFromDocument(document) : [];
    const response = await fetch(HOME, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`NYTimes returned ${response.status}. Open nytimes.com and confirm that you are signed in.`);
    const fetchedDocument = new DOMParser().parseFromString(await response.text(), "text/html");
    const candidates = mergeLinks(liveLinks, linksFromDocument(fetchedDocument));
    if (!candidates.length) throw new Error("No article links were found on the homepage.");
    const entries = (await mapLimited(candidates, 6, inspect)).filter(Boolean);
    return { scanned: candidates.length, entries };
  }
})();
