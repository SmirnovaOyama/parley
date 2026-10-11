// Applies the saved appearance before the app paints, so there's no flash of the wrong theme. The
// bars around the page (theme-color in index.html) follow it too; src/pages/AccountPage.tsx does
// the same when it changes.
(function () {
  try {
    var theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
      var color = theme === "dark" ? "#181714" : "#ffffff";
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
        meta.setAttribute("content", color);
      });
    }
  } catch (e) {}
})();
