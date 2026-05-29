import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const BUILD_STORAGE_KEY = "paite-translator-build";

function ensureFreshBuild() {
  const buildId = __APP_BUILD_ID__;
  try {
    const previous = localStorage.getItem(BUILD_STORAGE_KEY);
    if (previous && previous !== buildId) {
      localStorage.setItem(BUILD_STORAGE_KEY, buildId);
      window.location.reload();
      return;
    }
    localStorage.setItem(BUILD_STORAGE_KEY, buildId);
  } catch {
    // Storage blocked — rely on server cache headers.
  }
}

ensureFreshBuild();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
