/* Browser UI: authored directly as one native script; no build step. */

// Called by a static field initializer; the field retains the registered DOM element.

function html(strings, ...values) {
  if (values.length) throw new TypeError("html templates are static; update dynamic content through component properties.");
  const template = document.createElement("template");
  template.setAttribute("data-plex-template", "");
  template.innerHTML = strings[0];
  document.body.append(template);
  return template;
}

/* A small light-DOM base. Reflected attributes are the source of truth. */
class PlexElement extends HTMLElement {
  static properties = {};
  static template = null;

  static define(name) {
    const parent = Object.getPrototypeOf(this);
    this.propertyDefinitions = Object.assign({}, parent.propertyDefinitions || {}, this.properties);
    for (const [key, declaration] of Object.entries(this.propertyDefinitions)) {
      const definition = Object.assign({ type: String, default: "", attribute: key.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()) }, declaration);
      this.propertyDefinitions[key] = definition;
      Object.defineProperty(this.prototype, key, {
        configurable: true,
        get() { return this.readProperty(key); },
        set(value) { this.writeProperty(key, value); }
      });
    }
    customElements.define(name, this);
  }

  static get observedAttributes() {
    return Object.values(this.propertyDefinitions || {}).map(def => def.attribute).filter(name => name !== false);
  }

  constructor() {
    super();
    this._values = new Map();
    this._batchDepth = 0;
    this._dirty = false;
    this._mounted = false;
    this._ready = false;
  }

  normalize(value, definition) {
    if (value == null) return definition.default;
    if (definition.type === Boolean) return Boolean(value);
    if (definition.type === Number) {
      const number = Number(value);
      return Number.isFinite(number) ? number : definition.default;
    }
    return String(value);
  }

  readProperty(key) {
    const definition = this.constructor.propertyDefinitions[key];
    if (definition.attribute === false) return this._values.has(key) ? this._values.get(key) : definition.default;
    if (definition.type === Boolean) return this.hasAttribute(definition.attribute);
    return this.normalize(this.getAttribute(definition.attribute), definition);
  }

  writeProperty(key, value) {
    const definition = this.constructor.propertyDefinitions[key];
    const normalized = this.normalize(value, definition);
    if (definition.attribute === false) {
      if (Object.is(this.readProperty(key), normalized)) return;
      this._values.set(key, normalized);
      this.invalidate();
    } else if (definition.type === Boolean) {
      this.toggleAttribute(definition.attribute, normalized);
    } else if (value == null) {
      this.removeAttribute(definition.attribute);
    } else if (this.getAttribute(definition.attribute) !== String(normalized)) {
      this.setAttribute(definition.attribute, String(normalized));
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) this.invalidate();
  }

  connectedCallback() {
    this._ready = false;
    if (!this._mounted) {
      if (this.constructor.template) {
        this.append(this.constructor.template.content.cloneNode(true));
      }
      this._mounted = true;
    }
    this._listeners = new AbortController();
    // Preserve properties assigned before customElements.define upgraded this node.
    this.batch(() => {
      for (const key of Object.keys(this.constructor.propertyDefinitions)) {
        if (Object.prototype.hasOwnProperty.call(this, key)) {
          const value = this[key]; delete this[key]; this[key] = value;
        }
      }
    });
    this.connected();
    this._ready = true;
    this.invalidate();
  }

  disconnectedCallback() {
    this._ready = false;
    this._listeners.abort();
    this.disconnected();
  }

  connected() {}
  disconnected() {}
  render() {}

  invalidate() {
    this._dirty = true;
    if (!this._batchDepth && this._ready && this.isConnected) {
      this._dirty = false;
      this.render();
    }
  }

  batch(action) {
    this._batchDepth++;
    try { action(); }
    finally {
      this._batchDepth--;
      if (this._dirty && !this._batchDepth) this.invalidate();
    }
    return this;
  }

  setProperties(values) {
    return this.batch(() => {
      for (const [key, value] of Object.entries(values)) {
        if (Object.prototype.hasOwnProperty.call(this.constructor.propertyDefinitions, key)) this[key] = value;
      }
    });
  }

  part(name) { return this.querySelector('[data-part="' + name + '"]'); }
  listen(target, name, handler, options = {}) {
    target.addEventListener(name, handler, Object.assign({}, options, { signal: this._listeners.signal }));
  }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); }
}

const mediaProperties = {
  ratingKey: { attribute: "rating-key" }, mediaTitle: { attribute: "media-title" }, mediaType: { attribute: "media-type" },
  year: {}, edition:{}, summary: {}, duration: { type: Number, default: 0 }, index: { type: Number, default: 0 },
  rating: {}, score: {}, watched: { type: Boolean, default: false }, progress: { type: Number, default: 0 },
  parentIndex: { type: Number, default: 0 }, libraryId: {}, showId: {}, opening: { type: Boolean, default: false }, episodes: { type: Number, default: 0 }, parentTitle: {}, playable: { type: Boolean, default: false },
  // Large image payloads are deliberately property-only, not copied into an HTML attribute.
  artwork: { attribute: false }
};

class PlexLibraryItem extends PlexElement {
  static properties = { ratingKey: { attribute: "rating-key" }, mediaTitle: { attribute: "media-title" }, mediaType: { attribute: "media-type" }, selected: { type: Boolean, default: false } };
  static template = html`
    <button type="button" data-part="button"></button>
  `;
  connected() {
    this.setAttribute("role", "listitem");
    this.listen(this.part("button"), "click", () => this.emit("library-activate", { item: this }));
  }
  render() {
    const button = this.part("button");
    button.textContent = (this.mediaType === "movie" ? "▤    " : "▣    ") + this.mediaTitle;
    button.classList.toggle("active", this.selected);
    if (this.selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
}
PlexLibraryItem.define("plex-library-item");

class PlexLibraryList extends PlexElement {
  static properties = { value: {} };
  connected() {
    this.setAttribute("role", "list");
    this.listen(this, "library-activate", event => {
      if (event.detail.item.parentElement !== this) return;
      const changed = this.value !== event.detail.item.ratingKey;
      this.value = event.detail.item.ratingKey;
      if (!changed) this.emit("library-change", { item: event.detail.item });
    });
    this._observer = new MutationObserver(() => this.invalidate());
    this._observer.observe(this, { childList: true });
  }
  disconnected() { this._observer.disconnect(); }
  render() {
    let selected = null;
    for (const item of this.children) if (item instanceof PlexLibraryItem) {
      item.selected = item.ratingKey === this.value;
      if (item.selected) selected = item;
    }
    if (!selected) this._announcedValue = null;
    else if (this._announcedValue !== this.value) {
      this._announcedValue = this.value;
      this.emit("library-change", { item: selected });
    }
  }
}
PlexLibraryList.define("plex-library-list");

class PlexCrumb extends PlexElement {
  static properties = { ratingKey:{attribute:"rating-key"},mediaTitle:{attribute:"media-title"},mediaType:{attribute:"media-type"},pageStart:{type:Number,default:0},scrollPosition:{type:Number,default:0},searchText:{},sortValue:{default:"title"},watchValue:{},genreValue:{},yearValue:{} };
  static template = html`
    <button type="button" data-part="button"></button>
  `;
  connected() {
    this.setAttribute("role", "listitem");
    this.listen(this.part("button"), "click", () => this.emit("crumb-activate", { item: this }));
  }
  render() { this.part("button").textContent = this.mediaTitle; }
}
PlexCrumb.define("plex-crumb");

class PlexBreadcrumbs extends PlexElement {
  connected() {
    this.setAttribute("role", "list");
    this.listen(this, "crumb-activate", event => {
      const crumb = event.detail.item;
      if (crumb.parentElement !== this) return;
      while (crumb.nextElementSibling) crumb.nextElementSibling.remove();
      this.emit("path-change", {});
    });
  }
}
PlexBreadcrumbs.define("plex-breadcrumbs");

class PlexMediaItem extends PlexElement {
  static properties = mediaProperties;
  static template = html`
    <button type="button" class="poster" data-part="poster">
      <img data-part="image" alt="" hidden>
      <span class="monogram" data-part="monogram"></span>
      <span class="poster-shade"><span class="poster-action" data-part="action"></span></span>
      <span class="badge" data-part="badge" hidden></span>
      <span class="progress" data-part="progress" hidden><span class="progress-fill" data-part="progress-fill"></span></span>
    </button>
    <button type="button" class="card-title" data-part="title"></button>
    <div class="card-meta" data-part="meta"></div>
  `;
  connected() {
    this.setAttribute("role", "listitem"); this.classList.add("card");
    this.listen(this.part("poster"), "click", () => this.emit(this.playable ? "media-play" : "media-browse", { item: this }));
    this.listen(this.part("title"), "click", () => this.emit(this.playable ? "media-details" : "media-browse", { item: this }));
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "rating-key" && oldValue !== null && oldValue !== newValue) {
      this.artwork = ""; this.removeAttribute("artwork-state");
    }
    super.attributeChangedCallback(name, oldValue, newValue);
  }
  render() {
    this.classList.toggle("episode", this.mediaType === "episode");
    this.part("poster").disabled = this.opening; this.part("title").disabled = this.opening;
    this.part("poster").setAttribute("aria-label", (this.playable ? "Play " : "Browse ") + this.mediaTitle);
    this.part("monogram").textContent = this.mediaTitle.split(/\s+/).slice(0, 2).map(word => word[0]).join("");
    this.part("action").textContent = this.playable ? "▶" : "›";
    this.part("title").textContent = this.mediaTitle; this.part("title").title = this.mediaTitle;
    this.part("meta").textContent = this.mediaType === "episode" ? "Episode " + this.index + (this.duration ? " · " + Math.round(this.duration / 60000) + " min" : "") : [this.year,this.edition].filter(Boolean).join(" · ") || (this.episodes ? this.episodes + (["show","season"].includes(this.mediaType)?" episodes":" items") : "");
    this.part("badge").hidden = !this.watched && !this.episodes;
    this.part("badge").textContent = this.watched ? "✓" : this.episodes;
    const progress = Math.max(0, Math.min(1, this.progress));
    this.part("progress").hidden = !(progress > 0 && progress < 1);
    this.part("progress-fill").style.width = Math.round(progress * 100) + "%";
    const image = this.part("image");
    image.hidden = !this.artwork;
    if (this.artwork && image.getAttribute("src") !== this.artwork) image.src = this.artwork;
    else if (!this.artwork) image.removeAttribute("src");
  }
}
PlexMediaItem.define("plex-media-item");

class PlexMediaList extends PlexElement {
  static properties = {
    request: { type: Number, default: 0 }, pageStart: { type: Number, default: 0 },
    total: { type: Number, default: 0 }, nextStart: { type: Number, default: -1 }
  };
  constructor() { super(); this._artworkJobs = new Set(); }
  connected() {
    this.setAttribute("role", "list");
    this._intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this._intersection.unobserve(entry.target);
        entry.target.setAttribute("artwork-state", "queued");
      }
      this.pumpArtwork();
    }, { root: this.closest("main"), rootMargin: "180px" });
    this._childrenObserver = new MutationObserver(() => this.invalidate());
    this._childrenObserver.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["media-type", "rating-key"] });
  }
  disconnected() {
    this._intersection.disconnect(); this._childrenObserver.disconnect(); this._artworkJobs.clear();
    for (const item of this.children) {
      if (["queued", "loading"].includes(item.getAttribute("artwork-state"))) item.removeAttribute("artwork-state");
    }
  }
  findItem(key) {
    for (const child of this.children) if (child instanceof PlexMediaItem && child.ratingKey === String(key)) return child;
    return null;
  }
  findItems(key) {
    return Array.from(this.children).filter(child => child instanceof PlexMediaItem && child.ratingKey === String(key));
  }
  render() {
    let count = 0, episodes = true;
    for (const item of this.children) {
      if (!(item instanceof PlexMediaItem)) continue;
      count++; episodes = episodes && item.mediaType === "episode";
      if (!item.artwork && !item.hasAttribute("artwork-state")) this._intersection.observe(item);
    }
    this.classList.toggle("episodes", count > 0 && episodes);
    this.emit("list-state-change", { count });
    this.pumpArtwork();
  }
  pumpArtwork() {
    if (!this.isConnected) return;
    for (const item of this.children) {
      if (this._artworkJobs.size >= 4) break;
      if (!(item instanceof PlexMediaItem) || item.getAttribute("artwork-state") !== "queued") continue;
      const key = this.request + ":" + item.ratingKey;
      if (this._artworkJobs.has(key)) continue;
      item.setAttribute("artwork-state", "loading"); this._artworkJobs.add(key);
      this.emit("artwork-request", { id: item.ratingKey, request: this.request });
    }
  }
  acceptArtwork(data) {
    if (data.request !== this.request || !/^data:image\/(jpeg|png|webp);base64,/.test(data.image || "")) return;
    for (const item of this.findItems(data.id)) {
      item.artwork = data.image; item.setAttribute("artwork-state", "loaded");
    }
  }
  finishArtwork(data) {
    this._artworkJobs.delete(data.request + ":" + data.id);
    if (data.request === this.request) {
      for (const item of this.findItems(data.id)) {
        if (!item.artwork) item.setAttribute("artwork-state", "missing");
      }
    }
    this.pumpArtwork();
  }
}
PlexMediaList.define("plex-media-list");

class PlexMediaDetails extends PlexElement {
  static properties = Object.assign({}, mediaProperties, { open: { type: Boolean, default: false }, request: {type:Number,default:0}, loading:{type:Boolean,default:false} });
  static template = html`
    <dialog id="detail" data-part="dialog" aria-labelledby="detail-title">
      <button id="close-detail" type="button" class="close" data-part="close" aria-label="Close details">×</button>
      <div class="detail-layout"><div id="detail-cover"><img data-part="image" alt="" hidden><span class="monogram" data-part="monogram"></span></div><div class="detail-copy"><p class="eyebrow" id="detail-type" data-part="type"></p><h2 id="detail-title" data-part="title"></h2><p id="detail-meta" data-part="meta"></p><p id="detail-summary" data-part="summary"></p><div class="track-options" data-part="options">
        <label>Version<select data-part="version"></select></label>
        <label>Audio<select data-part="audio"></select></label>
        <label>Subtitles<select data-part="subtitle"></select></label>
      </div>
      <p data-part="loading" class="hint" hidden>Loading playback choices…</p>
      <button id="detail-play" type="button" class="primary" data-part="play">▶ Play in IINA</button><button type="button" data-part="restart">Play from beginning</button>
      <div class="detail-actions"><button type="button" data-part="queue">Add to queue</button><button type="button" data-part="next">Play next</button><button type="button" data-part="watched">Mark watched</button></div></div></div>
    </dialog>
  `;
  connected() {
    this.listen(this.part("close"), "click", () => this.open = false);
    this.listen(this.part("dialog"), "close", () => this.open = false);
    this.listen(this.part("play"), "click", () => this.emit("media-play", { item: this }));
    this.listen(this.part("restart"), "click", () => this.emit("media-play", { item: this, restart: true }));
    this.listen(this.part("version"),"change",()=>this.emit("playback-options",{item:this,versionId:this.part("version").value}));
    this.listen(this.part("queue"),"click",()=>this.emit("media-queue",{item:this,position:"end"}));
    this.listen(this.part("next"),"click",()=>this.emit("media-queue",{item:this,position:"next"}));
    this.listen(this.part("watched"),"click",()=>this.emit("media-watched",{item:this,watched:!this.watched}));
  }
  disconnected() { if (this.part("dialog").open) this.part("dialog").close(); }
  playbackOptions() { return {versionId:this.part("version").value,audioId:this.part("audio").value,subtitleId:this.part("subtitle").value}; }
  configure(data) {
    const fill=(name,entries,initial)=>{
      const select=this.part(name);select.replaceChildren();
      for(const entry of entries){const option=document.createElement("option");option.value=entry.id;option.textContent=entry.title;select.append(option);}
      select.value=initial;if(select.selectedIndex<0&&select.options.length)select.selectedIndex=0;
    };
    fill("version",data.versions||[],data.versionId||"");
    const streams=data.streams||[];
    fill("audio",[{id:"",title:"Plex / language preference"},...streams.filter(s=>s.type===2)],"");
    fill("subtitle",[{id:"",title:"Plex / language preference"},{id:"none",title:"Off"},...streams.filter(s=>s.type===3)],"");
    this.loading=false;
  }
  copyFrom(item) {
    if(this.ratingKey!==item.ratingKey){
      for(const name of ["version","audio","subtitle"])this.part(name).replaceChildren();
    }
    this.batch(() => { for (const key of Object.keys(mediaProperties)) this[key] = item[key]; });
  }
  render() {
    const image = this.part("image"); image.hidden = !this.artwork;
    if (this.artwork && image.getAttribute("src") !== this.artwork) image.src = this.artwork;
    else if (!this.artwork) image.removeAttribute("src");
    this.part("monogram").hidden = !!this.artwork;
    this.part("monogram").textContent = this.mediaTitle.split(/\s+/).slice(0, 2).map(word => word[0]).join("");
    this.part("type").textContent = this.mediaType === "episode" ? this.parentTitle || "Episode" : "Movie";
    this.part("title").textContent = this.mediaTitle;
    this.part("meta").textContent = [this.year,this.edition, this.rating, this.duration ? Math.round(this.duration / 60000) + " min" : "", this.score ? "★ " + this.score : "", this.watched ? "Watched" : ""].filter(Boolean).join("  ·  ");
    this.part("loading").hidden=!this.loading;
    this.part("options").hidden=!this.playable;
    this.part("watched").textContent=this.watched?"Mark unwatched":"Mark watched";
    for(const name of ["play","restart","queue","next"])this.part(name).disabled=this.opening||this.loading;
    for(const name of ["version","audio","subtitle"])this.part(name).disabled=this.loading;
    this.part("play").textContent = this.progress > 0 && this.progress < 1 ? "▶ Resume at " + Math.floor(this.progress * this.duration / 60000) + ":" + String(Math.floor(this.progress * this.duration / 1000) % 60).padStart(2, "0") : "▶ Play in IINA";
    this.part("summary").textContent = this.summary || "No description available.";
    const dialog = this.part("dialog");
    if (this.open && !dialog.open) dialog.showModal();
    else if (!this.open && dialog.open) dialog.close();
  }
}
PlexMediaDetails.define("plex-media-details");

/* Coordinates IINA messages; custom elements own presentation and DOM state. */
class PlexQueueItem extends PlexElement {
  static properties={queueIndex:{type:Number,default:0},mediaTitle:{},ratingKey:{attribute:"rating-key"}};
  static template=html`<button type="button" data-part="play" class="queue-title"></button><span class="queue-actions"><button type="button" data-part="up" aria-label="Move up">↑</button><button type="button" data-part="down" aria-label="Move down">↓</button><button type="button" data-part="remove" aria-label="Remove from queue">×</button></span>`;
  connected(){this.setAttribute("role","listitem");for(const action of ["play","up","down","remove"])this.listen(this.part(action),"click",()=>this.emit("queue-action",{action,index:this.queueIndex}));}
  render(){this.part("play").textContent=(this.queueIndex+1)+". "+this.mediaTitle;this.part("up").disabled=this.queueIndex===0;}
}
PlexQueueItem.define("plex-queue-item");
class PlexPlayQueue extends PlexElement { connected(){this.setAttribute("role","list");} }
PlexPlayQueue.define("plex-play-queue");

class PlexBrowser extends PlexElement {
  static template=html`
    <aside>
      <div class="brand">plex<span>›</span><small>for IINA</small></div>
      <section id="account"><h2>All your favorites.<br>One place.</h2><p>Connect your Plex account to browse your movies and shows.</p><button id="sign-in" class="primary">Sign in with Plex ↗</button><p class="hint">Your login is saved securely in macOS Keychain.</p></section>
      <section id="navigation" hidden>
        <button id="choose-profile" hidden>Switch profile</button>
        <label class="eyebrow" for="servers">YOUR MEDIA SERVER</label><select id="servers"><option value="">Choose a server</option></select>
        <nav id="discovery" aria-label="Discover"><button data-view="continue">Continue Watching</button><button data-view="next">Up Next</button><button data-view="recent">Recently Added</button></nav>
        <p class="eyebrow library-label">PINNED LIBRARIES</p><plex-library-list id="libraries" aria-label="Plex libraries"></plex-library-list>
        <details class="connection-settings"><summary>Preferences & connection</summary>
          <label class="http-option"><input type="checkbox" id="allow-http"> Allow unencrypted local connections</label>
          <label class="preference">Audio language<input id="audio-language" placeholder="Plex default, or en"></label>
          <label class="preference">Subtitle language<input id="subtitle-language" placeholder="Plex default, or en"></label>
          <label class="preference">Subtitles<select id="subtitle-mode"><option value="auto">Plex / language preference</option><option value="forced">Forced only</option><option value="off">Off</option></select></label>
          <label class="http-option"><input type="checkbox" id="auto-next"> Automatically play queued episodes</label>
          <label class="http-option"><input type="checkbox" id="include-specials"> Include specials when playing a show</label>
          <button id="refresh">Refresh servers</button><button id="reconnect">Reconnect</button>
        </details>
      </section>
      <div class="aside-bottom"><span class="live-dot"></span> Playing with IINA <button id="sign-out" hidden>Sign out</button></div>
    </aside>
    <main>
      <header><div class="heading"><span class="eyebrow">YOUR MEDIA</span><h1 id="title">Your own big screen.</h1></div>
        <form id="search-form" hidden role="search"><label class="sr-only" for="search">Search</label><input id="search" type="search" placeholder="Search titles"><select id="search-scope" aria-label="Search scope"><option value="library">This library</option><option value="all">All libraries</option></select><button type="submit">Search</button></form>
      </header>
      <div class="library-bar"><span class="tab active">Library</span><span id="count"></span><label class="sort-control" for="sort">Sort by<select id="sort"><option value="title">Title</option><option value="added">Recently added</option><option value="year">Release year</option></select></label></div>
      <div class="toolbar"><button id="back" aria-label="Go back">←</button><plex-breadcrumbs id="breadcrumbs" aria-label="Breadcrumb"></plex-breadcrumbs><button id="refresh-view">Refresh</button><button id="play-season" hidden>Play season</button><button id="collections">Collections</button><button id="playlists">Playlists</button></div>
      <div id="filters" class="filters" hidden><select id="watch-filter" aria-label="Watch status"><option value="">All titles</option><option value="unwatched">Unwatched</option><option value="progress">In progress</option><option value="watched">Watched</option></select><select id="genre-filter" aria-label="Genre"><option value="">All genres</option></select><select id="year-filter" aria-label="Year"><option value="">All years</option></select><button id="reset-filters">Reset filters</button></div>
      <p id="notice" role="status" hidden></p><p id="status" role="status" aria-live="polite">Sign in to see your Plex servers and libraries.</p>
      <section id="now-playing" hidden><label for="active-player">IINA players</label><select id="active-player"></select><span id="player-state"></span><button id="show-player">Show</button><button id="stop-player">Stop</button><button id="next-player">Next queued</button><button id="skip-intro" hidden>Skip intro</button><button id="skip-credits" hidden>Skip credits</button></section>
      <section id="up-next" hidden><span id="up-next-label"></span><button id="up-next-play">Play now</button><button id="up-next-cancel">Cancel</button></section>
      <details id="queue-panel" hidden><summary>Play queue</summary><button id="clear-queue">Clear queue</button><plex-play-queue id="queue"></plex-play-queue></details>
      <section id="welcome"><div class="welcome-symbol">▶</div><h2>A better seat for your library.</h2><p>Your movies. Your shows. The player you love.</p></section>
      <plex-media-list id="items" class="grid" aria-label="Library items"></plex-media-list>
      <div class="pagination"><button id="previous" hidden>← Previous</button><button id="next" hidden>Next →</button></div>
      <footer>PLEX LIBRARY <span>Original quality · Powered by IINA</span></footer>
    </main>
    <plex-media-details id="details"></plex-media-details>
    <dialog id="profile-dialog" aria-labelledby="profile-title"><h2 id="profile-title">Choose your Plex Home profile</h2><form id="profile-form"><label class="preference">Profile<select id="profile-select"></select></label><label class="preference">Profile PIN<input id="profile-pin" type="password" inputmode="numeric" maxlength="4" autocomplete="off"></label><button id="profile-switch" type="submit" class="primary">Switch profile</button><button id="profile-close" type="button">Cancel</button></form><p class="hint">Profile PINs are never saved. Existing players stop reporting progress when you switch profiles.</p></dialog>
  `;
  static properties={request:{type:Number,default:0},busy:{type:Boolean,default:false},signedIn:{type:Boolean,default:false},section:{default:"continue"}};
  view(id){return this.querySelector("#"+id);}
  post(name,data={}){iina.postMessage(name,data);}
  status(message,error=false){this.view("status").textContent=message;this.view("status").classList.toggle("error",error);}
  notice(message,sync=false){this.view("notice").textContent=message;this.view("notice").hidden=false;this.view("notice").toggleAttribute("data-sync",sync);}
  connected(){
    const bind=(id,event,handler)=>this.listen(this.view(id),event,handler);
    this.listen(this,"library-change",event=>{
      this.section="library";this.view("breadcrumbs").replaceChildren(this.crumb(event.detail.item));
      this.view("search").value="";this.resetFilters();this.view("genre-filter").disabled=true;this.view("year-filter").disabled=true;this.post("filters",{library:event.detail.item.ratingKey});this.browse(0);
    });
    this.listen(this,"path-change",()=>{this.restorePath();this.browse(this.view("breadcrumbs").lastElementChild.pageStart,true);});
    this.listen(this,"media-browse",event=>{this.savePath();this.view("breadcrumbs").append(this.crumb(event.detail.item));this.browse(0);});
    this.listen(this,"media-play",event=>this.play(event.detail.item,event.detail));
    this.listen(this,"media-details",event=>{const details=this.view("details");details.copyFrom(event.detail.item);details.open=true;this.loadDetails();});
    this.listen(this,"playback-options",event=>this.loadDetails(event.detail.versionId));
    this.listen(this,"media-queue",event=>this.post("queue-add",Object.assign({id:event.detail.item.ratingKey,position:event.detail.position},this.view("details").playbackOptions())));
    this.listen(this,"media-watched",event=>this.post("watched",{id:event.detail.item.ratingKey,watched:event.detail.watched}));
    this.listen(this,"queue-action",event=>this.queueAction(event.detail));
    this.listen(this,"artwork-request",event=>this.post("artwork",event.detail));
    this.listen(this,"list-state-change",event=>this.pagination(event.detail.count));
    for(const button of this.view("discovery").children)this.listen(button,"click",()=>this.openView(button.dataset.view));
    bind("sign-in","click",()=>{this.view("sign-in").disabled=true;this.view("sign-out").hidden=false;this.view("notice").hidden=true;this.status("Starting Plex sign-in…");this.post("sign-in");});
    bind("sign-out","click",()=>this.post("sign-out"));
    bind("refresh","click",()=>{this.busy=true;this.resetNavigation();this.status("Finding servers…");this.post("discover");});
    bind("reconnect","click",()=>{this.status("Reconnecting…");this.post("reconnect");});
    bind("servers","change",()=>this.connect());bind("allow-http","change",()=>this.connect());
    bind("search-form","submit",event=>{event.preventDefault();if(this.view("search-scope").value==="all"||this.section!=="library")this.openView("search");else this.browse(0);});
    for(const id of ["sort","watch-filter","genre-filter","year-filter"])bind(id,"change",()=>{const crumb=this.view("breadcrumbs").lastElementChild;if(crumb)crumb.scrollPosition=0;this.browse(0);});
    bind("reset-filters","click",()=>{this.resetFilters();this.browse(0);});
    bind("previous","click",()=>this.browse(Math.max(0,this.view("items").pageStart-60)));bind("next","click",()=>{if(this.view("items").nextStart>=0)this.browse(this.view("items").nextStart);});
    bind("back","click",()=>this.back());bind("refresh-view","click",()=>this.refreshView());
    bind("collections","click",()=>this.openView("collections"));bind("playlists","click",()=>this.openView("playlists"));
    bind("play-season","click",()=>{const crumb=this.view("breadcrumbs").lastElementChild;if(crumb)this.post("queue-series",{id:crumb.ratingKey});});
    bind("clear-queue","click",()=>this.queueAction({action:"clear"}));
    bind("up-next-play","click",()=>this.queueAction({action:"play",index:0}));bind("up-next-cancel","click",()=>this.queueAction({action:"cancel-next"}));
    for(const [id,action]of [["show-player","activate"],["stop-player","stop"],["next-player","next"],["skip-intro","skip-intro"],["skip-credits","skip-credits"]])bind(id,"click",()=>this.post("player-control",{playerID:Number(this.view("active-player").value),action}));
    bind("active-player","change",()=>this.renderPlayer());
    for(const id of ["audio-language","subtitle-language","subtitle-mode","auto-next","include-specials"])bind(id,"change",()=>this.post("preferences",{audioLanguage:this.view("audio-language").value,subtitleLanguage:this.view("subtitle-language").value,subtitleMode:this.view("subtitle-mode").value,autoNext:this.view("auto-next").checked,includeSpecials:this.view("include-specials").checked}));
    bind("choose-profile","click",()=>{this._chooseProfileRequested=true;this.post("home-users");});
    bind("profile-close","click",()=>this.view("profile-dialog").close());
    bind("profile-dialog","close",()=>this.view("profile-pin").value="");
    bind("profile-form","submit",event=>{event.preventDefault();const pin=this.view("profile-pin").value;this.view("profile-pin").value="";this.view("profile-switch").disabled=true;this.post("switch-profile",{id:this.view("profile-select").value,pin});});
    this.listen(document,"keydown",event=>{const editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)||document.activeElement.isContentEditable;if((!editing&&((event.altKey&&event.key==="ArrowLeft")||event.key==="Backspace"))||(event.metaKey&&event.key==="[")){if(!this.view("details").open&&!this.view("profile-dialog").open){event.preventDefault();this.back();}}});
    this.listen(window,"focus",()=>{if(this.signedIn&&!this.busy&&!this.view("details").open&&Date.now()-(this._lastRefresh||0)>30000)this.refreshView();});
    if(!this._bridgeInstalled){this.installBridge();this._bridgeInstalled=true;}
    this.post("ready");
  }
  disconnected(){if(this._countdown)clearInterval(this._countdown);}
  render(){
    for(const id of ["servers","allow-http","refresh"])this.view(id).disabled=this.busy;
    this.view("account").hidden=this.signedIn;this.view("navigation").hidden=!this.signedIn;
    this.view("sign-out").hidden=!this.signedIn&&!this.view("sign-in").disabled;
    for(const button of this.view("discovery").children)button.classList.toggle("active",button.dataset.view===this.section);
  }
  crumb(item){return document.createElement("plex-crumb").setProperties({ratingKey:item.ratingKey,mediaTitle:item.mediaTitle,mediaType:item.mediaType});}
  libraryID(){return this.view("libraries").value||this._rememberedLibrary||this.view("libraries").firstElementChild&&this.view("libraries").firstElementChild.ratingKey||"";}
  applyMetadata(item,data){return item.setProperties({ratingKey:data.id,mediaTitle:data.title,mediaType:data.type,year:data.year,edition:data.edition,summary:data.summary,duration:data.duration,index:data.index,rating:data.rating,score:data.score,parentIndex:data.parentIndex,libraryId:data.libraryId,showId:data.showId,watched:data.watched,progress:data.progress,episodes:data.episodes,parentTitle:data.parentTitle,playable:data.playable});}
  clearListing(){this.view("details").open=false;const list=this.view("items");list.batch(()=>{list.replaceChildren();list.setProperties({request:this.request,pageStart:0,total:0,nextStart:-1});});this.pagination(0);}
  resetNavigation(){this.request++;this.clearListing();this.view("libraries").replaceChildren();this.view("libraries").value="";this.view("breadcrumbs").replaceChildren();this.view("search-form").hidden=true;}
  resetFilters(){for(const id of ["watch-filter","genre-filter","year-filter"])this.view(id).value="";}
  pagination(count){const list=this.view("items");this.view("count").textContent=count?(list.pageStart+1)+"–"+(list.pageStart+count)+(list.total>=0?" of "+list.total:""):"0 titles";this.view("previous").hidden=list.pageStart<=0;this.view("next").hidden=list.nextStart<0;}
  savePath(){const crumb=this.view("breadcrumbs").lastElementChild;if(!crumb)return;crumb.setProperties({scrollPosition:this.querySelector("main").scrollTop,pageStart:this.view("items").pageStart,searchText:this.view("search").value,sortValue:this.view("sort").value,watchValue:this.view("watch-filter").value,genreValue:this.view("genre-filter").value,yearValue:this.view("year-filter").value});}
  restorePath(){const crumb=this.view("breadcrumbs").lastElementChild;if(!crumb)return;this.view("search").value=crumb.searchText;this.view("sort").value=crumb.sortValue;this.view("watch-filter").value=crumb.watchValue;this.view("genre-filter").value=crumb.genreValue;this.view("year-filter").value=crumb.yearValue;}
  back(){const path=this.view("breadcrumbs");if(path.childElementCount>1)path.lastElementChild.previousElementSibling.part("button").click();}
  openView(section){this.savePath();this.section=section;const titles={continue:"Continue Watching",next:"Up Next",recent:"Recently Added",search:"Search results",collections:"Collections",playlists:"Playlists"};this.view("breadcrumbs").replaceChildren(document.createElement("plex-crumb").setProperties({mediaTitle:titles[section]||"Library"}));this.browse(0);}
  refreshView(){const crumb=this.view("breadcrumbs").lastElementChild;if(!crumb||this.busy)return;this.savePath();this.browse(crumb.pageStart,true);}
  browse(start,restoreScroll=false){
    const path=this.view("breadcrumbs"),current=path.lastElementChild;if(!current)return;
    if(!restoreScroll)current.scrollPosition=0;
    this.request++;this.clearListing();this.status("Loading…");this.view("welcome").hidden=true;this.view("title").textContent=current.mediaTitle;
    const top=path.childElementCount===1;this.view("search-form").hidden=!top;this.view("filters").hidden=!(top&&this.section==="library");this.view("sort").disabled=!top||this.section!=="library";
    this.view("back").disabled=top;this.view("play-season").hidden=top||!["show","season"].includes(current.mediaType);this.view("play-season").textContent=current.mediaType==="show"?"Play show":"Play season";
    current.pageStart=start;this._lastRefresh=Date.now();
    this.post("browse",{view:this.section,library:this.section==="library"?path.firstElementChild.ratingKey:this.libraryID(),parent:top?null:current.ratingKey,parentType:current.mediaType,search:top?this.view("search").value:"",sort:this.view("sort").value,watch:this.view("watch-filter").value,genre:this.view("genre-filter").value,year:this.view("year-filter").value,start,request:this.request});
  }
  connect(){if(!this.view("servers").value||this.busy)return;this.busy=true;this.resetNavigation();this.status("Connecting to server…");this.post("connect",{id:this.view("servers").value,allowHTTP:this.view("allow-http").checked});}
  play(item,options={}){if(item===this.view("details"))options=Object.assign({},item.playbackOptions(),options);this.view("details").open=false;this.status("Opening “"+item.mediaTitle+"” in IINA…");this.post("play",{id:item.ratingKey,restart:options.restart===true,versionId:options.versionId,audioId:options.audioId,subtitleId:options.subtitleId});}
  queueAction(detail){this.post("queue-action",Object.assign({revision:Number(this.view("queue").getAttribute("revision"))},detail));}
  loadDetails(versionId){const details=this.view("details");details.request++;details.loading=true;this.post("details",{id:details.ratingKey,request:details.request,versionId});}
  syncDetails(item){const details=this.view("details");if(details.open&&details.ratingKey===item.ratingKey)details.copyFrom(item);}
  updateProgress(data,fromServer){if(data.serverID!==this.view("servers").value)return;for(const item of this.view("items").findItems(fromServer?data.item.id:data.id)){if(fromServer)this.applyMetadata(item,data.item);else item.progress=data.duration>0?Math.min(1,data.time/data.duration):0;this.syncDetails(item);}}
  renderPlayer(){const option=this.view("active-player").selectedOptions[0];this.view("now-playing").hidden=!option;if(!option)return;this.view("player-state").textContent=option.dataset.state;this.view("skip-intro").hidden=option.dataset.intro!=="true";this.view("skip-credits").hidden=option.dataset.credits!=="true";this.view("next-player").disabled=!this.view("queue").childElementCount;}
  installBridge(){
    const on=(name,handler)=>iina.onMessage(name,data=>{if(this.isConnected)handler(data);});
    on("session",data=>{
      this.batch(()=>{this.busy=false;this.signedIn=data.signedIn;});this.resetNavigation();this.view("notice").hidden=true;this._rememberedServer=data.serverID;this._rememberedLibrary=data.libraryID;
      this.view("allow-http").checked=data.allowHTTP===true;this.view("sign-in").disabled=false;this.view("servers").replaceChildren();this.view("welcome").hidden=data.signedIn;this.view("title").textContent=data.signedIn?"Your library":"Your own big screen.";this.render();
      if(this.view("profile-dialog").open)this.view("profile-dialog").close();this.view("profile-switch").disabled=false;
      if(data.signedIn){this.post("home-users");if(!data.needsProfile){this.status("Finding your Plex servers…");this.post("discover");}else this.status("Choose your Plex Home profile to continue.");}
      else this.status("Sign in to see your Plex servers and libraries.");
    });
    on("preferences",data=>{this.view("audio-language").value=data.audioLanguage||"";this.view("subtitle-language").value=data.subtitleLanguage||"";this.view("subtitle-mode").value=data.subtitleMode||"auto";this.view("auto-next").checked=data.autoNext===true;this.view("include-specials").checked=data.includeSpecials===true;});
    on("home-users",data=>{
      const select=this.view("profile-select");select.replaceChildren();for(const user of data.users){const option=document.createElement("option");option.value=user.id;option.textContent=user.title+(user.protected?" · PIN required":"");select.append(option);}
      if(data.selected!=="owner")select.value=data.selected;
      this.view("choose-profile").hidden=data.users.length<2&&!data.needsSelection;
      if((data.needsSelection||this._chooseProfileRequested)&&data.users.length&&!this.view("profile-dialog").open)this.view("profile-dialog").showModal();
      if(data.needsSelection&&!data.users.length)this.notice("The saved profile is unavailable. Sign out and sign in again.");
      this._chooseProfileRequested=false;
    });
    on("notice",data=>this.notice(data.message));on("auth-waiting",()=>this.status("Finish signing in with Plex in your browser. Use Sign out to cancel."));
    on("servers",servers=>{
      this.busy=false;const select=this.view("servers"),placeholder=document.createElement("option");placeholder.value="";placeholder.textContent="Choose a server";select.replaceChildren(placeholder);
      for(const server of servers){const option=document.createElement("option");option.value=server.id;option.textContent=server.name+(server.owned?"":" (shared)");select.append(option);}
      this.status(servers.length?"Choose a server to browse its libraries.":"No servers found for this profile. Check sharing and refresh.");
      const previous=Array.from(select.options).find(option=>option.value===this._rememberedServer);
      if(previous||select.options.length===2){select.value=previous?previous.value:select.options[1].value;this.connect();}
    });
    on("libraries",libraries=>{
      this.busy=false;const list=this.view("libraries");list.replaceChildren();list.value="";
      for(const library of libraries)list.append(document.createElement("plex-library-item").setProperties({ratingKey:library.id,mediaTitle:library.title,mediaType:library.type}));
      this._rememberedLibrary=libraries.some(library=>library.id===this._rememberedLibrary)?this._rememberedLibrary:list.firstElementChild&&list.firstElementChild.ratingKey;
      this.openView("continue");
    });
    on("filters",data=>{
      if(data.serverID!==this.view("servers").value||data.library!==this.libraryID())return;
      for(const kind of ["genre","year"]){const select=this.view(kind+"-filter"),old=select.value;select.disabled=false;select.replaceChildren();const any=document.createElement("option");any.value="";any.textContent=kind==="genre"?"All genres":"All years";select.append(any);for(const entry of data[kind]||[]){const option=document.createElement("option");option.value=entry.id;option.textContent=entry.title;select.append(option);}select.value=old;}
    });
    on("listing",data=>{
      if(data.request!==this.request||(data.serverID&&data.serverID!==this.view("servers").value))return;
      this.clearListing();this.status(data.items.length?"":"No titles found.");const list=this.view("items");
      list.batch(()=>{list.setProperties({pageStart:data.start,total:data.total==null?-1:data.total,nextStart:data.next==null?-1:data.next});for(const item of data.items)list.append(this.applyMetadata(document.createElement("plex-media-item"),item));list.invalidate();});
      const crumb=this.view("breadcrumbs").lastElementChild;if(crumb)this.querySelector("main").scrollTop=crumb.scrollPosition;
    });
    on("details",data=>{const details=this.view("details");if(!details.open||details.ratingKey!==data.id||details.request!==data.request||data.serverID!==this.view("servers").value)return;this.applyMetadata(details,data.item);details.configure(data);});
    on("artwork",data=>{const list=this.view("items");list.acceptArtwork(data);const item=list.findItem(data.id);if(item&&data.request===list.request)this.syncDetails(item);});
    on("artwork-done",data=>this.view("items").finishArtwork(data));on("progress-synced",data=>this.updateProgress(data,false));on("item-synced",data=>this.updateProgress(data,true));
    on("queue",data=>{const queue=this.view("queue");queue.setAttribute("revision",data.revision||0);queue.replaceChildren();for(const item of data.items)queue.append(document.createElement("plex-queue-item").setProperties({queueIndex:item.index,mediaTitle:item.title,ratingKey:item.id}));this.view("queue-panel").hidden=!queue.childElementCount;queue.toggleAttribute("busy",data.busy===true);this.renderPlayer();});
    on("players",players=>{const select=this.view("active-player"),old=select.value;select.replaceChildren();for(const player of players){const option=document.createElement("option");option.value=player.playerID;option.textContent=player.title;option.dataset.state=player.state;option.dataset.intro=String(player.canSkipIntro);option.dataset.credits=String(player.canSkipCredits);select.append(option);}if(Array.from(select.options).some(option=>option.value===old))select.value=old;this.renderPlayer();});
    on("up-next",data=>{
      if(this._countdown)clearInterval(this._countdown);this.view("up-next").hidden=!data;if(!data)return;
      let seconds=data.seconds;const update=()=>this.view("up-next-label").textContent="Up next: "+data.title+" · "+seconds+"s";update();this._countdown=setInterval(()=>{seconds=Math.max(0,seconds-1);update();},1000);
    });
    on("sync-failed",()=>this.notice("Plex progress could not be saved. Playback can continue; the plugin will retry.",true));on("sync-abandoned",()=>this.notice("Progress is saved locally for recovery on reconnect. Plex may show an earlier position.",true));on("sync-storage-failed",()=>this.notice("Local recovery could not be saved. Keep IINA open until progress sync succeeds.",true));
    on("sync-recovered",()=>{if(this.view("notice").hasAttribute("data-sync")){this.view("notice").hidden=true;this.view("notice").removeAttribute("data-sync");}});
    on("reconnected",()=>{this.status("Reconnected to Plex.");this.refreshView();});
    on("failure",data=>{
      const operation=data.operation,details=this.view("details");
      if(operation==="browse"&&data.request!=null&&data.request!==this.request)return;
      if(operation==="details"){
        if(!details.open||data.request!==details.request)return;
        details.loading=false;
      }
      if(["ready","sign-in","discover","connect"].includes(operation))this.busy=false;
      if(operation==="sign-in")this.view("sign-in").disabled=false;
      if(operation==="switch-profile")this.view("profile-switch").disabled=false;
      this.status(data.message,true);this.notice(data.message);
    });
    on("opening",data=>{if(data.serverID!==this.view("servers").value)return;for(const item of this.view("items").findItems(data.id)){item.opening=true;this.syncDetails(item);}this.status("Opening video…");});
    on("opening-ended",data=>{if(data.serverID!==this.view("servers").value)return;for(const item of this.view("items").findItems(data.id)){item.opening=false;this.syncDetails(item);}});
    on("playing",data=>this.status((data.existing?"Already open: “":"Playing “")+data.title+"”."));
  }
}
PlexBrowser.define("plex-browser");
