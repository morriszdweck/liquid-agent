import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Inside the Liquid Agent Mac app the page fills the window, under the traffic lights.
// The Mac app's window provides window.ipc (it is not a browser tab).
if ("ipc" in window) document.documentElement.classList.add("desktop");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
