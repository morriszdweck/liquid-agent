// The first-run screen the Mac app shows while Liquid Agent is set up. The app
// calls window.say(text) for progress and window.failed(text) when setup stops.

declare global {
  interface Window {
    say: (text: string) => void;
    failed: (text: string) => void;
  }
}

const status = document.getElementById("status");

window.say = (text: string) => {
  if (status) status.textContent = text;
};

window.failed = (text: string) => {
  document.body.classList.add("done");
  status?.classList.add("bad");
  if (status) status.textContent = text;
};

export {};
