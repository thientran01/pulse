import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./index.css";

// Make silent failures observable. Fire-and-forget backend calls (void
// invoke(...)) and other async work surface only as unhandled rejections, and
// a chromeless always-on-top widget has no console to see them in during a soak
// — log them so they leave a trace.
window.addEventListener("error", (event) => {
  console.error("Uncaught error:", event.error ?? event.message, event);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason, event);
});

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Window routing: each webview window carries its identity in the builder
// URL's query (?window=palette — see src-tauri/src/palette.rs), and the same
// param works at `npm run dev` in a plain browser so every window's UI is
// mock-iterable. Default (no param) = the main widget.
const params = new URLSearchParams(window.location.search);

// Dev-only icon lab, browser-runnable (no Tauri): `npm run dev` → /?lab
// import.meta.env.DEV is statically false in release builds, so the lab
// chunk is dead-code-eliminated from the bundle.
if (import.meta.env.DEV && params.has("lab")) {
  import("./icons/IconLab")
    .then(({ IconLab }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <IconLab />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(() => {
      // Failed lab chunk load must not strand a blank page.
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    });
} else if (params.get("window") === "palette") {
  import("./Palette")
    .then(({ default: Palette }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <Palette />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(() => {
      // NOT the App fallback — the widget rendering inside the palette
      // window would be worse than an honest empty pane.
      root.render(<p className="p-4 text-sm text-muted">Palette failed to load.</p>);
    });
} else if (params.get("window") === "focus") {
  import("./Focus")
    .then(({ default: Focus }) => {
      root.render(
        <React.StrictMode>
          <ErrorBoundary>
            <Focus />
          </ErrorBoundary>
        </React.StrictMode>,
      );
    })
    .catch(() => {
      root.render(<p className="p-4 text-sm text-muted">Focus failed to load.</p>);
    });
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
