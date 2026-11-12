const PlaybackTracker = require("./playback.js");

// One controller per managed Plex window; unrelated IINA windows stay untouched.
class PlexPlayer {
  constructor(api) {
    this.api = api;
    this.lastState = "";
    this.intro = api.menu.item(
      "Skip intro",
      () => {
        const offset = this.tracker.introEnd;
        if (offset !== null) this.applyState({ sessionID: this.tracker.sessionID, offset });
      },
      { enabled: false }
    );
    this.credits = api.menu.item(
      "Skip credits",
      () => {
        const offset = this.tracker.creditsEnd;
        if (offset !== null) this.applyState({ sessionID: this.tracker.sessionID, offset });
      },
      { enabled: false }
    );
    this.tracker = new PlaybackTracker(api, () => this.publishState());
    this.onMessage("play-media", (data) => this.open(data));
    this.onMessage("disable-sync", () => {
      this.tracker.tracking = false;
    });
    this.onMessage("player-state", (data) => this.applyState(data));
    this.onMessage("activate-player", () => {
      api.core.window.miniaturized = false;
    });
    this.onMessage("player-control", (data) => this.control(data.action));
  }

  publishState() {
    if (!this.tracker) return;
    const state = this.tracker.status,
      serialized = JSON.stringify(state);
    this.intro.enabled = state.canSkipIntro;
    this.credits.enabled = state.canSkipCredits;
    if (state.sessionID && serialized !== this.lastState) {
      this.lastState = serialized;
      this.api.global.postMessage("player-state", state);
    }
  }

  onMessage(name, callback) {
    // Global delivery can originate on an HTTP worker. IINA timers run on the main
    // thread; return to the sender before touching player or UI APIs.
    this.api.global.onMessage(name, (data) => {
      setTimeout(() => callback(data), 0);
    });
  }

  open(data) {
    this.api.menu.removeAllItems();
    if ((data.markers || []).some((marker) => marker.type === "intro")) this.api.menu.addItem(this.intro);
    if ((data.markers || []).some((marker) => marker.type === "credits")) this.api.menu.addItem(this.credits);
    try {
      this.tracker.open(data);
    } catch (_) {
      this.api.global.postMessage("playback-error", { sessionID: data.sessionID });
    }
  }

  control(action) {
    if (action === "stop") this.api.core.stop();
    if (action === "activate") this.api.core.window.miniaturized = false;
  }

  applyState(data) {
    if (data.sessionID !== this.tracker.sessionID) return;
    try {
      if (data.offset !== undefined) this.tracker.offset = data.offset;
      if (data.paused !== undefined) this.tracker.paused = data.paused;
    } catch (_) {
      this.api.global.postMessage("player-state-error", { sessionID: data.sessionID });
    }
  }
}

if (iina.global.getLabel() === "plex-playback") new PlexPlayer(iina);
