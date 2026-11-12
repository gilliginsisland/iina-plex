// IINA 1.5.1 exports lowercase "keychain"; the type definitions use "keyChain".
module.exports = function credentialStore(utils, preferences) {
  const read = utils.keychainRead || utils.keyChainRead;
  const write = utils.keychainWrite || utils.keyChainWrite;
  const accountService = "Plex account", profileService = "Plex Home profile";
  const account = "access-token";
  function get(service) {
    if (typeof read !== "function") return null;
    try { const value = read.call(utils, service, account); return typeof value === "string" && value ? value : null; }
    catch (_) { return null; }
  }
  function put(service, value) {
    try {
      return typeof write === "function" && typeof read === "function" &&
        write.call(utils, service, account, value) === true && read.call(utils, service, account) === value;
    } catch (_) { return false; }
  }
  function clearProfile() {
    preferences.set("rememberProfile", false);
    preferences.sync();
    // No delete method is exposed. Disable restore even if Keychain cannot be cleared.
    return put(profileService, "");
  }
  return {
    load() {
      return preferences.get("rememberAccount") === false ? null : get(accountService);
    },
    save(token) {
      const saved = put(accountService, token);
      preferences.set("rememberAccount", saved);
      preferences.sync();
      return saved;
    },
    loadProfile(accountID, profileID) {
      if (preferences.get("rememberAccount") === false || preferences.get("rememberProfile") === false) return null;
      try {
        const saved = JSON.parse(get(profileService));
        return saved && saved.accountID === String(accountID) && saved.profileID === String(profileID) &&
          typeof saved.token === "string" && saved.token ? saved.token : null;
      } catch (_) { return null; }
    },
    saveProfile(accountID, profileID, token) {
      const saved = preferences.get("rememberAccount") !== false &&
        put(profileService, JSON.stringify({accountID:String(accountID),profileID:String(profileID),token}));
      preferences.set("rememberProfile", saved);
      preferences.sync();
      return saved;
    },
    clearProfile,
    clear() {
      preferences.set("rememberAccount", false);
      preferences.sync();
      const profileCleared = clearProfile();
      return put(accountService, "") && profileCleared;
    }
  };
};
