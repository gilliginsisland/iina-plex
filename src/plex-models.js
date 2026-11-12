const P = require("./plex.js");

// Resources retain their authenticated client; snapshots contain only display data.
class PlexServer {
  constructor(api, data) {
    this.api = api;
    this.data = data;
  }
  get id() {
    return this.data.clientIdentifier;
  }
  get snapshot() {
    return { id: this.id, name: this.data.name, owned: P.flag(this.data.owned) };
  }
  connections(allowHTTP) {
    return P.connections(this.data, allowHTTP);
  }
  connection(uri, scope, allowHTTP) {
    return this.api.server(this.data, uri, scope, allowHTTP);
  }
}

class PlexHub {
  constructor(api, sources, type = null) {
    this.api = api;
    this.sources = sources;
    const identifier = String(
      (sources[0] && (sources[0].hubIdentifier || sources[0].key)) || ""
    ).toLowerCase();
    this.type =
      type ||
      (identifier.includes("continue")
        ? "continue"
        : identifier.includes("ondeck")
          ? "next"
          : identifier.includes("recentlyadded")
            ? "recent"
            : (sources[0] && sources[0].type) || "other");
    this.items = [];
    const seen = new Set();
    for (const source of sources)
      for (const data of source.Metadata || []) {
        if (
          !data ||
          !/^\d+$/.test(String(data.ratingKey)) ||
          !["movie", "episode", "show", "season"].includes(data.type)
        )
          continue;
        const item = api.media(data);
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        this.items.push(item);
      }
    if (this.type === "recent") this.items.sort((a, b) => b.addedAt - a.addedAt);
  }
  get more() {
    return this.sources.some(
      (source) => P.flag(source.more) || Number(source.size) > (source.Metadata || []).length
    );
  }
  page(start = 0, pageSize = 60) {
    const items = this.items.slice(start, start + pageSize).map((item) => item.snapshot),
      total = this.more ? null : this.items.length;
    return {
      section: this.type,
      items,
      start,
      total,
      next:
        items.length > 0 && (total === null ? items.length >= pageSize : start + items.length < total)
          ? start + items.length
          : null
    };
  }
}

class PlexMedia {
  constructor(api, data) {
    this.api = api;
    this.data = typeof data === "object" ? data : { ratingKey: P.id(data) };
    this.id = P.id(this.data.ratingKey);
  }
  get title() {
    return this.data.title || "Untitled";
  }
  get type() {
    return this.data.type;
  }
  get playable() {
    return ["movie", "episode"].includes(this.type);
  }
  get duration() {
    return Number(this.data.duration) || 0;
  }
  get offset() {
    return Number(this.data.viewOffset) || 0;
  }
  get addedAt() {
    return Number(this.data.addedAt) || 0;
  }
  get lastViewedAt() {
    return Number(this.data.lastViewedAt) || 0;
  }
  get seasonNumber() {
    return Number(this.data.parentIndex) || 0;
  }
  get episodeNumber() {
    return Number(this.data.index) || 0;
  }
  get showId() {
    return this.data.grandparentRatingKey;
  }
  get parentId() {
    return this.data.parentRatingKey;
  }
  get showTitle() {
    return this.data.grandparentTitle || "";
  }
  get artworkPath() {
    const path =
      this.data.thumb || this.data.composite || this.data.parentThumb || this.data.grandparentThumb;
    return path && /^\/(?:library\/(?:metadata|collections)|playlists)\//.test(path) ? P.path(path) : null;
  }
  get snapshot() {
    const item = this.data;
    return {
      id: this.id,
      title: this.title,
      type: this.type,
      year: item.year || "",
      edition: item.editionTitle || "",
      summary: item.summary || "",
      duration: this.duration,
      index: item.index,
      parentIndex: item.parentIndex,
      showId: this.showId || "",
      libraryId: item.librarySectionID || "",
      rating: item.contentRating || "",
      score: item.rating || item.audienceRating || "",
      watched: Number(item.viewCount || 0) > 0,
      progress: this.duration ? Math.min(1, Math.max(0, this.offset / this.duration)) : 0,
      episodes: item.leafCount || 0,
      parentTitle: item.grandparentTitle || item.parentTitle || "",
      playable: this.playable
    };
  }

  async load() {
    const result = await this.api.request("/library/metadata/" + this.id + "?includeMarkers=1"),
      data = (result.MediaContainer.Metadata || [])[0];
    if (!data || P.id(data.ratingKey) !== this.id)
      throw new Error("Plex returned a different item. Refresh and try again.");
    this.data = data;
    return this;
  }

  async update({ watched }) {
    if (typeof watched !== "boolean") throw new Error("Watched must be a boolean.");
    await this.api.request(
      "/:/" +
        (watched ? "scrobble" : "unscrobble") +
        "?" +
        P.query({ key: this.id, identifier: "com.plexapp.plugins.library" }),
      { method: "put", format: "none" }
    );
    return this.load();
  }

  async downloadArtwork(destination) {
    const path = this.artworkPath;
    if (!path) throw new Error("This title has no artwork.");
    return this.api.download(
      "/photo/:/transcode?" +
        P.query({
          url: path,
          width: 360,
          height: this.type === "episode" ? 203 : 540,
          minSize: 1,
          upscale: 0
        }),
      destination
    );
  }
}

module.exports = { PlexServer, PlexHub, PlexMedia };
