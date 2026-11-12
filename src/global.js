const PlexAPI = require("./plex-api.js");
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
    this.plex = new PlexAPI(api.http, { clientID: this.clientID, version: "0.7.6" });
    this.account = new PlexAccount(this);
    this.library = new PlexLibrary(this);
    this.players = new PlexPlayers(this);
    this.queue = new PlaybackQueue(this);
    this.sync = new TimelineSync((name, data) => this.send(name, data), {
      load: () => api.preferences.get("progressJournal") || [],
      save: (records) => {
        api.preferences.set("progressJournal", records);
        api.preferences.sync();
      }
    });
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

  get session() {
    return Object.assign({}, this.account.info, {
      serverID: this.api.preferences.get("lastServer"),
      libraryID: this.api.preferences.get("lastLibrary"),
      allowHTTP: this.api.preferences.get("allowHTTP") === true
    });
  }

  guarded(name, action) {
    this.api.standaloneWindow.onMessage(name, async (data) => {
      const activeSession = this.account.revision;
      try {
        await action(data || {});
      } catch (error) {
        if (activeSession === this.account.revision)
          this.send("failure", {
            message: error.message,
            request: data && data.request,
            section: data && data.section,
            operation: name
          });
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
    this.send("session", this.session);
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
