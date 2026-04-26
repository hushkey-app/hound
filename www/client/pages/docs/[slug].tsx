import type { Context } from "@hushkey/howl";
import type { State } from "../../../howl.config.ts";
import type { BlockType, ManifestItem } from "../../../server/docs/reader.ts";
import { readDoc, readManifest } from "../../../server/docs/reader.ts";
import { Head } from "@hushkey/howl/runtime";
import type { JSX } from "preact/jsx-runtime";

type TokenKind = "keyword" | "string" | "comment" | "number" | "builtin" | "plain";
type Token = { text: string; kind: TokenKind };

const KW = new Set([
  "const", "let", "var", "function", "async", "await", "return",
  "import", "export", "from", "type", "interface", "class", "extends",
  "implements", "new", "this", "if", "else", "for", "while", "switch",
  "case", "break", "continue", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "void", "null", "undefined", "true", "false",
  "default", "static", "public", "private", "protected", "readonly",
  "as", "of", "in", "delete", "yield", "enum", "declare", "abstract",
  "override", "satisfies", "namespace",
]);

const BUILTIN = new Set([
  "string", "number", "boolean", "object", "symbol", "bigint", "never",
  "unknown", "any", "Array", "Promise", "Record", "Partial", "Required",
  "Pick", "Omit", "console", "Deno", "Date", "Set", "Map", "Error",
  "URL", "Response", "Request", "Headers", "JSON", "Math", "Object",
  "String", "Number", "Boolean",
]);

const TOKEN_CLS: Record<TokenKind, string> = {
  keyword: "text-violet-400",
  string: "text-emerald-400",
  comment: "text-zinc-500",
  number: "text-amber-400",
  builtin: "text-cyan-400",
  plain: "text-zinc-200",
};

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => { if (plain) { tokens.push({ text: plain, kind: "plain" }); plain = ""; } };

  while (i < code.length) {
    if (code[i] === "/" && code[i + 1] === "/") {
      flush();
      const end = code.indexOf("\n", i);
      tokens.push({ text: end === -1 ? code.slice(i) : code.slice(i, end), kind: "comment" });
      i = end === -1 ? code.length : end;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      flush();
      const end = code.indexOf("*/", i + 2);
      tokens.push({ text: end === -1 ? code.slice(i) : code.slice(i, end + 2), kind: "comment" });
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (code[i] === "'" || code[i] === '"' || code[i] === "`") {
      flush();
      const q = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== q && (q === "`" || code[j] !== "\n")) {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ text: code.slice(i, j + 1), kind: "string" });
      i = j + 1;
      continue;
    }
    if (/\d/.test(code[i]) && (i === 0 || /\W/.test(code[i - 1]))) {
      flush();
      let j = i;
      while (j < code.length && /[\d.xXoObBa-fA-F_]/.test(code[j])) j++;
      tokens.push({ text: code.slice(i, j), kind: "number" });
      i = j;
      continue;
    }
    if (/[a-zA-Z_$]/.test(code[i])) {
      flush();
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      tokens.push({ text: word, kind: KW.has(word) ? "keyword" : BUILTIN.has(word) ? "builtin" : "plain" });
      i = j;
      continue;
    }
    plain += code[i++];
  }
  flush();
  return tokens;
}

const TS_LANGS = new Set(["ts", "tsx", "js", "jsx", "typescript", "javascript"]);

function CodeBlock(
  { lang, text, filename }: { lang: string; text: string; filename?: string },
) {
  const tokens = TS_LANGS.has(lang) ? tokenize(text) : null;
  return (
    <div class="rounded-xl overflow-hidden border border-zinc-800">
      {filename && (
        <div class="bg-zinc-900 px-4 py-2.5 text-xs font-mono text-zinc-400 border-b border-zinc-800">
          {filename}
        </div>
      )}
      <div class="bg-zinc-950 px-4 sm:px-5 py-4 overflow-x-auto">
        <pre class="font-mono text-[12px] sm:text-[13px] leading-relaxed whitespace-pre">
          {tokens
            ? tokens.map((t, i) => <span key={i} class={TOKEN_CLS[t.kind]}>{t.text}</span>)
            : <span class="text-zinc-200">{text}</span>}
        </pre>
      </div>
      {lang !== "text" && (
        <div class="bg-zinc-900 px-4 py-2 text-right">
          <span class="badge badge-sm badge-ghost font-mono">{lang}</span>
        </div>
      )}
    </div>
  );
}

function Block({ block }: { block: BlockType }) {
  switch (block.type) {
    case "p":
      return (
        <p class="text-base sm:text-base text-base-content/80 leading-relaxed my-3 px-0">{block.text}</p>
      );

    case "code":
      return (
        <div class="my-4">
          <CodeBlock
            lang={block.lang}
            text={block.text}
            filename={block.filename}
          />
        </div>
      );

    case "h3":
      return <h3 class="text-lg font-semibold mt-6 mb-2 px-0">{block.text}</h3>;

    case "tip":
      return (
        <div class="alert bg-success/10 border rounded-xl border-success/20 my-4 text-sm px-5 sm:px-4 py-3">
          <span class="text-success font-semibold mr-1">Tip:</span>
          <span class="text-base-content/80">{block.text}</span>
        </div>
      );

    case "warning":
      return (
        <div class="alert bg-warning/10 border rounded-xl border-warning/20 my-4 text-sm px-5 sm:px-4 py-3">
          <span class="text-warning font-semibold mr-1">Warning:</span>
          <span class="text-base-content/80">{block.text}</span>
        </div>
      );

    case "list":
      return (
        <ul class="list-disc list-inside my-3 space-y-1.5 px-0">
          {block.items.map((item, i) => (
            <li key={i} class="text-base-content/80 text-sm sm:text-sm leading-relaxed">{item}</li>
          ))}
        </ul>
      );

    case "table":
      return (
        <div class="overflow-x-auto my-4 rounded-xl border border-base-300">
          <table class="table table-sm w-full">
            <thead>
              <tr>
                {block.headers.map((h) => (
                  <th key={h} class="bg-base-200 text-xs uppercase tracking-wide py-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} class="hover:bg-base-200/50">
                  {row.map((cell, j) => (
                    <td key={j} class="font-mono text-xs py-3">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return null;
  }
}

function PrevNext(
  { manifest, currentSlug }: { manifest: ManifestItem[]; currentSlug: string },
) {
  const idx = manifest.findIndex((m) => m.slug === currentSlug);
  const prev = idx > 0 ? manifest[idx - 1] : null;
  const next = idx < manifest.length - 1 ? manifest[idx + 1] : null;

  return (
    <div class="flex justify-between gap-4 mt-10 pt-6 border-t border-base-300">
      {prev
        ? (
          <a href={`/docs/${prev.slug}`} class="group flex flex-col max-w-xs py-2">
            <span class="text-xs text-base-content/40 mb-1">← Previous</span>
            <span class="text-base font-semibold group-hover:text-primary transition-colors">
              {prev.title}
            </span>
          </a>
        )
        : <div />}
      {next && (
        <a
          href={`/docs/${next.slug}`}
          class="group flex flex-col items-end max-w-xs py-2"
        >
          <span class="text-xs text-base-content/40 mb-1">Next →</span>
          <span class="text-base font-semibold group-hover:text-primary transition-colors">
            {next.title}
          </span>
        </a>
      )}
    </div>
  );
}

export default function DocPage(
  ctx: Context<State>,
): JSX.Element {
  const { slug } = ctx.params;
  const [doc, manifest] = [readDoc(slug), readManifest()];

  if (!doc) {
    return ctx.redirect("/docs") as unknown as JSX.Element;
  }

  return (
    <>
      <Head>
        <title>{doc.title} — Hound Docs</title>
        <meta name="description" content={doc.description} />
        <meta property="og:title" content={`${doc.title} — Hound Docs`} />
        <meta property="og:description" content={doc.description} />
        <meta property="og:image" content="https://hound.hushkey.dev/og-image.png" />
        <meta property="og:url" content={`https://hound.hushkey.dev/docs/${slug}`} />
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary_large_image" />
      </Head>
      <article class="sm:max-w-3xl sm:mx-auto sm:px-0 py-6 sm:py-10">
        {/* Page header */}
        <div class="mb-7 pb-5 border-b border-base-300 px-0">
          <h1 class="text-3xl sm:text-3xl font-bold tracking-tight mb-2">{doc.title}</h1>
          <p class="text-base text-base-content/60 leading-relaxed">{doc.description}</p>
        </div>

        {/* Table of contents */}
        {doc.sections.length > 2 && (
          <div class="bg-base-300/60 rounded-2xl border border-base-300 p-4 mb-7 shadow-sm">
            <p class="font-semibold text-xs uppercase tracking-widest text-base-content/50 mb-2">
              On this page
            </p>
            <ul class="space-y-0.5">
              {doc.sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    class="block py-1.5 text-sm text-base-content/60 hover:text-primary transition-colors"
                  >
                    {s.heading}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sections */}
        {doc.sections.map((section) => (
          <section key={section.id} id={section.id} class="mb-10 scroll-mt-24 sm:scroll-mt-8">
            <h2 class="text-xl sm:text-xl font-semibold mb-4 flex items-center gap-2 px-0">
              <a
                href={`#${section.id}`}
                class="hover:text-primary transition-colors"
              >
                {section.heading}
              </a>
            </h2>
            {section.blocks.map((block, i) => <Block key={i} block={block} />)}
          </section>
        ))}

        <div class="px-0">
          <PrevNext manifest={manifest} currentSlug={slug} />
        </div>
      </article>
    </>
  );
}
