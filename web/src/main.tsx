import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./phone.css";
import { setUpPhone } from "./phone";

// Inside the Liquid Agent Mac app the page fills the window, under the traffic lights.
if (navigator.userAgent.includes("Electron")) document.documentElement.classList.add("desktop");

// Phones and tablets: size the app to the part of the screen the keyboard leaves
// free. iPhone shrinks only the visual viewport, so a 100dvh app would slide
// under the keyboard and the page would scroll away from the top bar.
const vv = window.visualViewport;
if (vv && matchMedia("(pointer: coarse)").matches) {
  const root = document.documentElement;
  const fit = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoomed: leave the layout alone
    root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--vv-bottom", `${Math.max(0, Math.round(window.innerHeight - vv.offsetTop - vv.height))}px`);
    root.classList.toggle("keyboard", window.innerHeight - vv.height > 120);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

setUpPhone();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
