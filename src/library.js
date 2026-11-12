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
    this.app.guarded("home-section", (data) => this.loadHomeSection(data));
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

  rememberArtwork(items, append = false) {
    if (!append) this.artwork = {};
    for (const item of items) {
      try {
        if (item.artworkPath) this.artwork[item.id] = item;
      } catch (_) {}
    }
  }

  async discover() {
    if (!this.app.account.token) throw new Error("Sign in to Plex first.");
    if (this.app.account.needsProfile) throw new Error("Choose your Plex Home profile before browsing.");
    const currentSession = this.app.account.revision,
      generation = ++this.discoveryGeneration;
    let result;
    try {
      await this.app.account.identify();
      result = await this.app.account.profileAPI.resources();
    } catch (error) {
      if (currentSession !== this.app.account.revision || generation !== this.discoveryGeneration) return;
      if (error.denied) {
        this.app.account.revokeAccess();
        return;
      }
      throw error;
    }
    if (currentSession !== this.app.account.revision || generation !== this.discoveryGeneration) return;
    this.servers = result;
    this.app.send(
      "servers",
      this.servers.map((server) => server.snapshot)
    );
  }

  async connect(data) {
    const server = this.servers.find((s) => s.id === data.id);
    if (!server) throw new Error("Choose a discovered server.");
    const currentSession = this.app.account.revision,
      generation = ++this.connectionGeneration;
    this.selected = null;
    this.artwork = {};
    this.artworkCache.clear();
    for (const c of server.connections(data.allowHTTP === true)) {
      try {
        const api = server.connection(c.uri, this.app.account.scope, data.allowHTTP === true);
        const result = await api.request("/library/sections");
        if (currentSession !== this.app.account.revision || generation !== this.connectionGeneration) return;
        this.selected = api;
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
      resources = await this.app.account.profileAPI.resources();
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent()) return;
    const server = resources.find((server) => server.id === old.serverID);
    if (!server) throw new Error("This server is no longer shared with the selected profile.");
    for (const connection of server.connections(old.allowHTTP)) {
      try {
        const api = server.connection(connection.uri, old.scope, old.allowHTTP);
        await api.request("/library/sections");
        if (!isCurrent()) return;
        old.base = api.base;
        old.token = api.token;
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
    if (data.view === "home" && !data.parent) {
      const count = data.homeCount == null ? 60 : Number(data.homeCount);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid Home page size.");
      const hubs = await connection.home(count);
      if (this.selected !== connection || generation !== this.browseGeneration) return;
      const artwork = [];
      for (const hub of hubs) artwork.push(...hub.items.slice(0, count));
      this.rememberArtwork(artwork);
      this.app.send("home", {
        sections: hubs.map((hub) => hub.page(0, count)),
        request: data.request,
        serverID: connection.serverID
      });
      return;
    }
    if (data.view === "search" && !data.parent) {
      const hub = await connection.search(String(data.search || "").slice(0, 200), start + 60);
      if (this.selected !== connection || generation !== this.browseGeneration) return;
      this.rememberArtwork(hub.items.slice(start, start + 60));
      this.app.send(
        "listing",
        Object.assign(hub.page(start, 60), { request: data.request, serverID: connection.serverID })
      );
      return;
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
      const result = await connection.request(route + "?" + P.query(params));
      container = result.MediaContainer;
    }
    if (this.selected !== connection || generation !== this.browseGeneration) return;
    container.Metadata = container.Metadata || [];
    this.rememberArtwork(container.Metadata.map((item) => connection.media(item)));
    this.app.send(
      "listing",
      Object.assign(connection.page(container, start, 60), {
        request: data.request,
        serverID: connection.serverID
      })
    );
  }

  async loadHomeSection(data) {
    if (!this.selected) throw new Error("Connect to a server first.");
    const start = Number(data.start),
      section = data.section;
    if (!["continue", "next", "recent"].includes(section) || !Number.isInteger(start) || start < 0)
      throw new Error("Invalid Home section page.");
    const connection = this.selected,
      generation = this.browseGeneration;
    const hubs = await connection.home(start + 60);
    if (this.selected !== connection || generation !== this.browseGeneration) return;
    const hub = hubs.find((hub) => hub.type === section);
    this.rememberArtwork(hub.items.slice(start, start + 60), true);
    this.app.send(
      "home-section",
      Object.assign({ request: data.request, serverID: connection.serverID }, hub.page(start, 60))
    );
  }

  async loadFilters(data) {
    if (!this.selected) return;
    const connection = this.selected,
      library = P.id(data.library),
      result = {};
    for (const kind of ["genre", "year"]) {
      try {
        const response = await connection.request("/library/sections/" + library + "/" + kind);
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
    if (this.app.players.isActive(connection, id))
      throw new Error("Stop this item's IINA player before changing its watched state.");
    await this.app.sync.recover(connection, id);
    if (this.selected !== connection) return;
    if (this.app.players.isActive(connection, id))
      throw new Error("Stop this item's IINA player before changing its watched state.");
    if (this.app.sync.hasPending(connection, id)) {
      throw new Error("Wait for the playback position to sync, then try changing its watched state again.");
    }
    const media = await connection.media(id).update({ watched: data.watched === true });
    if (this.selected !== connection) return;
    this.app.send("item-synced", { serverID: connection.serverID, item: media.snapshot });
  }

  async loadDetails(data) {
    if (!this.selected) throw new Error("Connect to a server first.");
    const connection = this.selected,
      media = await connection.media(data.id).load(),
      item = media.data;
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
          item: media.snapshot
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
    const cacheKey = connection.scope + ":" + connection.serverID + ":" + poster.artworkPath;
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
      await poster.downloadArtwork(temp);
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
      const result = await connection.request(
        "/library/metadata/" +
          P.id(id) +
          "/allLeaves?" +
          P.query({ "X-Plex-Container-Start": start, "X-Plex-Container-Size": 200 })
      );
      if (!isCurrent()) return [];
      const container = result.MediaContainer,
        items = container.Metadata || [];
      all.push(...items);
      if (items.length < 200 || (container.totalSize != null && all.length >= Number(container.totalSize)))
        return P.uniqueItems(all).map((item) => connection.media(item));
    }
    throw new Error("This show is too large to queue at once. Choose a season instead.");
  }
}

module.exports = PlexLibrary;
