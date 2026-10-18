// Runs before first paint so a saved theme never flashes the other palette.
// Keep the storage key and resolution in sync with src/theme.ts.
(function () {
  var preference = null;
  try {
    preference = localStorage.getItem("cproject-theme");
  } catch (error) {
    // Storage can be unavailable in hardened browser modes; fall back to the system theme.
  }
  var dark =
    preference === "dark" ||
    (preference !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
