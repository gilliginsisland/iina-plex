const P = require("./plex.js");
const PlexAccount = require("./account.js");
const PlexLibrary = require("./library.js");
const PlexPlayers = require("./players.js");
const PlaybackQueue = require("./queue.js");
const TimelineSync = require("./sync.js");

class PlexPlugin {
  constructor(api) {
    this.api = api;
    this.clientID = api.preferences.get("clientID");
    if (!this.clientID) {
      this.clientID = "iina-plex-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      api.preferences.set("clientID", this.clientID);
      api.preferences.sync();
    }
    this.account = new PlexAccount(this);
    this.library = new PlexLibrary(this);
    this.players = new PlexPlayers(this);
    this.queue = new PlaybackQueue(this);
    this.sync = new TimelineSync(
      api.http,
      (token) => this.headers(token),
      (name, data) => {
        if (name === "item-synced") {
          try {
            this.send(name, {
              serverID: data.serverID,
              item: P.listing({ Metadata: [data.item] }, 0, 1).items[0]
            });
          } catch (_) {}
        } else this.send(name, data);
      },
      {
        load: () => api.preferences.get("progressJournal") || [],
        save: (records) => {
          api.preferences.set("progressJournal", records);
          api.preferences.sync();
        }
      }
    );
  }

  start() {
    const window = this.api.standaloneWindow;
    window.loadFile("ui/browser.html");
    window.setProperty({ title: "Plex Library", resizable: true });
    window.setFrame(1180, 800);
    this.api.menu.addItem(this.api.menu.item("Browse Plex Library…", () => this.openBrowser()));
    for (const owner of [this.account, this.library, this.players, this.queue]) owner.registerEvents();
    this.guarded("ready", () => this.ready());
    this.guarded("preferences", (data) => this.updatePreferences(data));
    setInterval(() => this.sync.retryClosed(), 10000);
  }

  send(name, data) {
    this.api.standaloneWindow.postMessage(name, data);
  }

  get settings() {
    return {
      audioLanguage: this.api.preferences.get("audioLanguage") || "",
      subtitleLanguage: this.api.preferences.get("subtitleLanguage") || "",
      subtitleMode: this.api.preferences.get("subtitleMode") || "auto",
      autoNext: this.api.preferences.get("autoNext") === true,
      includeSpecials: this.api.preferences.get("includeSpecials") === true
    };
  }

  headers(accessToken) {
    const h = {
      Accept: "application/json",
      "X-Plex-Product": "IINA Plex Library",
      "X-Plex-Version": "0.7.5",
      "X-Plex-Client-Identifier": this.clientID
    };
    if (accessToken) h["X-Plex-Token"] = accessToken;
    return h;
  }

  async request(url, accessToken, method) {
    try {
      const res = await this.api.http[method || "get"](url, { headers: this.headers(accessToken) });
      if (res.statusCode < 200 || res.statusCode >= 300) throw res;
      if (!res.text && res.data == null) return {};
      return res.data || JSON.parse(res.text);
    } catch (error) {
      // Never forward raw networking errors: they can contain credentials and URLs.
      if (error && (error.statusCode === 401 || error.statusCode === 403)) {
        const denied = new Error("Plex denied access. Sign in again or check this library’s permissions.");
        denied.denied = true;
        throw denied;
      }
      throw new Error("Plex could not complete the request. Check your connection and try again.");
    }
  }

  guarded(name, action) {
    this.api.standaloneWindow.onMessage(name, async (data) => {
      const activeSession = this.account.revision;
      try {
        await action(data || {});
      } catch (error) {
        if (activeSession === this.account.revision)
          this.send("failure", { message: error.message, request: data && data.request, operation: name });
      }
    });
  }

  openBrowser() {
    this.api.standaloneWindow.open();
  }

  hideBrowser() {
    const currentSession = this.account.revision;
    setTimeout(() => {
      if (currentSession === this.account.revision) this.api.standaloneWindow.close();
    }, 0);
  }

  async ready() {
    const currentSession = this.account.revision;
    this.send("preferences", this.settings);
    await this.account.restore();
    if (currentSession !== this.account.revision) return;
    this.send("session", this.account.info);
    this.queue.publish();
    this.players.publish();
  }

  async updatePreferences(data) {
    const updates = {};
    for (const key of ["audioLanguage", "subtitleLanguage"]) {
      if (data[key] == null) continue;
      const value = String(data[key]).trim().toLowerCase();
      if (value && !/^[a-z]{2,3}(-[a-z]+)?$/.test(value))
        throw new Error("Use a language code such as en or eng.");
      updates[key] = value;
    }
    if (data.subtitleMode != null && ["auto", "forced", "off"].includes(data.subtitleMode))
      updates.subtitleMode = data.subtitleMode;
    for (const key of ["autoNext", "includeSpecials"]) {
      if (typeof data[key] === "boolean") updates[key] = data[key];
    }
    for (const [key, value] of Object.entries(updates)) this.api.preferences.set(key, value);
    this.api.preferences.sync();
    if (updates.autoNext === false) this.queue.cancelNext();
    this.send("preferences", this.settings);
  }

  disableSync() {
    this.queue.clear();
    this.players.retireAll();
    this.sync.clear();
    this.api.global.postMessage(null, "disable-sync", {});
  }
}

new PlexPlugin(iina).start();
