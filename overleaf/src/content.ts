// Content scripts cannot be modules: load the real one as a module.
(async () => {
  await import(chrome.runtime.getURL("dist/content-main.js"));
})();
