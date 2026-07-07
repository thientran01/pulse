import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Dev-only icon lab, browser-runnable (no Tauri): `npm run dev` → /?lab
// import.meta.env.DEV is statically false in release builds, so the lab
// chunk is dead-code-eliminated from the bundle.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("lab")) {
  import("./icons/IconLab")
    .then(({ IconLab }) => {
      root.render(
        <React.StrictMode>
          <IconLab />
        </React.StrictMode>,
      );
    })
    .catch(() => {
      // Failed lab chunk load must not strand a blank page.
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      );
    });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
