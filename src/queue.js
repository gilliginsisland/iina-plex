const P = require("./plex.js");

// Owns queue ordering, preparation, cancellation and the automatic-next countdown.
class PlaybackQueue {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.playerID = null;
    this.nextTimer = null;
    this.revision = 0;
    this.generation = 0;
    this.preparation = 0;
    this.busy = false;
  }

  registerEvents() {
    this.app.guarded("play", (data) => this.play(data));
    this.app.guarded("queue-add", (data) => this.add(data));
    this.app.guarded("queue-action", (data) => this.act(data));
    this.app.guarded("queue-series", (data) => this.playSeries(data));
  }

  get snapshot() {
    return {
      busy: this.busy,
      revision: this.revision,
      items: this.items.map((entry, index) => ({
        id: entry.id,
        title: entry.title,
        index,
        serverID: entry.connection.serverID
      }))
    };
  }

  publish() {
    this.revision++;
    this.app.send("queue", this.snapshot);
  }

  playerClosed(playerID) {
    if (this.playerID !== playerID) return;
    this.playerID = null;
    this.invalidate();
    this.publish();
  }

  playerStopped(playerID) {
    if (this.playerID !== playerID) return;
    if (this.busy) {
      this.interrupt(playerID);
    } else this.cancelNext();
  }

  interrupt(playerID) {
    if (this.playerID !== playerID) return;
    this.invalidate();
    this.publish();
  }

  scheduleNext(playerID) {
    if (this.playerID !== playerID || !this.items.length || !this.app.settings.autoNext) return false;
    this.cancelNext();
    const revision = this.revision;
    this.app.send("up-next", { title: this.items[0].title, seconds: 5 });
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      if (revision === this.revision && this.playerID === playerID) {
        this.advance(playerID, 0, false).catch((error) =>
          this.app.send("notice", { message: error.message })
        );
      }
    }, 5000);
    return true;
  }

  cancelNext() {
    if (this.nextTimer !== null) clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this.app.send("up-next", null);
  }

  invalidate() {
    this.generation++;
    this.preparation++;
    this.busy = false;
    this.cancelNext();
  }

  clear() {
    this.invalidate();
    this.items = [];
    this.playerID = null;
    this.publish();
  }

  async play(data) {
    if (!this.app.library.selected) throw new Error("Connect to a server first.");
    const generation = this.generation;
    this.cancelNext();
    const entry = await this.app.players.launch(this.app.library.selected, data.id, data);
    if (entry && this.items.length && generation === this.generation) this.playerID = entry.playerID;
  }

  async advance(playerID = this.playerID, index = 0, hideLibrary = true) {
    if (this.busy || !this.items[index]) return;
    const record = this.items[index],
      generation = this.generation;
    const isCurrent = () => generation === this.generation;
    if (record.connection.scope !== this.app.account.scope)
      throw new Error("Queue belongs to a different profile.");
    if (playerID != null && !this.app.players.find(playerID)) playerID = null;
    this.busy = true;
    this.cancelNext();
    this.publish();
    try {
      const mayOpen = () => isCurrent() && (hideLibrary || this.app.settings.autoNext);
      const entry = await this.app.players.launch(record.connection, record.id, record.options, {
        playerID,
        hideLibrary,
        isCurrent: mayOpen
      });
      if (!entry || !isCurrent()) return;
      if (playerID != null && entry.playerID !== playerID) this.app.players.stop(playerID);
      const position = this.items.indexOf(record);
      if (position >= 0) this.items.splice(position, 1);
      this.playerID = entry.playerID;
    } finally {
      if (isCurrent()) {
        this.busy = false;
        this.publish();
      }
    }
  }

  async add(data) {
    if (!this.app.library.selected) throw new Error("Connect to a server first.");
    const connection = this.app.library.selected,
      generation = this.generation;
    const isCurrent = () => this.app.library.selected === connection && generation === this.generation;
    let item;
    try {
      item = await this.app.library.metadataAt(connection, data.id);
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent()) return;
    if (!["movie", "episode"].includes(item.type)) throw new Error("Choose a movie or episode.");
    const record = {
      id: P.id(item.ratingKey),
      title: item.title,
      connection,
      options: { versionId: data.versionId, audioId: data.audioId, subtitleId: data.subtitleId }
    };
    this.cancelNext();
    if (data.position === "next") this.items.unshift(record);
    else this.items.push(record);
    this.playerID = this.playerID || this.app.players.defaultPlayerID;
    this.publish();
    this.app.send("notice", { message: "Added “" + item.title + "” to the queue." });
  }

  async act(data) {
    if (data.revision != null && Number(data.revision) !== this.revision)
      throw new Error("Queue changed. Try again.");
    if (data.action === "clear") {
      this.clear();
      return;
    }
    if (data.action === "cancel-next") {
      this.cancelNext();
      return;
    }
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length)
      throw new Error("Queue changed. Try again.");
    if (data.action === "play") {
      await this.advance(this.playerID, index);
      return;
    }
    if (this.busy) throw new Error("Wait for the queued video to open.");
    this.cancelNext();
    if (data.action === "remove") this.items.splice(index, 1);
    else if (data.action === "up" && index > 0)
      [this.items[index - 1], this.items[index]] = [this.items[index], this.items[index - 1]];
    else if (data.action === "down" && index < this.items.length - 1)
      [this.items[index + 1], this.items[index]] = [this.items[index], this.items[index + 1]];
    this.publish();
  }

  async playSeries(data) {
    if (!this.app.library.selected) throw new Error("Connect to a server first.");
    const connection = this.app.library.selected,
      generation = this.revision,
      preparation = ++this.preparation;
    const isCurrent = () =>
      this.app.library.selected === connection &&
      generation === this.revision &&
      preparation === this.preparation;
    let parent, episodes;
    try {
      parent = await this.app.library.metadataAt(connection, data.id);
      if (!isCurrent()) return;
      if (!["show", "season", "episode"].includes(parent.type)) throw new Error("Choose a show or season.");
      const id =
        parent.type === "episode" ? parent.grandparentRatingKey || parent.parentRatingKey : parent.ratingKey;
      episodes = (await this.app.library.leaves(connection, id, isCurrent)).filter(
        (item) => item.type === "episode"
      );
    } catch (error) {
      if (isCurrent()) throw error;
      return;
    }
    if (!isCurrent()) return;
    if (parent.type === "show" && !this.app.settings.includeSpecials)
      episodes = episodes.filter((item) => Number(item.parentIndex) !== 0);
    episodes.sort(
      (a, b) =>
        Number(a.parentIndex || 0) - Number(b.parentIndex || 0) || Number(a.index || 0) - Number(b.index || 0)
    );
    if (parent.type === "episode") {
      const index = episodes.findIndex((item) => String(item.ratingKey) === String(parent.ratingKey));
      if (index < 0) throw new Error("This episode is no longer in the show. Refresh and try again.");
      episodes = episodes.slice(index);
    }
    if (!isCurrent()) return;
    if (!episodes.length) throw new Error("No playable episodes found.");
    const prepared = episodes.map((item) => ({
      id: P.id(item.ratingKey),
      title: (item.grandparentTitle ? item.grandparentTitle + " · " : "") + item.title,
      connection,
      options: {}
    }));
    this.clear();
    this.items = prepared;
    this.publish();
    await this.advance(null);
  }
}

module.exports = PlaybackQueue;
