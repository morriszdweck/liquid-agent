// Full Markdown: GitHub tables, task lists and strikethrough, math, and
// highlighted code blocks with a language label and a copy button.

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Check, Copy } from "lucide-react";
import "katex/dist/katex.min.css";

// A short ```latex fence holding a formula (not a whole document) is shown as math.
const MATH_FENCE = /^```(?:latex|tex|math|katex)[ \t]*\n([\s\S]*?)\n?```$/i;

function fenceToMath(part: string) {
  const body = part.match(MATH_FENCE)?.[1]?.trim();
  if (!body || body.split("\n").length > 8 || /\\(documentclass|usepackage|begin\{document\})/.test(body)) return part;
  return `\n$$\n${body.replace(/^(\$\$?|\\\[)|(\$\$?|\\\])$/g, "").trim()}\n$$\n`;
}

/** Models often write \( \) and \[ \] for math; remark-math wants $ and $$. Other code is left alone. */
function normalizeMath(text: string) {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? fenceToMath(part)
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`),
    )
    .join("");
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="code-copy"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className: string = (child as { props?: { className?: string } })?.props?.className ?? "";
    const lang = className.match(/language-([\w+#-]+)/)?.[1] ?? "";
    return (
      <div className="code-block">
        <div className="code-head">
          <span>{lang || "code"}</span>
          <CopyButton value={text(children).replace(/\n$/, "")} />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  table({ children }) {
    return (
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    // Remote images would leak that this chat happened; show the link instead.
    return (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || src}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  return (
    <div className={streaming ? "md streaming" : "md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: true }]]}
        components={components}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  );
});
