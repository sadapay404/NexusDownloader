// Apply the saved theme while the application bundle loads.
try {
  const mode = JSON.parse(localStorage.getItem("setting") || "{}").themeMode ?? "dark";
  const isDark = mode === "dark" ||
    (mode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.getElementById("loading-screen")?.classList.toggle("dark", isDark);
} catch {
  // A corrupt or unavailable settings cache must not block startup.
}
