const P = require("./plex.js");
const CredentialStore = require("./storage.js");

// Owns Plex sign-in, remembered credentials and the active Home profile.
class PlexAccount {
  constructor(app) {
    this.app = app;
    this.api = app.plex;
    this.restored = false;
    this.restoring = null;
    this.token = null;
    this.authGeneration = 0;
    this.revision = 0;
    this.homeUsers = [];
    this.profileID = "owner";
    this.profileToken = null;
    this.accountID = "";
    this.needsProfile = false;
    this.identifyingAccount = null;
    this.credentials = new CredentialStore(app.api.utils, app.api.preferences);
  }

  registerEvents() {
    this.app.guarded("sign-in", (data) => this.signIn(data));
    this.app.guarded("sign-out", (data) => this.signOut(data));
    this.app.guarded("home-users", (data) => this.loadHomeUsers(data));
    this.app.guarded("switch-profile", (data) => this.switchProfile(data));
  }

  get info() {
    return {
      signedIn: !!this.token,
      profileID: this.profileID,
      needsProfile: this.needsProfile
    };
  }

  async identify() {
    if (this.accountID) return;
    const currentSession = this.revision,
      accessToken = this.token;
    if (
      this.identifyingAccount &&
      this.identifyingAccount.session === currentSession &&
      this.identifyingAccount.token === accessToken
    ) {
      return this.identifyingAccount.promise;
    }
    const pending = { session: currentSession, token: accessToken };
    pending.promise = (async () => {
      const user = await this.api.withToken(accessToken).request("/api/v2/user");
      if (currentSession !== this.revision || accessToken !== this.token)
        throw new Error("Plex account changed. Try again.");
      if (!user || !/^\d+$/.test(String(user.id)))
        throw new Error("Plex did not return an account identity. Sign in again.");
      this.accountID = String(user.id);
      this.app.api.preferences.set("accountID", this.accountID);
      this.app.api.preferences.sync();
    })();
    this.identifyingAccount = pending;
    try {
      await pending.promise;
    } finally {
      if (this.identifyingAccount === pending) this.identifyingAccount = null;
    }
  }

  get token() {
    return this.api.token;
  }
  set token(value) {
    this.api.token = value;
  }
  get profileAPI() {
    return this._profileAPI || this.api;
  }

  get profileToken() {
    return this._profileAPI ? this._profileAPI.token : null;
  }

  set profileToken(value) {
    this._profileAPI = value ? this.api.withToken(value) : null;
  }

  get scope() {
    return this.accountID + ":" + this.profileID;
  }

  get accessToken() {
    return this.profileToken || this.token;
  }

  revokeAccess() {
    this.app.disableSync();
    this.app.library.reset();
    this.revision++;
    if (this.profileToken) {
      this.credentials.clearProfile();
      this.profileToken = null;
      this.needsProfile = true;
      this.app.send("session", this.app.session);
      this.app.send("notice", { message: "Please select your Plex Home profile again." });
    } else {
      this.credentials.clear();
      this.token = null;
      this.app.send("session", { signedIn: false });
      this.app.send("notice", { message: "Your saved Plex login is no longer valid. Please sign in again." });
    }
  }

  async restore() {
    if (this.restored) return;
    if (this.restoring) return this.restoring;
    const currentSession = this.revision;
    const pending = (async () => {
      this.token = this.credentials.token;
      const previous = String(this.app.api.preferences.get("lastHomeProfile") || "");
      const remembered = /^\d+$/.test(previous) ? previous : "";
      this.needsProfile = !!remembered;
      if (!this.token || !remembered) return;
      this.profileID = remembered;
      try {
        await this.identify();
      } catch (error) {
        if (currentSession !== this.revision) return;
        if (error.denied) {
          this.credentials.clear();
          this.token = null;
          this.accountID = "";
          this.profileID = "owner";
          this.needsProfile = false;
        }
      }
      if (currentSession !== this.revision) return;
      const saved =
        this.token && this.accountID ? this.credentials.loadProfile(this.accountID, remembered) : null;
      if (!saved) return;
      try {
        await this.api.withToken(saved).resources();
        if (currentSession !== this.revision) return;
        this.profileToken = saved;
        this.needsProfile = false;
      } catch (error) {
        if (currentSession !== this.revision) return;
        if (error.denied) this.credentials.clearProfile();
      }
    })();
    this.restoring = pending;
    try {
      await pending;
    } finally {
      if (currentSession === this.revision) this.restored = true;
      if (this.restoring === pending) this.restoring = null;
    }
  }

  async homeRequest(path, method = "get") {
    try {
      return await this.api.request(path, { method, format: "home" });
    } catch (_) {
      throw new Error("Plex Home is unavailable, or the profile PIN was not accepted.");
    }
  }

  async signIn() {
    const generation = ++this.authGeneration;
    const pin = await this.api.withToken(null).request("/api/v2/pins?strong=true", { method: "post" });
    if (generation !== this.authGeneration) return;
    const authURL =
      "https://app.plex.tv/auth#?" +
      P.query({
        clientID: this.app.clientID,
        code: pin.code,
        "context[device][product]": "IINA Plex Library"
      });
    if (!this.app.api.utils.open(authURL))
      throw new Error("Could not open your browser. Please try signing in again.");
    this.app.send("auth-waiting", {});
    const deadline = Date.now() + Math.min(Number(pin.expiresIn || 300), 600) * 1000;
    while (generation === this.authGeneration && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (generation !== this.authGeneration) return;
      const result = await this.api.withToken(null).request("/api/v2/pins/" + P.id(pin.id));
      if (generation !== this.authGeneration) return;
      if (result.authToken) {
        this.app.disableSync();
        this.revision++;
        this.app.library.reset();
        this.homeUsers = [];

        this.restored = true;
        this.token = result.authToken;
        this.profileToken = null;
        this.profileID = "owner";
        this.needsProfile = false;
        this.accountID = "";
        this.app.api.preferences.set("lastHomeProfile", "");
        this.credentials.clearProfile();
        const saved = this.credentials.save(this.token);
        this.app.send("session", this.app.session);
        if (!saved)
          this.app.send("notice", {
            message:
              "Signed in, but Keychain could not save your login. Allow IINA access to Keychain and sign in again to remember this account."
          });
        return;
      }
    }
    if (generation === this.authGeneration) throw new Error("Plex sign-in expired. Please try again.");
  }

  async signOut() {
    this.restored = true;
    this.authGeneration++;
    this.revision++;
    this.token = null;
    this.profileToken = null;
    this.profileID = "owner";
    this.homeUsers = [];
    this.needsProfile = false;
    this.accountID = "";
    this.app.library.reset();
    this.app.api.preferences.set("lastHomeProfile", "");
    this.app.api.preferences.sync();
    this.app.disableSync();
    this.app.sync.clear(true);
    const cleared = this.credentials.clear();
    this.app.send("session", { signedIn: false });
    if (!cleared)
      this.app.send("notice", {
        message:
          "Signed out. Automatic sign-in is disabled, but Keychain could not clear the saved entry. You can remove Plex account in Keychain Access."
      });
  }

  async loadHomeUsers() {
    if (!this.token) return;
    const currentSession = this.revision;
    try {
      const result = await this.homeRequest("/api/home/users");
      if (currentSession !== this.revision) return;
      this.homeUsers =
        result.users || result.User || (result.MediaContainer && result.MediaContainer.User) || [];
      this.homeUsers = this.homeUsers
        .filter((user) => /^\d+$/.test(String(user.id)))
        .map((user) => ({
          id: String(user.id),
          title: user.title || user.username || "Home user",
          protected: P.flag(user.protected),
          admin: P.flag(user.admin)
        }));
      this.app.send("home-users", {
        users: this.homeUsers,
        selected: this.profileID,
        needsSelection: this.needsProfile
      });
    } catch (error) {
      if (currentSession !== this.revision) return;
      this.app.send("home-users", { users: [], selected: this.profileID, needsSelection: this.needsProfile });
      if (this.needsProfile) throw error;
    }
  }

  async switchProfile(data) {
    if (!this.token) throw new Error("Sign in first.");
    const currentSession = this.revision;
    await this.identify();
    if (currentSession !== this.revision) return;
    const user = this.homeUsers.find((user) => user.id === String(data.id));
    if (!user) throw new Error("Choose an available Plex Home profile.");
    const pin = String(data.pin || "");
    if ((user.protected && !/^\d{4}$/.test(pin)) || (pin && !/^\d{4}$/.test(pin)))
      throw new Error("Enter the profile's four-digit PIN.");
    const result = await this.homeRequest(
      "/api/home/users/" + P.id(user.id) + "/switch" + (pin ? "?" + P.query({ pin }) : ""),
      "post"
    );
    if (currentSession !== this.revision) return;
    const current = result.user || result.User || result;
    const switched = current.authenticationToken || current.authToken;
    if (typeof switched !== "string" || !switched) throw new Error("Plex did not authorize this profile.");
    await this.api.withToken(switched).resources();
    if (currentSession !== this.revision) return;
    this.app.disableSync();
    this.revision++;
    this.app.library.reset();

    this.profileToken = switched;
    this.profileID = user.id;
    this.needsProfile = false;
    this.app.api.preferences.set("lastHomeProfile", this.profileID);
    const saved = this.credentials.saveProfile(this.accountID, this.profileID, switched);
    this.app.send("session", this.app.session);
    this.app.send("home-users", { users: this.homeUsers, selected: this.profileID, needsSelection: false });
    if (!saved)
      this.app.send("notice", {
        message:
          "Profile selected, but Keychain could not save it. You will need to select it again after restarting IINA."
      });
  }
}

module.exports = PlexAccount;
