export interface Message {
  role: "user" | "assistant";
  markdown: string;
}

export const conversation: Message[] = [
  {
    role: "user",
    markdown:
      "Can you help me build a virtualized chat renderer? I want something that handles **rich markdown** with code blocks, tables, math — the works.",
  },
  {
    role: "assistant",
    markdown: `Absolutely. The key insight is that a chat renderer is really a **markdown document viewer** with two presentation lanes — one for the user, one for the assistant.

Here's the architecture I'd suggest:

1. **Parse** each message's markdown into HTML at mount time
2. **Measure** rendered heights for virtualization
3. **Project** only visible messages into the DOM on scroll

The parsing layer should support the full CommonMark + GFM spec. Let me show you what that looks like with comrak:

\`\`\`typescript
import init, { mdToHtml } from "@typefm/comrak-wasm";

await init();

const html = mdToHtml(message.markdown, {
  extension: {
    strikethrough: true,
    table: true,
    tasklist: true,
    autolink: true,
    alerts: true,
    footnotes: true,
    mathDollars: true,
  },
  render: { unsafe: true },
});
\`\`\`

This gives us a fast, single-pass renderer that handles everything from \`inline code\` to $E = mc^2$.`,
  },
  {
    role: "user",
    markdown:
      "That's a great start. What about syntax highlighting for the code blocks? I want something like GitHub's rendering.",
  },
  {
    role: "assistant",
    markdown: `For syntax highlighting, we can plug **Shiki** directly into comrak's plugin system. Shiki uses the same TextMate grammars as VS Code, so you get identical highlighting.

\`\`\`typescript
import { createHighlighter } from "shiki";

const shiki = await createHighlighter({
  themes: ["github-dark"],
  langs: ["typescript", "rust", "python", "bash"],
});

const highlighter = new SyntaxHighlighter(
  (code, lang) => {
    if (!lang) return code;
    const html = shiki.codeToHtml(code, {
      lang,
      theme: "github-dark",
    });
    // Extract inner HTML from shiki's wrapper
    const match = html.match(
      /<pre[^>]*><code[^>]*>([\\s\\S]*?)<\\/code><\\/pre>/
    );
    return match?.[1] ?? code;
  },
  () => '<pre class="shiki">',
  () => "<code>",
);
\`\`\`

The beauty of this approach is that highlighting happens at parse time, not render time. Once a message is parsed, the highlighted HTML is cached.`,
  },
  {
    role: "user",
    markdown:
      "Nice. Can you show me what a table looks like? I want to make sure complex markdown renders correctly.",
  },
  {
    role: "assistant",
    markdown: `Here's a comparison table of markdown rendering approaches:

| Approach | Speed | Fidelity | Streaming |
|----------|-------|----------|-----------|
| \`marked\` + DOM | Fast | Good | Manual |
| \`markdown-it\` | Medium | Great | Plugin |
| \`comrak-wasm\` | **Fastest** | **Excellent** | \`healMarkdown\` |
| \`remark/rehype\` | Slow | Great | Complex |

And here's a feature matrix for the GFM extensions we're using:

| Feature | Syntax | Rendered |
|---------|--------|----------|
| Bold | \`**text**\` | **bold text** |
| Italic | \`*text*\` | *italic text* |
| Strikethrough | \`~~text~~\` | ~~struck~~ |
| Task list | \`- [x] done\` | Checkbox |
| Footnote | \`text[^1]\` | Superscript link |
| Math | \`$x^2$\` | Inline formula |
| Highlight | \`==text==\` | ==highlighted== |`,
  },
  {
    role: "user",
    markdown:
      "What about streaming? When the assistant is generating a response, the markdown is incomplete — unclosed code fences, dangling bold markers, etc.",
  },
  {
    role: "assistant",
    markdown: `This is where \`healMarkdown\` shines. It's a lightweight function that closes any unclosed delimiters before parsing:

\`\`\`typescript
import { healMarkdown, mdToHtml } from "@typefm/comrak-wasm";

function renderStreaming(partial: string): string {
  // healMarkdown closes unclosed fences, bold,
  // italic, links, math blocks, etc.
  const healed = healMarkdown(partial);
  return mdToHtml(healed, options);
}
\`\`\`

It handles all the edge cases:

- Unclosed code fences (\`\`\`\`\`\`)
- Dangling bold (\`**\`) and italic (\`*\`) markers
- Incomplete links \`[text](url\`
- Open math blocks (\`$$\`)
- Unclosed inline code backticks
- Partial HTML tags

> [!TIP]
> The \`healMarkdown\` function is pure string manipulation — no parsing involved. It runs in microseconds, so you can call it on every streaming chunk without worrying about performance.

The streaming flow looks like this:

1. Receive chunk from SSE/WebSocket
2. Append to accumulated text
3. \`healMarkdown(accumulated)\` → closed markdown
4. \`mdToHtml(healed)\` → safe HTML
5. Diff and patch the DOM`,
  },
  {
    role: "user",
    markdown: `Let's talk about the visual design. I want something dark and polished — like a premium chat app. No generic chatbot vibes.`,
  },
  {
    role: "assistant",
    markdown: `Here's the design system I'd go with — inspired by editorial design rather than typical chat UI:

**Color palette:**
- Background: \`#1a1d23\` — near-black with a slight blue undertone
- Surface: \`#22262e\` — for cards and elevated elements
- Bubble: \`#2a2f38\` — user message bubbles
- Text primary: \`#d5d9e1\` — high-contrast but not pure white
- Text muted: \`#8b919d\` — timestamps, metadata
- Accent: \`#7c9cff\` — links and interactive elements
- Border: \`rgba(255, 255, 255, 0.06)\`

**Typography:**
- Body: \`-apple-system\` system font, 14px/22px
- Code: \`"SF Mono", "Fira Code"\`, 12.5px/20px
- Headings: system font, semi-bold, slightly larger

**Two-lane layout:**
- **Assistant messages** — left-aligned, no bubble, no background. Clean editorial feel. Content sits directly on the surface.
- **User messages** — right-aligned, wrapped in a subtle bubble with \`border-radius: 18px\` and \`max-width: 78%\`.

**Code blocks** get their own treatment:
- \`background: #161920\`
- Rounded corners (10px)
- Subtle top border for language badge
- Shiki-highlighted with \`github-dark\` theme

This creates a clear visual hierarchy where assistant responses feel like *reading an article* while user messages feel like *sending a text*.`,
  },
  {
    role: "user",
    markdown:
      "Show me some nested list examples to make sure those render correctly too.",
  },
  {
    role: "assistant",
    markdown: `Here's a project structure as a nested list:

1. **Architecture layers**
   - Parsing layer
     - Markdown tokenization (comrak)
     - Syntax highlighting (Shiki)
     - Math rendering (KaTeX)
   - Virtualization layer
     - Height prediction
     - Visible range calculation
     - DOM recycling
   - Rendering layer
     - Message materialization
     - Fragment positioning
     - Scroll synchronization

2. **Build pipeline**
   - \`comrak\` → Rust → WASM (900KB)
   - \`shiki\` → TextMate grammars → \`codeToHtml\`
   - \`vite\` → ES modules → tree-shaken bundle

And a task list for our implementation:

- [x] Set up Vite project with comrak-wasm
- [x] Create dark theme CSS
- [x] Implement two-lane message layout
- [x] Add Shiki syntax highlighting
- [x] Wire up \`healMarkdown\` for streaming
- [x] Build sample conversation data
- [ ] Add virtualization for 10k+ messages
- [ ] Implement scroll anchoring
- [ ] Add resize observer for responsive layout`,
  },
  {
    role: "user",
    markdown:
      "Can you show me a Rust example too? I want to see how cross-language highlighting works.",
  },
  {
    role: "assistant",
    markdown: `Here's the Rust side of comrak-wasm — the actual WASM binding:

\`\`\`rust
use comrak::{markdown_to_html, Options};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn md_to_html(md: &str, opts: JsValue) -> Result<String, JsError> {
    let options = parse_options(opts)?;
    Ok(markdown_to_html(md, &options))
}

fn parse_options(opts: JsValue) -> Result<Options, JsError> {
    let mut options = Options::default();

    // Extension options
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;

    Ok(options)
}
\`\`\`

And here's a Python equivalent using \`cmark-gfm\`:

\`\`\`python
import cmark_gfm

def render_markdown(text: str) -> str:
    """Render GFM markdown to HTML."""
    extensions = [
        "strikethrough",
        "table",
        "autolink",
        "tasklist",
    ]
    return cmark_gfm.github_flavored_markdown_to_html(
        text, extensions=extensions
    )
\`\`\`

And a bash script for quick CLI rendering:

\`\`\`bash
#!/usr/bin/env bash
# Render markdown files to HTML using comrak-wasm CLI
for file in docs/*.md; do
  echo "Rendering $file..."
  npx comrak-wasm "$file" > "\${file%.md}.html"
done
echo "Done! Rendered $(ls docs/*.html | wc -l) files."
\`\`\`

All three languages get proper syntax highlighting through Shiki's TextMate grammar system.`,
  },
  {
    role: "user",
    markdown:
      "What about blockquotes and alerts? GitHub-style admonitions would be great.",
  },
  {
    role: "assistant",
    markdown: `Comrak supports GitHub's alert syntax natively. Here are all five types:

> [!NOTE]
> This is informational context that helps the reader understand something without being critical to the task at hand.

> [!TIP]
> Helpful advice for doing things better or more easily. Tips are optional optimizations.

> [!IMPORTANT]
> Key information the user needs to know to achieve their goal. Missing this could lead to confusion.

> [!WARNING]
> Urgent information that needs immediate attention to prevent problems. Proceed with caution.

> [!CAUTION]
> Advises about risks or negative outcomes. This is the strongest admonition — use sparingly.

And standard blockquotes work too, of course:

> The art of programming is the art of organizing complexity,
> of mastering multitude and avoiding its bastard chaos
> as effectively as possible.
>
> — *Edsger W. Dijkstra*

You can nest them:

> **User question:** How do I handle nested blockquotes?
>
> > The parser handles arbitrary nesting depth. Each level
> > gets its own left border in the rendered output.
> >
> > > Three levels deep is usually the practical limit
> > > for readability.`,
  },
  {
    role: "user",
    markdown: `This is looking fantastic. One last thing — can you show me some inline formatting combinations? Bold + italic + code + links all mixed together.`,
  },
  {
    role: "assistant",
    markdown: `Here's the full inline formatting toolkit:

**Bold text** and *italic text* and ***bold italic*** together. Mix in some \`inline code\` and ~~strikethrough~~ for variety. Links work inline too: check the [comrak docs](https://docs.rs/comrak) or the [GitHub repo](https://github.com/kivikakk/comrak).

You can combine them freely:
- **Bold with \`code\` inside** works perfectly
- *Italic with [a link](https://example.com) embedded*
- ~~Strikethrough with **bold** inside~~
- \`code spans preserve **asterisks** literally\`

Superscript and subscript: x^2^ + y^2^ = r^2^, and H~2~O is water.

==Highlighted text== stands out, and ++inserted text++ shows additions.

---

Here's a fun one — a markdown message *about* markdown:

> To write \`inline code\`, wrap text in backticks. For **bold**, use double asterisks. For a [link](url), use \`[text](url)\` syntax. And for a blockquote like this one, prefix lines with \`>\`.

The recursive nature of this conversation — markdown rendered by a markdown renderer, discussing markdown rendering — is exactly the kind of stress test we need. Every message in this thread is a live proof that the renderer handles real-world content correctly.`,
  },
  {
    role: "user",
    markdown: "Perfect. Let's ship it.",
  },
  {
    role: "assistant",
    markdown: `Done. The full demo renders this entire conversation as a scrollable, dark-themed chat — every code block highlighted, every table aligned, every alert styled.

All powered by a single ~900KB WASM binary. No server, no build step beyond Vite, no runtime dependencies beyond Shiki for highlighting.

\`\`\`
comrak-wasm    → markdown parsing (WASM)
shiki          → syntax highlighting
healMarkdown   → streaming support
vite           → dev server + bundling
\`\`\`

Run \`pnpm run dev\` and see it live.`,
  },
];
