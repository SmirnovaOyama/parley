// Applies the saved appearance before the app paints, so there's no flash of the wrong theme.
(function () {
  try {
    var theme = localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
