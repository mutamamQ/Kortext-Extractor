/*
 * Kortext PDF export helper (v5).
 *
 * Requires: kortext-extract.js (v4) already installed in the same page
 * (window.__ktxCapture and the content base must be live). Paste this AFTER
 * kortext-extract.js, once your reading session has captured at least one
 * content API request (read a page or two).
 *
 * Usage:
 *   await window.__ktxExportPdf()   // harvests the book (reusing v4 capture),
 *                                   // then opens the print dialog — pick
 *                                   // "Save as PDF" as the destination.
 *
 * How it works:
 *   1. Reuses v4's harvest: fetches every chapter/image/CSS from the content
 *      API (or takes already-captured bytes).
 *   2. Builds one long HTML document in reading (spine) order, rewriting all
 *      relative image/CSS/font references to blob: URLs so nothing hits the
 *      network and all subresources load offline from memory.
 *   3. Renders it in a hidden iframe and calls print() on it. The browser's
 *      own layout engine does the PDF — tables, figures, and math come out
 *      exactly as the reader renders them.
 */
(() => {
  "use strict";

  const TAG = "[ktx-pdf]";
  const log = (...args) => {
    try { console.log(TAG, ...args); } catch (_) {}
  };
  const quietly = (fn) => {
    try { return fn(); } catch (_) { return undefined; }
  };

  if (window.__ktxExportPdfInstalled) {
    log("already installed");
    return;
  }
  window.__ktxExportPdfInstalled = true;

  const encoder = new TextEncoder();

  if (!(window.__ktxCapture instanceof Map)) {
    log("ERROR: run kortext-extract.js first (window.__ktxCapture is missing)");
    return;
  }

  function decodeText(bytes) {
    return quietly(() => new TextDecoder("utf-8").decode(bytes)) || "";
  }

  function copyBytes(value) {
    try {
      if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(
          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        );
      }
    } catch (_) {}
    return null;
  }

  function absoluteUrl(value) {
    return quietly(() => new URL(String(value), location.href).href) || String(value || "");
  }

  // Book root: https://host/api/content/v1/epub/epub-page/<id>/ (files keep OEBPS/, EPUB/...)
  function contentBase() {
    for (const entry of window.__ktxCapture.values()) {
      const url = quietly(() => new URL(entry.url));
      const m = url && url.pathname.match(/^(.*\/api\/content\/v1\/epub\/[^/]+\/[^/]+\/)[^/]+\/./);
      if (m) return url.origin + m[1];
    }
    const id = (location.pathname.match(/\/reader\/epub\/(\d+)/) || [])[1];
    return id ? `${location.origin}/api/content/v1/epub/epub-page/${id}/` : null;
  }

  function internalPathOf(url, base) {
    return quietly(() => decodeURIComponent(new URL(url).pathname)
      .slice(new URL(base).pathname.length)) || null;
  }

  function resolveInternal(fromPath, ref) {
    ref = String(ref || "").trim();
    if (!ref || /^(https?:|data:|blob:|mailto:|tel:|#)/i.test(ref)) return null;
    const rawPath = ref.split("#")[0].split("?")[0];
    const refPath = quietly(() => decodeURIComponent(rawPath)) || rawPath;
    if (!refPath) return null;
    const stack = fromPath.split("/");
    stack.pop();
    for (const part of refPath.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const path = stack.filter((p) => p && p !== ".").join("/");
    return path && !path.startsWith("..") ? path : null;
  }

  function mediaTypeFor(path) {
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1];
    switch ((ext || "").toLowerCase()) {
      case "xhtml": case "html": case "htm": return "application/xhtml+xml";
      case "css": return "text/css";
      case "jpg": case "jpeg": return "image/jpeg";
      case "png": return "image/png";
      case "gif": return "image/gif";
      case "svg": return "image/svg+xml";
      case "webp": return "image/webp";
      case "ttf": return "font/ttf";
      case "otf": return "font/otf";
      case "woff": return "font/woff";
      case "woff2": return "font/woff2";
      default: return "application/octet-stream";
    }
  }

  async function fetchResource(url) {
    try {
      const response = await (window.__ktxNativeFetch || window.fetch)(url, {
        credentials: "include",
        headers: window.__ktxAuthHeaders || {} // reader's Bearer + x-drm-* (chapters 401 otherwise)
      });
      if (!response.ok) return null;
      const bytes = copyBytes(await response.arrayBuffer());
      return bytes && bytes.byteLength ? bytes : null;
    } catch (_) {
      return null;
    }
  }

  const REF_ATTR = /(?:src|href|xlink:href)\s*=\s*["']([^"']+)["']/gi;
  const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

  function collectRefs(path, text) {
    const refs = [];
    let m;
    REF_ATTR.lastIndex = 0;
    while ((m = REF_ATTR.exec(text))) {
      const internal = resolveInternal(path, m[1]);
      if (internal) refs.push(internal);
    }
    if (/\.css$/i.test(path)) {
      CSS_URL.lastIndex = 0;
      while ((m = CSS_URL.exec(text))) {
        const internal = resolveInternal(path, m[1]);
        if (internal) refs.push(internal);
      }
    }
    return refs;
  }

  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  // Same harvest as v4, but returns files keyed by internal path.
  async function harvest(base) {
    const files = new Map();
    const queue = [];
    const queued = new Set();
    let fetchedCount = 0;
    const MAX_RESOURCES = 4000;

    function enqueue(internalPath) {
      if (!internalPath || files.has(internalPath) || queued.has(internalPath)) return;
      if (files.size + queue.length >= MAX_RESOURCES) return;
      queued.add(internalPath);
      queue.push(internalPath);
    }

    for (const entry of window.__ktxCapture.values()) {
      if (!entry.bytes || !entry.bytes.byteLength) continue;
      const internal = internalPathOf(entry.url, base);
      if (!internal || internal.startsWith("..")) continue;
      if (!files.has(internal)) files.set(internal, entry.bytes.slice(0));
    }

    // Spine order from the real package document if available
    // (container.xml points at it, e.g. OEBPS/content.opf).
    const get = async (path) => {
      if (files.has(path)) return files.get(path);
      const bytes = await fetchResource(base + path.split("/").map(encodeURIComponent).join("/"));
      if (bytes) files.set(path, bytes);
      return bytes;
    };
    const container = await get("META-INF/container.xml");
    const fromContainer = container &&
      (decodeText(container).match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i) || [])[1];
    const dirs = new Set(Array.from(files.keys()).map((p) => p.split("/")[0] + "/").filter((d) => d !== "META-INF/"));
    const candidates = [fromContainer, ...[...dirs, "OEBPS/", "EPUB/", ""].flatMap((d) =>
      [`${d}content.opf`, `${d}package.opf`])].filter(Boolean);
    let opf = null;
    files.opfPath = null;
    for (const path of new Set(candidates)) {
      const bytes = await get(path);
      if (bytes && /<package\b/i.test(decodeText(bytes).slice(0, 4096))) {
        opf = bytes;
        files.opfPath = path;
        log("using the server's package document for spine order:", path);
        break;
      }
      if (bytes && path !== fromContainer) files.delete(path);
    }

    if (opf) {
      const text = decodeText(opf);
      let m;
      const ITEM_HREF = /<item[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
      while ((m = ITEM_HREF.exec(text))) {
        const internal = resolveInternal(files.opfPath, m[1]);
        if (internal) enqueue(internal);
      }
    }

    // captured chapters are already in `files`, so follow their refs up front
    for (const [path, bytes] of Array.from(files)) {
      if (!/\.(xhtml|html|htm|css|opf|ncx|svg)$/i.test(path)) continue;
      for (const ref of collectRefs(path, decodeText(bytes))) enqueue(ref);
    }

    // worker pool: keep CONCURRENCY fetches in flight for speed
    const CONCURRENCY = 24;
    async function worker() {
      while (queue.length) {
        const internalPath = queue.shift();
        if (files.has(internalPath)) continue;
        const bytes = await fetchResource(base + internalPath.split("/").map(encodeURIComponent).join("/"));
        if (!bytes) continue;
        fetchedCount += 1;
        files.set(internalPath, bytes);
        if (/\.(xhtml|html|htm|css|opf|ncx|svg)$/i.test(internalPath)) {
          for (const ref of collectRefs(internalPath, decodeText(bytes))) enqueue(ref);
        }
        if (fetchedCount % 100 === 0) log(`harvesting... ${files.size} resources so far`);
      }
    }
    while (queue.length) {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    }

    log(`harvest complete: ${files.size} resources (${fetchedCount} fetched directly)`);
    return files;
  }

  // Spine order from the package document (or natural sort fallback).
  function spineOrder(files) {
    const opf = files.opfPath && files.get(files.opfPath);
    if (opf) {
      const text = decodeText(opf);
      const order = [];
      let m;
      const ITEMREF = /<itemref[^>]*\bidref\s*=\s*["']([^"']+)["']/gi;
      const idToHref = new Map();
      // read id and href separately; they can appear in either order
      for (const tag of text.match(/<item\b[^>]*>/gi) || []) {
        const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
        const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (id && href) idToHref.set(id[1], href[1]);
      }
      while ((m = ITEMREF.exec(text))) {
        const href = idToHref.get(m[1]);
        const internal = href && resolveInternal(files.opfPath, href);
        if (internal && files.has(internal)) order.push(internal);
      }
      if (order.length) return order;
    }
    return Array.from(files.keys())
      .filter((p) => /\.x?html?$/i.test(p) && !/^META-INF\//i.test(p))
      .sort(naturalCompare);
  }

  // Rewrite a chapter's references to blob: URLs and extract its <body>.
  function chapterHtml(path, text, blobUrls) {
    const rewrite = (ref) => {
      const internal = resolveInternal(path, ref);
      if (internal && blobUrls.has(internal)) return blobUrls.get(internal);
      return ref;
    };
    // swap only the value part, so a ref like "s" can't hit the "s" in "src="
    const swapValue = (whole, ref, value) => {
      const at = whole.lastIndexOf(ref);
      return at < 0 ? whole : whole.slice(0, at) + value + whole.slice(at + ref.length);
    };
    let html = text.replace(REF_ATTR, (whole, ref) => swapValue(whole, ref, rewrite(ref)));
    html = html.replace(CSS_URL, (whole, ref) => swapValue(whole, ref, rewrite(ref)));
    // the print doc is parsed as HTML, where XHTML <a id="p5"/> or <span/>
    // would stay open and swallow the rest of the chapter
    html = html.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g, (whole, tag, attrs) =>
      VOID_TAGS.has(tag.toLowerCase()) ? whole : `<${tag}${attrs || ""}></${tag}>`);
    return html;
  }

  const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "source", "track", "wbr"
  ]);

  function extractBody(html) {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return m ? m[1] : html;
  }

  function extractHead(html) {
    const m = html.match(/<head[^>]*>([\s\S]*)<\/head>/i);
    return m ? m[1] : "";
  }

  window.__ktxExportPdf = async function ktxExportPdf() {
    if (window.__ktxPdfRunning) {
      log("PDF export already in progress");
      return null;
    }
    window.__ktxPdfRunning = true;
    try {
      const base = contentBase();
      if (!base) {
        log("no content API requests captured yet — read at least one page first");
        return null;
      }

      const files = await harvest(base);
      if (!files.size) {
        log("harvest found nothing");
        return null;
      }

      // Blob URLs for every non-HTML resource (images, css, fonts).
      log("creating blob URLs for subresources...");
      const blobUrls = new Map();
      for (const [path, bytes] of files) {
        if (/\.x?html?$/i.test(path)) continue;
        const type = mediaTypeFor(path);
        try {
          blobUrls.set(path, URL.createObjectURL(new Blob([bytes], { type })));
        } catch (_) {}
      }
      log(`${blobUrls.size} subresources mapped to blob URLs`);

      // Assemble one document in spine order.
      const order = spineOrder(files);
      log(`assembling ${order.length} chapters in spine order`);
      const parts = [];
      const collectedCss = [];
      for (const path of order) {
        const html = chapterHtml(path, decodeText(files.get(path)), blobUrls);
        const head = extractHead(html);
        // Collect <style> blocks. Linked stylesheets are already inlined
        // below (cssParts) with their url()s rewritten, so they're skipped here.
        const styleMatches = head.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
        collectedCss.push(...styleMatches);
        parts.push(extractBody(html));
      }

      // Also rewrite CSS files' url() references via blob indirection.
      const cssParts = [];
      for (const [path, bytes] of files) {
        if (!/\.css$/i.test(path)) continue;
        const text = decodeText(bytes).replace(CSS_URL, (whole, ref) => {
          const internal = resolveInternal(path, ref);
          return internal && blobUrls.has(internal) ? whole.replace(ref, blobUrls.get(internal)) : whole;
        });
        cssParts.push(`<style data-ktx-path="${path}">\n${text}\n</style>`);
      }

      const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${((files.opfPath && (decodeText(files.get(files.opfPath)).match(/<dc:title[^>]*>([^<]{1,200})<\/dc:title>/i) || [])[1]) || document.title || "book").replace(/</g, "&lt;")}</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  body { font-family: Georgia, "Times New Roman", serif; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
</style>
${cssParts.join("\n")}
${collectedCss.join("\n")}
</head>
<body>
${parts.join('\n<hr class="ktx-page-break" style="page-break-after: always; border: 0; margin: 0;"/>')}
</body>
</html>`;

      // Render in a hidden iframe and print it.
      log("rendering print document (waiting for images)...");
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed; right:0; bottom:0; width:1024px; height:768px; opacity:0.01; border:0; z-index:-1;";
      document.body.appendChild(iframe);

      const blob = new Blob([doc], { type: "text/html" });
      const docUrl = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        iframe.onload = resolve;
        iframe.src = docUrl;
      });

      // Wait for every image inside the iframe to load (blob URLs are fast).
      await new Promise((resolve) => {
        const idoc = iframe.contentDocument;
        if (!idoc) return resolve();
        const imgs = Array.from(idoc.images || []);
        if (!imgs.length) return resolve();
        let remaining = imgs.length;
        const done = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
        };
        for (const img of imgs) {
          if (img.complete) done();
          else {
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          }
        }
        setTimeout(resolve, 120000); // hard cap: 2 minutes
      });

      log("opening print dialog — choose 'Save as PDF' as the destination");
      // Give the renderer a moment to settle layout, then print.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      quietly(() => iframe.contentWindow.focus());
      iframe.contentWindow.print();

      // Cleanup after the dialog is handled.
      setTimeout(() => {
        quietly(() => iframe.remove());
        quietly(() => URL.revokeObjectURL(docUrl));
      }, 300000);

      log("print dialog opened; if nothing appears, the document is also available at window.__ktxPdfDocUrl");
      window.__ktxPdfDocUrl = docUrl;
      return docUrl;
    } catch (error) {
      log("PDF export failed:", error);
      return null;
    } finally {
      window.__ktxPdfRunning = false;
    }
  };

  log("ready; call await window.__ktxExportPdf() to build and print the PDF");
})();
