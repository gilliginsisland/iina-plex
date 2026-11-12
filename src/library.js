const P = require("./plex.js");
const Media = require("./media.js");

// Owns server selection, library requests and authenticated artwork caching.
class PlexLibrary {
  constructor(app) {
    this.app = app;
    this.servers = [];
    this.selected = null;
    this.browseGeneration = 0;
    this.connectionGeneration = 0;
    this.discoveryGeneration = 0;
    this.artwork = {};
    this.artworkSerial = 0;
    this.artworkCache = new Map();
  }

  registerEvents() {
    this.app.guarded("discover", (data) => this.discover(data));
    this.app.guarded("connect", (data) => this.connect(data));
    this.app.guarded("reconnect", (data) => this.reconnect(data));
    this.app.guarded("browse", (data) => this.browse(data));
    this.app.guarded("filters", (data) => this.loadFilters(data));
    this.app.guarded("watched", (data) => this.markWatched(data));
    this.app.guarded("details", (data) => this.loadDetails(data));
    this.app.guarded("artwork", (data) => this.loadArtwork(data));
  }

  reset() {
    this.selected = null;
    this.servers = [];
    this.artwork = {};
    this.artworkCache.clear();
  }

  rememberArtwork(items) {
    this.artwork = {};
    for (const item of items) {
      const thumb = item.thumb || item.composite || item.parentThumb || item.grandparentThumb;
      try {
        if (thumb && /^\/(?:library\/(?:metadata|collections)|playlists)\//.test(thumb))
          this.artwork[P.id(item.ratingKey)] = { path: P.path(thumb), wide: item.type === "episode" };
      } catch (_) {}
    }
  }

  async metadataAt(connection, id) {
    const result = await this.app.request(
      connection.base + "/library/metadata/" + P.id(id) + "?includeMarkers=1",
      connection.token
    );
    const item = (result.MediaContainer.Metadata || [])[0];
    if (!item || P.id(item.ratingKey) !== P.id(id))
      throw new Error("Plex returned a different item. Refresh and try again.");
    return item;
  }

  async discover() {
    if (!this.app.account.token) throw new Error("Sign in to Plex first.");
    if (this.app.account.needsProfile) throw new Error("Choose your Plex Home profile before browsing.");
    const currentSession = this.app.account.revision,
      generation = ++this.discoveryGeneration;
    let result;
    try {
      await this.app.account.identify();
      result = await this.app.account.resourcesFor(this.app.account.accessToken);
    } catch (error) {
      if (currentSession !== this.app.account.revision || generation !== this.discoveryGeneration) return;
      if (error.denied) {
        this.app.account.revokeAccess();
        return;
      }
      throw error;
    }
    if (currentSession !== this.app.account.revision || generation !== this.discoveryGeneration) return;
    this.servers = result.filter(
      (s) => (s.provides || "").split(",").indexOf("server") !== -1 && s.accessToken
    );
    this.app.send(
      "servers",
      this.servers.map((s) => ({ id: s.clientIdentifier, name: s.name, owned: P.flag(s.owned) }))
    );
  }

  async connect(data) {
    const server = this.servers.find((s) => s.clientIdentifier === data.id);
    if (!server) throw new Error("Choose a discovered server.");
    const currentSession = this.app.account.revision,
      generation = ++this.connectionGeneration;
    this.selected = null;
    this.artwork = {};
    this.artworkCache.clear();
    for (const c of P.connections(server, data.allowHTTP === true)) {
      try {
        const base = P.origin(c.uri);
        const result = await this.app.request(base + "/library/sections", server.accessToken);
        if (currentSession !== this.app.account.revision || generation !== this.connectionGeneration) return;
        this.selected = {
          base,
          token: server.accessToken,
          serverID: server.clientIdentifier,
          scope: this.app.account.scope,
          allowHTTP: data.allowHTTP === true
        };
        this.app.api.preferences.set("lastServer", data.id);
        this.app.api.preferences.set("allowHTTP", data.allowHTTP === true);
        this.app.api.preferences.sync();
        await this.app.sync.recover(this.selected);
        if (currentSession !== this.app.account.revision || generation !== this.connectionGeneration) return;
        this.app.send(
          "libraries",
          (result.MediaContainer.Directory || [])
            .filter((s) => ["movie", "show"].indexOf(s.type) !== -1)
            .map((s) => ({ id: P.id(s.key), title: s.title, type: s.type }))
        );
        return;
      } catch (_) {
        if (currentSession !== this.app.account.revision || generation !== this.connectionGeneration) return;
      }
    }
    throw new Error(
      "No reachable server connection. Check the server or enable local HTTP if your server requires it."
    );
  }

  async reconnect() {
    if (!this.app.account.token) throw new Error("Sign in first.");
    const old = this.selected;
    if (!old) {
      this.app.send("notice", { message: "Refresh servers and choose your server again." });
      return;
    }
    const currentSession = this.app.account.revision,
      generation = ++this.connectionGeneration;
    const isCurrent = () =>
      currentSession === this.app.account.revision &&
      generation === this.connectionGeneration &&
      this.selected === old;
    let resources;
    try {
      resources = await this.app.account.resourcesFor(this.app.account.accessToken);
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent()) return;
    const server = resources.find((server) => server.clientIdentifier === old.serverID);
    if (!server) throw new Error("This server is no longer shared with the selected profile.");
    for (const connection of P.connections(server, old.allowHTTP)) {
      try {
        const base = P.origin(connection.uri);
        await this.app.request(base + "/library/sections", server.accessToken);
        if (!isCurrent()) return;
        old.base = base;
        old.token = server.accessToken;
        await this.app.sync.recover(old);
        if (isCurrent()) this.app.send("reconnected", {});
        return;
      } catch (_) {
        if (!isCurrent()) return;
      }
    }
    throw new Error("Server is unavailable. Check its network connection and try again.");
  }

  async browse(data) {
    if (!this.selected) throw new Error("Connect to a server first.");
    const connection = this.selected,
      generation = ++this.browseGeneration,
      start = Number(data.start || 0);
    if (!Number.isInteger(start) || start < 0) throw new Error("Invalid page.");
    const params = { "X-Plex-Container-Start": start, "X-Plex-Container-Size": 60 };
    let container;
    if (["continue", "next", "recent", "search"].includes(data.view) && !data.parent) {
      const searching = data.view === "search";
      const route = searching
        ? "/hubs/search?" + P.query({ query: String(data.search || "").slice(0, 200), limit: start + 60 })
        : "/hubs?" + P.query({ count: start + 60 });
      const result = await this.app.request(connection.base + route, connection.token);
      const hubs = result.MediaContainer.Hub || [];
      const picked = searching
        ? hubs
        : hubs.filter((hub) => {
            const key = String(hub.hubIdentifier || hub.key || "").toLowerCase();
            return data.view === "continue"
              ? key.includes("continue")
              : data.view === "next"
                ? key.includes("ondeck")
                : key.includes("recentlyadded");
          });
      let all = P.uniqueItems(picked.flatMap((hub) => hub.Metadata || [])).filter((item) =>
        ["movie", "episode", "show", "season"].includes(item.type)
      );
      if (data.view === "recent") all.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
      const more = picked.some(
        (hub) => hub.more === true || hub.more === 1 || Number(hub.size) > (hub.Metadata || []).length
      );
      container = { Metadata: all.slice(start, start + 60) };
      if (!more) container.totalSize = all.length;
    } else {
      let route;
      if (data.parent) {
        const id = P.id(data.parent);
        route =
          data.parentType === "playlist"
            ? "/playlists/" + id + "/items"
            : data.parentType === "collection"
              ? "/library/collections/" + id + "/items"
              : "/library/metadata/" + id + "/children";
        if (!["playlist", "collection"].includes(data.parentType)) params.sort = "index:asc";
      } else if (data.view === "playlists") {
        route = "/playlists";
        params.playlistType = "video";
      } else {
        const library = P.id(data.library);
        route = "/library/sections/" + library + (data.view === "collections" ? "/collections" : "/all");
        const sorts = { title: "titleSort:asc", added: "addedAt:desc", year: "year:desc" };
        params.sort = sorts[data.sort] || sorts.title;
        this.app.api.preferences.set("lastLibrary", library);
        this.app.api.preferences.sync();
        if (data.search) params.title = String(data.search).slice(0, 200);
        if (data.watch === "unwatched") params.unwatched = "1";
        if (data.watch === "watched") params.unwatched = "0";
        if (data.watch === "progress") params.inProgress = "1";
        if (data.genre) params.genre = P.id(data.genre);
        if (data.year) {
          if (!/^\d{4}$/.test(String(data.year))) throw new Error("Invalid year.");
          params.year = String(data.year);
        }
      }
      const result = await this.app.request(
        connection.base + route + "?" + P.query(params),
        connection.token
      );
      container = result.MediaContainer;
    }
    if (this.selected !== connection || generation !== this.browseGeneration) return;
    container.Metadata = container.Metadata || [];
    this.rememberArtwork(container.Metadata);
    this.app.send(
      "listing",
      Object.assign(P.listing(container, start, 60), { request: data.request, serverID: connection.serverID })
    );
  }

  async loadFilters(data) {
    if (!this.selected) return;
    const connection = this.selected,
      library = P.id(data.library),
      result = {};
    for (const kind of ["genre", "year"]) {
      try {
        const response = await this.app.request(
          connection.base + "/library/sections/" + library + "/" + kind,
          connection.token
        );
        result[kind] = (response.MediaContainer.Directory || [])
          .filter((entry) => /^\d+$/.test(String(entry.key)))
          .map((entry) => ({ id: String(entry.key), title: entry.title }));
      } catch (_) {
        result[kind] = [];
      }
    }
    if (this.selected === connection)
      this.app.send("filters", Object.assign({ library, serverID: connection.serverID }, result));
  }

  async markWatched(data) {
    if (!this.selected) throw new Error("Connect to a server first.");
    const connection = this.selected,
      id = P.id(data.id);
    const active = () =>
      Array.from(this.app.players.live.values()).some(
        (entry) =>
          entry.connection.scope === connection.scope &&
          entry.connection.serverID === connection.serverID &&
          entry.id === id &&
          entry.state !== "stopped"
      );
    if (active()) throw new Error("Stop this item's IINA player before changing its watched state.");
    await this.app.sync.recover(connection, id);
    if (this.selected !== connection) return;
    if (active()) throw new Error("Stop this item's IINA player before changing its watched state.");
    if (this.app.sync.hasPending(connection, id)) {
      throw new Error("Wait for the playback position to sync, then try changing its watched state again.");
    }
    await this.app.request(
      connection.base +
        "/:/" +
        (data.watched === true ? "scrobble" : "unscrobble") +
        "?" +
        P.query({ key: id, identifier: "com.plexapp.plugins.library" }),
      connection.token,
      "put"
    );
    if (this.selected !== connection) return;
    const item = await this.metadataAt(connection, id);
    if (this.selected !== connection) return;
    this.app.send("item-synced", {
      serverID: connection.serverID,
      item: P.listing({ Metadata: [item] }, 0, 1).items[0]
    });
  }

  async loadDetails(data) {
    if (!this.selected) throw new Error("Connect to a server first.");
    const connection = this.selected,
      item = await this.metadataAt(connection, data.id);
    if (this.selected !== connection) return;
    let options = { versions: [], streams: [], markers: [] };
    if (["movie", "episode"].includes(item.type)) {
      const chosen = Media.chooseVersion(item, data.versionId);
      let partIndex = 0;
      try {
        partIndex = P.resumePoint(item, chosen.choice.index).index;
      } catch (_) {}
      options = {
        versions: Media.versions(item),
        versionId: chosen.choice.id,
        streams: Media.streams(chosen.media.Part[partIndex] || {}),
        markers: Media.markers(item)
      };
    }
    this.app.send(
      "details",
      Object.assign(
        {
          id: String(data.id),
          request: data.request,
          serverID: connection.serverID,
          item: P.listing({ Metadata: [item] }, 0, 1).items[0]
        },
        options
      )
    );
  }

  async loadArtwork(data) {
    const connection = this.selected,
      poster = this.artwork[data.id];
    if (!connection || !poster) {
      this.app.send("artwork-done", { id: data.id, request: data.request });
      return;
    }
    const cacheKey = connection.scope + ":" + connection.serverID + ":" + poster.path;
    const cached = this.artworkCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 600000) {
      this.artworkCache.delete(cacheKey);
      this.artworkCache.set(cacheKey, cached);
      this.app.send("artwork", { id: data.id, request: data.request, image: cached.image });
      this.app.send("artwork-done", { id: data.id, request: data.request });
      return;
    }
    const temp = "@tmp/poster-" + ++this.artworkSerial + ".image";
    let handle;
    try {
      const url =
        connection.base +
        "/photo/:/transcode?" +
        P.query({
          url: poster.path,
          width: "360",
          height: poster.wide ? "203" : "540",
          minSize: "1",
          upscale: "0"
        });
      await this.app.api.http.download(url, temp, { headers: this.app.headers(connection.token) });
      handle = this.app.api.file.handle(temp, "read");
      const bytes = handle.read(2 * 1024 * 1024 + 1);
      if (this.selected !== connection || !bytes || bytes.length > 2 * 1024 * 1024) return;
      const image = P.imageData(bytes);
      if (image) {
        this.artworkCache.set(cacheKey, { image, time: Date.now() });
        while (
          this.artworkCache.size > 80 ||
          Array.from(this.artworkCache.values()).reduce((sum, entry) => sum + entry.image.length, 0) >
            16 * 1024 * 1024
        )
          this.artworkCache.delete(this.artworkCache.keys().next().value);
        this.app.send("artwork", { id: data.id, request: data.request, image });
      }
    } catch (_) {
      /* A missing poster should not interrupt browsing. */
    } finally {
      try {
        if (handle) handle.close();
      } catch (_) {}
      try {
        if (this.app.api.file.exists(temp)) this.app.api.file.delete(temp);
      } catch (_) {}
      this.app.send("artwork-done", { id: data.id, request: data.request });
    }
  }

  async leaves(connection, id, isCurrent = () => true) {
    const all = [];
    for (let start = 0; start < 5000; start += 200) {
      const result = await this.app.request(
        connection.base +
          "/library/metadata/" +
          P.id(id) +
          "/allLeaves?" +
          P.query({ "X-Plex-Container-Start": start, "X-Plex-Container-Size": 200 }),
        connection.token
      );
      if (!isCurrent()) return [];
      const container = result.MediaContainer,
        items = container.Metadata || [];
      all.push(...items);
      if (items.length < 200 || (container.totalSize != null && all.length >= Number(container.totalSize)))
        return P.uniqueItems(all);
    }
    throw new Error("This show is too large to queue at once. Choose a season instead.");
  }
}

module.exports = PlexLibrary;
