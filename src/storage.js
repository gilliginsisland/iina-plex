// IINA 1.5.1 exports lowercase "keychain"; the type definitions use "keyChain".
const ACCOUNT_SERVICE = "Plex account",
  PROFILE_SERVICE = "Plex Home profile";
const KEYCHAIN_ACCOUNT = "access-token";

class CredentialStore {
  constructor(utils, preferences) {
    this.utils = utils;
    this.preferences = preferences;
    this.read = utils.keychainRead || utils.keyChainRead;
    this.write = utils.keychainWrite || utils.keyChainWrite;
  }

  readEntry(service) {
    if (typeof this.read !== "function") return null;
    try {
      const value = this.read.call(this.utils, service, KEYCHAIN_ACCOUNT);
      return typeof value === "string" && value ? value : null;
    } catch (_) {
      return null;
    }
  }

  writeEntry(service, value) {
    try {
      return (
        typeof this.write === "function" &&
        typeof this.read === "function" &&
        this.write.call(this.utils, service, KEYCHAIN_ACCOUNT, value) === true &&
        this.read.call(this.utils, service, KEYCHAIN_ACCOUNT) === value
      );
    } catch (_) {
      return false;
    }
  }

  get token() {
    return this.preferences.get("rememberAccount") === false ? null : this.readEntry(ACCOUNT_SERVICE);
  }

  save(token) {
    const saved = this.writeEntry(ACCOUNT_SERVICE, token);
    this.preferences.set("rememberAccount", saved);
    this.preferences.sync();
    return saved;
  }

  loadProfile(accountID, profileID) {
    if (
      this.preferences.get("rememberAccount") === false ||
      this.preferences.get("rememberProfile") === false
    )
      return null;
    try {
      const saved = JSON.parse(this.readEntry(PROFILE_SERVICE));
      return saved &&
        saved.accountID === String(accountID) &&
        saved.profileID === String(profileID) &&
        typeof saved.token === "string" &&
        saved.token
        ? saved.token
        : null;
    } catch (_) {
      return null;
    }
  }

  saveProfile(accountID, profileID, token) {
    const saved =
      this.preferences.get("rememberAccount") !== false &&
      this.writeEntry(
        PROFILE_SERVICE,
        JSON.stringify({ accountID: String(accountID), profileID: String(profileID), token })
      );
    this.preferences.set("rememberProfile", saved);
    this.preferences.sync();
    return saved;
  }

  clearProfile() {
    this.preferences.set("rememberProfile", false);
    this.preferences.sync();
    // No delete method is exposed. Disable restore even if Keychain cannot be cleared.
    return this.writeEntry(PROFILE_SERVICE, "");
  }

  clear() {
    this.preferences.set("rememberAccount", false);
    this.preferences.sync();
    const profileCleared = this.clearProfile();
    return this.writeEntry(ACCOUNT_SERVICE, "") && profileCleared;
  }
}

module.exports = CredentialStore;
