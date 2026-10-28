// Betterwright bridge for Liquid Agent.
// Keeps one persistent Betterwright session and exposes a tiny action API on
// 127.0.0.1 so a 1.7B model only has to pick an action, not write Playwright.
//
//   POST /goto  {url}
//   POST /read  {}
//   POST /click {target}
//   POST /type  {target, text}
//   GET  /health

import http from "node:http";
import { BetterWright } from "betterwright";

const PORT = Number(process.env.LA_BROWSER_PORT ?? 8767);
const SESSION = "liquid-agent";
const READ_LIMIT = Number(process.env.LA_READ_LIMIT ?? 3000);

const bw = new BetterWright({ headless: "auto", profile: "liquid-agent" });

const j = (v) => JSON.stringify(v);

// Compact page view: title, url, then visible text and numbered interactive
// elements. Small, so it fits a small model's context.
const READ = `
const items = await page.$$eval('a,button,input,textarea,select,[role=button]', els => els
  .filter(e => e.offsetParent !== null).slice(0, 40)
  .map((e, i) => '[' + i + '] ' + e.tagName.toLowerCase() + ' ' +
    (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 60)));
const text = (await page.innerText('body')).replace(/\\n{2,}/g, '\\n').slice(0, ${READ_LIMIT});
return 'Title: ' + (await page.title()) + '\\nURL: ' + page.url() + '\\n\\n' + text + '\\n\\nElements:\\n' + items.join('\\n');
`;

const target = (t) => `
const t = ${j(t)};
let loc = /^[#.\\[]|^\\w+\\[/.test(t) ? page.locator(t) : page.getByText(t, { exact: false });
if (await loc.count() === 0) loc = page.getByRole('button', { name: t });
if (await loc.count() === 0) loc = page.getByPlaceholder(t);
if (await loc.count() === 0) loc = page.getByLabel(t);
loc = loc.first();
`;

const actions = {
  goto: ({ url }) => `await page.goto(${j(url)}, { waitUntil: 'domcontentloaded' });\n${READ}`,
  read: () => READ,
  click: ({ target: t }) => `${target(t)}\nawait loc.click();\nawait page.waitForLoadState('domcontentloaded');\n${READ}`,
  type: ({ target: t, text }) => `${target(t)}\nawait loc.fill(${j(text ?? "")});\nreturn 'typed';`,
};

function unwrap(envelope) {
  const value = envelope?.result ?? envelope?.value ?? envelope?.output ?? envelope;
  return typeof value === "string" ? value : JSON.stringify(value).slice(0, READ_LIMIT);
}

http
  .createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const name = req.url.slice(1);
    if (req.method === "GET" && name === "health") return send(200, { ok: true });
    const build = actions[name];
    if (req.method !== "POST" || !build) return send(404, { error: "unknown action" });

    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const args = body ? JSON.parse(body) : {};
      const envelope = await bw.run(build(args), { session: SESSION, timeout: 45_000 });
      send(200, { text: unwrap(envelope) });
    } catch (e) {
      send(200, { error: String(e?.message ?? e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`[bridge] Betterwright bridge on 127.0.0.1:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await bw.close(); process.exit(0); });
