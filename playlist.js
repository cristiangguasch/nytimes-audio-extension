const dateSelect = document.querySelector("#date");
const refreshButton = document.querySelector("#refresh");
const status = document.querySelector("#status");
const playlist = document.querySelector("#playlist");
let archive = {};

function niceDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric"
  }).format(new Date(`${date}T12:00:00`));
}

function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function renderDates(selected) {
  const dates = Object.keys(archive).sort().reverse();
  dateSelect.innerHTML = dates.map((date) =>
    `<option value="${date}" ${date === selected ? "selected" : ""}>${niceDate(date)}</option>`
  ).join("");
  dateSelect.hidden = dates.length === 0;
  return selected || dates[0];
}

function render(date) {
  const tracks = (archive[date] || []).filter((track) => {
    try { return !new URL(track.article).pathname.includes("/podcasts/"); } catch { return false; }
  });
  if (!tracks.length) {
    playlist.innerHTML = '<div class="empty">No narrated articles saved yet.</div>';
    return;
  }
  playlist.innerHTML = tracks.map((track, index) => `
    <article class="track">
      <span class="number">${String(index + 1).padStart(2, "0")}</span>
      <div class="content">
        <a class="title" href="${escapeHtml(track.article)}" target="_blank" rel="noreferrer">${escapeHtml(track.title)}</a>
        ${track.section ? `<p class="section">${escapeHtml(track.section)}</p>` : ""}
        <audio controls preload="metadata" src="${escapeHtml(track.audio)}"></audio>
      </div>
    </article>
  `).join("");

  document.querySelectorAll("audio").forEach((audio) => {
    audio.addEventListener("play", () => {
      document.querySelectorAll("audio").forEach((other) => {
        if (other !== audio) other.pause();
      });
    });
  });
}

async function load(preferredDate) {
  ({ archive = {} } = await chrome.storage.local.get("archive"));
  const date = renderDates(preferredDate);
  render(date);
}

dateSelect.addEventListener("change", () => render(dateSelect.value));

async function refresh() {
  refreshButton.disabled = true;
  refreshButton.classList.add("loading");
  status.textContent = "Scanning the homepage and linked articles…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "refresh" });
    if (!result?.ok) throw new Error(result?.error || "Refresh failed.");
    await load(result.date);
    status.textContent = `${result.found} narrated ${result.found === 1 ? "article" : "articles"} found.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("loading");
  }
}

refreshButton.addEventListener("click", refresh);

async function initialize() {
  const saved = await chrome.storage.local.get(["archive", "lastRefresh"]);
  await load();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const refreshedDate = saved.lastRefresh ? dateFormatter.format(new Date(saved.lastRefresh)) : "";
  const today = dateFormatter.format(new Date());
  if (refreshedDate !== today) refresh();
}

initialize();
