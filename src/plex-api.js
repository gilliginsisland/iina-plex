const P = require("./plex.js");
const Media = require("./media.js");
const { PlexServer, PlexHub, PlexMedia } = require("./plex-models.js");

// A client owns one credential/origin pair. Resources created by it retain that client.
class PlexAPI {
  constructor(
    http,
    {
      clientID,
      version,
      base = "https://plex.tv",
      token = null,
      serverID = null,
      scope = "",
      allowHTTP = false
    }
  ) {
    this.http = http;
    this.clientID = clientID;
    this.version = version;
    this.base = P.origin(base);
    this.token = token;
    this.serverID = serverID;
    this.scope = scope;
    this.allowHTTP = allowHTTP;
  }

  get headers() {
    const headers = {
      Accept: "application/json",
      "X-Plex-Product": "IINA Plex Library",
      "X-Plex-Version": this.version,
      "X-Plex-Client-Identifier": this.clientID
    };
    if (this.token) headers["X-Plex-Token"] = this.token;
    return headers;
  }

  withToken(token) {
    return new PlexAPI(this.http, {
      clientID: this.clientID,
      version: this.version,
      base: this.base,
      token,
      serverID: this.serverID,
      scope: this.scope,
      allowHTTP: this.allowHTTP
    });
  }

  server(data, uri, scope, allowHTTP) {
    return new PlexAPI(this.http, {
      clientID: this.clientID,
      version: this.version,
      base: uri,
      token: data.accessToken,
      serverID: data.clientIdentifier,
      scope,
      allowHTTP
    });
  }

  media(data) {
    return new PlexMedia(this, data);
  }

  url(path) {
    if (typeof path !== "string" || !/^\/(?!\/)/.test(path) || /[\\\u0000-\u001f\u007f#]/.test(path))
      throw new Error("Invalid Plex resource path.");
    return this.base + path;
  }

  async request(path, { method = "get", headers = {}, format = "json" } = {}) {
    const url = this.url(path);
    try {
      const response = await this.http[method](url, { headers: Object.assign({}, headers, this.headers) });
      if (!response || response.statusCode < 200 || response.statusCode >= 300) throw response;
      if (format === "none") return {};
      if (response.data != null) return response.data;
      const text = response.text || "";
      if (!text) return {};
      if (format === "home" && text.trim().startsWith("<"))
        return { users: Media.xmlAttributes(text, "User"), user: Media.xmlAttributes(text, "user")[0] };
      return JSON.parse(text);
    } catch (error) {
      if (error && (error.statusCode === 401 || error.statusCode === 403)) {
        const denied = new Error("Plex denied access. Sign in again or check this library’s permissions.");
        denied.denied = true;
        throw denied;
      }
      throw new Error("Plex could not complete the request. Check your connection and try again.");
    }
  }

  async download(path, destination) {
    const url = this.url(path);
    try {
      await this.http.download(url, destination, { headers: this.headers });
    } catch (_) {
      throw new Error("Plex could not download this resource. Check your connection and try again.");
    }
  }

  async resources() {
    const data = await this.request("/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1");
    if (!Array.isArray(data)) throw new Error("Plex did not return a valid server list. Try again.");
    const servers = [];
    for (const resource of data) {
      if (
        resource &&
        String(resource.provides || "")
          .split(",")
          .includes("server") &&
        resource.accessToken &&
        resource.clientIdentifier
      )
        servers.push(new PlexServer(this, resource));
    }
    return servers;
  }

  async hubs(count = 60, query = null) {
    const path =
      query === null ? "/hubs?" + P.query({ count }) : "/hubs/search?" + P.query({ query, limit: count });
    const result = await this.request(path),
      hubs = [];
    for (const source of result.MediaContainer.Hub || []) hubs.push(new PlexHub(this, [source]));
    return hubs;
  }

  async home(count = 60) {
    const hubs = await this.hubs(count),
      sections = [];
    for (const type of ["continue", "next", "recent"]) {
      const sources = [];
      for (const hub of hubs) if (hub.type === type) sources.push(...hub.sources);
      sections.push(new PlexHub(this, sources, type));
    }
    return sections;
  }

  async search(query, count) {
    const sources = [];
    for (const hub of await this.hubs(count, query)) sources.push(...hub.sources);
    return new PlexHub(this, sources, "search");
  }

  page(container, start, pageSize) {
    const reported =
      container.totalSize == null || String(container.totalSize).trim() === ""
        ? NaN
        : Number(container.totalSize);
    const total = Number.isInteger(reported) && reported >= 0 ? reported : null,
      items = [];
    for (const item of container.Metadata || []) items.push(this.media(item).snapshot);
    return {
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

module.exports = PlexAPI;
