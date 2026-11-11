// IINA 1.5.1 exports lowercase "keychain"; the type definitions use "keyChain".
module.exports = function credentialStore(utils, preferences) {
  const read = utils.keychainRead || utils.keyChainRead;
  const write = utils.keychainWrite || utils.keyChainWrite;
  const service = "Plex account";
  const account = "access-token";
  return {
    load() {
      if (preferences.get("rememberAccount") === false || typeof read !== "function") return null;
      try { const token = read.call(utils, service, account); return typeof token === "string" && token ? token : null; }
      catch (_) { return null; }
    },
    save(token) {
      let saved = false;
      try {
        saved = typeof write === "function" && typeof read === "function" && write.call(utils, service, account, token) === true && read.call(utils, service, account) === token;
      } catch (_) {}
      preferences.set("rememberAccount", saved);
      preferences.sync();
      return saved;
    },
    clear() {
      // No delete method is exposed. Empty the password and disable restore even if Keychain is locked.
      preferences.set("rememberAccount", false);
      preferences.sync();
      try { return typeof write === "function" && typeof read === "function" && write.call(utils, service, account, "") === true && read.call(utils, service, account) === ""; }
      catch (_) { return false; }
    }
  };
};
