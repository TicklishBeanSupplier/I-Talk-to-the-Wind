import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./ui/styles.css";
import type { Runtime } from "./runtime/types";

/** Inside the desktop app Tauri injects this; in a plain browser it's absent. */
const inDesktopApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function createRuntime(): Promise<Runtime> {
  if (inDesktopApp) return (await import("./runtime/desktop")).createDesktopRuntime();
  return (await import("./runtime/preview")).createPreviewRuntime();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App createRuntime={createRuntime} />
  </StrictMode>,
);
