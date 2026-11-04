(() => {
  "use strict";

  /*
   * Kortext personal-backup helper (v4).
   *
   * Paste into DevTools console on the reader page, then reload the page so
   * the hooks are active while you read (this captures chapters you visit).
   * Call window.__ktxExport() whenever you like — the export itself will
   * HARVEST the rest of the book directly from the content API:
   *
   *  1. It looks for the real EPUB package document
   *     (/api/content/v1/epub/epub-page/<id>/EPUB/package.opf). If the
   *     server serves it, the full manifest + spine is used verbatim.
   *  2. Otherwise it parses every captured chapter for src/href/url()
   *     references (images, CSS, fonts, linked chapters, TOC entries),
   *     resolves them against the content API base URL, and fetches them.
   *  3. Images and other subresources never go through fetch()/XHR while
   *     reading (they are plain <img> loads), so they are fetched at export.
   *  4. The archive keeps the original EPUB/ directory layout so all
   *     relative links keep working.
   */

  const TAG = "[ktx]";
  const log = (...args) => {
    try { console.log(TAG, ...args); } catch (_) {}
  };
  const quietly = (fn) => {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  };

  if (window.__ktxInstalled) {
    log("already installed; captures and hooks were left in place");
    return;
  }

  const encoder = new TextEncoder();
  const capture = window.__ktxCapture instanceof Map
    ? window.__ktxCapture
    : new Map();
  window.__ktxCapture = capture;
  window.__ktxInstalled = true;
  if (typeof window.__ktxWalk !== "boolean") window.__ktxWalk = true;

  let captureSequence = 0;
  let exporting = false;

  const NOISE_URL = new RegExp(
    "applicationinsights|google-analytics|googletagmanager" +
    "|[?&]charCount=|/telemetry|/track(/|$)|beacon" +
    "|\\.(js|mjs|css|map)(\\?|$)",
    "i"
  );

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
    return quietly(() => new URL(String(value), location.href).href) || String(value || "unknown");
  }

  function isNoise(url) {
    return quietly(() => NOISE_URL.test(String(url))) || false;
  }

  function rememberNetwork(url, bytes, contentType, source) {
    try {
      if (!bytes || !bytes.byteLength) return null;
      const key = absoluteUrl(url);
      if (isNoise(key)) return null;
      let entry = capture.get(key);
      if (entry) {
        if (!entry.contentType && contentType) entry.contentType = contentType;
        return entry;
      }
      entry = {
        url: key,
        bytes,
        contentType: contentType || "",
        source,
        order: ++captureSequence,
        capturedAt: Date.now()
      };
      capture.set(key, entry);
      log(`captured ${capture.size} resource(s):`, key, `(${bytes.byteLength} bytes, via ${source})`);
      return entry;
    } catch (_) {
      return null;
    }
  }

  // ---- runtime hooks (capture what the reader reads) ---------------------------

  function hookFetch(win, label) {
    quietly(() => {
      const originalFetch = win.fetch;
      if (typeof originalFetch !== "function" || originalFetch.__ktxHooked) return;
      const wrapped = async function ktxFetch(...args) {
        const request = args[0];
        const method = quietly(() => (args[1] && args[1].method) ||
          (request && request.method) || "GET") || "GET";
        const url = absoluteUrl(quietly(() => (request && request.url) || request) || "");
        const sameOrigin = quietly(() => new URL(url, location.href).origin === location.origin) || false;
        const trackable = sameOrigin && String(method).toUpperCase() === "GET" && !isNoise(url);

        let response;
        response = await originalFetch.apply(this, args);

        if (!trackable || !response || !response.ok || !response.body) return response;
        try {
          const bytes = copyBytes(await response.arrayBuffer());
          if (!bytes || !bytes.byteLength) return response;
          const type = quietly(() => response.headers.get("content-type")) || "";
          rememberNetwork(url, bytes, type, `fetch/${label}`);

          const headers = new win.Headers(response.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          const replay = new win.Response(bytes.slice(0), {
            status: response.status,
            statusText: response.statusText,
            headers
          });
          Object.defineProperty(replay, "url", { value: url, configurable: true });
          return replay;
        } catch (_) {
          try {
            return new win.Response(new Uint8Array(0), {
              status: response.status,
              statusText: response.statusText
            });
          } catch (_) {
            return response;
          }
        }
      };
      wrapped.__ktxHooked = true;
      win.fetch = wrapped;
      log(`fetch hook installed (${label})`);
    });
  }

  function hookWindow(win) {
    hookFetch(win, win === window ? "top" : "iframe");
  }

  hookWindow(window);
  setInterval(() => {
    quietly(() => {
      hookWindow(window);
      document.querySelectorAll("iframe, frame").forEach((frame) => {
        const win = quietly(() => frame.contentWindow);
        if (win) hookWindow(win);
      });
    });
  }, 1000);

  // ---- helpers ----------------------------------------------------------------

  function startsWithPdf(bytes) {
    return bytes && bytes.byteLength >= 5 &&
      bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
      bytes[3] === 0x46 && bytes[4] === 0x2d;
  }

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  function decodeText(bytes) {
    return quietly(() => new TextDecoder("utf-8").decode(bytes)) || "";
  }

  // Find the content API base from captured URLs:
  //   https://host/api/content/v1/epub/epub-page/<id>/EPUB/content/x.xhtml
  //   -> https://host/api/content/v1/epub/epub-page/<id>/EPUB/
  function contentBase() {
    for (const entry of capture.values()) {
      const m = quietly(() => entry.url.match(/^(.*\/api\/content\/v1\/epub\/[^/]+\/[^/]+\/EPUB\/)/));
      if (m) return m[1];
    }
    return null;
  }

  // Internal path of a captured URL relative to EPUB/
  //   .../EPUB/content/1.0.xhtml -> content/1.0.xhtml
  function internalPathOf(url, base) {
    return quietly(() => decodeURIComponent(new URL(url).pathname)
      .slice(new URL(base).pathname.length)) || null;
  }

  // Resolve a relative reference from an internal path, staying inside EPUB/.
  function resolveInternal(fromPath, ref) {
    ref = String(ref || "").trim();
    if (!ref || /^(https?:|data:|blob:|mailto:|tel:|#)/i.test(ref)) return null;
    const refPath = ref.split("#")[0].split("?")[0];
    if (!refPath) return null;
    const stack = fromPath.split("/");
    stack.pop(); // drop filename -> directory of the referencing file
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
      case "opf": return "application/oebps-package+xml";
      case "ncx": return "application/x-dtbncx+xml";
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

  function safeTitle() {
    const fromPage = (document.title || "")
      .replace(/\s*[|–—-]\s*(Kortext|EPUB Reader).*$/i, "")
      .replace(/\s*_\s*EPUB Reader.*$/i, "")
      .trim();
    if (fromPage && !/^kortext$/i.test(fromPage)) {
      return fromPage.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 120);
    }
    return "book";
  }

  function titleFromChapters(files) {
    for (const file of files.values()) {
      if (!/\.x?html?$/i.test(file.path)) continue;
      const match = decodeText(file.bytes).slice(0, 8192).match(
        /<title[^>]*>([^<]{1,200})<\/title>/i
      );
      const candidate = match && match[1].trim();
      if (candidate && !/^untitled$/i.test(candidate) && !/chapter \d+/i.test(candidate)) {
        return candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120);
      }
    }
    return null;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---- stored ZIP writer --------------------------------------------------------

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[n] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.byteLength; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
      date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
    };
  }

  function write16(view, offset, value) { view.setUint16(offset, value, true); }
  function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function storedZip(files) {
    const localParts = [];
    const centralParts = [];
    const records = [];
    const stamp = dosDateTime(new Date());
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.bytes;
      const checksum = crc32(data);
      const local = new Uint8Array(30);
      const localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, stamp.time);
      write16(localView, 12, stamp.date);
      write32(localView, 14, checksum);
      write32(localView, 18, data.byteLength);
      write32(localView, 22, data.byteLength);
      write16(localView, 26, name.byteLength);
      write16(localView, 28, 0);
      localParts.push(local, name, data);
      records.push({ name, data, checksum, offset });
      offset += local.byteLength + name.byteLength + data.byteLength;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const record of records) {
      const central = new Uint8Array(46);
      const view = new DataView(central.buffer);
      write32(view, 0, 0x02014b50);
      write16(view, 4, 20);
      write16(view, 6, 20);
      write16(view, 8, 0x0800);
      write16(view, 10, 0);
      write16(view, 12, stamp.time);
      write16(view, 14, stamp.date);
      write32(view, 16, record.checksum);
      write32(view, 20, record.data.byteLength);
      write32(view, 24, record.data.byteLength);
      write16(view, 28, record.name.byteLength);
      write32(view, 42, record.offset);
      centralParts.push(central, record.name);
      centralSize += central.byteLength + record.name.byteLength;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 8, records.length);
    write16(endView, 10, records.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, centralOffset);
    return new Blob([...localParts, ...centralParts, end], { type: "application/epub+zip" });
  }

  // ---- harvest: fetch everything the book references ----------------------------

  async function fetchResource(url) {
    try {
      const response = await window.fetch(url, { credentials: "include" });
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
    REF_ATTR.lastValue = 0;
    while ((m = REF_ATTR.exec(text))) {
      const internal = resolveInternal(path, m[1]);
      if (internal) refs.push(internal);
    }
    if (/\.css$/i.test(path)) {
      while ((m = CSS_URL.exec(text))) {
        const internal = resolveInternal(path, m[1]);
        if (internal) refs.push(internal);
      }
    }
    return refs;
  }

  // Natural sort for chapter names like 0.2-x, 1.10-x, 10.0-x.
  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }

  async function harvest(base) {
    const files = new Map(); // internal path -> { path, bytes }
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

    function store(internalPath, bytes) {
      files.set(internalPath, { path: internalPath, bytes });
    }

    // Seed with everything captured from the content API, at its true path.
    for (const entry of capture.values()) {
      if (!entry.bytes || !entry.bytes.byteLength) continue;
      const internal = internalPathOf(entry.url, base);
      if (!internal || internal.startsWith("..")) continue;
      if (files.has(internal)) continue;
      store(internal, entry.bytes);
    }

    // 1) Try the real package document first.
    const opfUrl = `${base}package.opf`;
    let opf = quietly(() => files.get("package.opf"));
    if (!opf) {
      log("probing for the real package document:", opfUrl);
      const bytes = await fetchResource(opfUrl);
      if (bytes) {
        store("package.opf", bytes);
        opf = files.get("package.opf");
        log("package document retrieved from the server; using its manifest");
      }
    }

    if (opf) {
      const text = decodeText(opf.bytes);
      let m;
      const ITEM_HREF = /<(?:manifest:)?item[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
      while ((m = ITEM_HREF.exec(text))) {
        const internal = resolveInternal("package.opf", m[1]);
        if (internal) enqueue(internal);
      }
    }

    // 2) Crawl: process queue of internal paths, fetching missing ones and
    //    following references recursively (images, css, fonts, chapters, TOC).
    while (queue.length) {
      const batch = queue.splice(0, 8);
      const results = await Promise.all(batch.map(async (internalPath) => {
        if (files.has(internalPath)) return files.get(internalPath);
        const bytes = await fetchResource(base + internalPath.split("/").map(encodeURIComponent).join("/"));
        if (!bytes) {
          quietly(() => queued.delete(internalPath));
          return null;
        }
        fetchedCount += 1;
        store(internalPath, bytes);
        return files.get(internalPath);
      }));
      for (const file of results) {
        if (!file) continue;
        const isText = /\.(xhtml|html|htm|css|opf|ncx|svg)$/i.test(file.path);
        if (!isText) continue;
        const text = decodeText(file.bytes);
        for (const ref of collectRefs(file.path, text)) enqueue(ref);
      }
      if (fetchedCount && fetchedCount % 50 === 0) {
        log(`harvesting... ${files.size} resources so far`);
      }
    }

    log(`harvest complete: ${files.size} resources (${fetchedCount} fetched directly)`);
    return files;
  }

  // ---- export ------------------------------------------------------------------

  function synthesizePackageDocument(files, title) {
    const chapters = Array.from(files.keys())
      .filter((path) => /\.x?html?$/i.test(path) && !/^META-INF\//i.test(path))
      .sort(naturalCompare);

    const manifest = [];
    const spine = [];
    let index = 0;
    for (const path of Array.from(files.keys()).sort(naturalCompare)) {
      if (path === "package.opf" || /^META-INF\//i.test(path)) continue;
      manifest.push(`    <item id="ktx${index}" href="${xmlEscape(path)}" media-type="${mediaTypeFor(path)}"/>`);
      index += 1;
    }
    for (const path of chapters) {
      spine.push(`    <itemref idref="ktx${manifest.findIndex((line) => line.includes(`href="${xmlEscape(path)}"`))}"/>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="ktxid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="ktxid">urn:ktx:${Date.now()}</dc:identifier>
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine>
${spine.join("\n")}
  </spine>
</package>
`;
  }

  window.__ktxStatus = function ktxStatus() {
    const entries = Array.from(capture.values());
    const summary = {
      captured: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + (e.bytes ? e.bytes.byteLength : 0), 0),
      contentBase: contentBase(),
      urls: entries.map((e) => e.url)
    };
    log("status:", JSON.stringify(summary, null, 2));
    return summary;
  };

  window.__ktxExport = async function ktxExport() {
    if (exporting) {
      log("export already in progress");
      return null;
    }
    exporting = true;
    try {
      const base = contentBase();
      if (!base) {
        log("no content API requests captured yet — open/read at least one page, then export again");
        return null;
      }
      log("content base:", base);

      const all = Array.from(capture.values())
        .filter((entry) => entry && entry.bytes && entry.bytes.byteLength);

      // PDF books: a single PDF resource in captures -> direct download.
      const pdfs = all.filter((entry) => startsWithPdf(entry.bytes));
      if (pdfs.length === 1 && !all.some((entry) => /\/EPUB\//.test(entry.url))) {
        const blob = new Blob([pdfs[0].bytes], { type: "application/pdf" });
        download(blob, `${safeTitle()}.pdf`);
        log("exported one complete PDF", `(${pdfs[0].bytes.byteLength} bytes)`);
        return blob;
      }

      const files = await harvest(base);
      if (!files.size) {
        log("harvest found nothing; read a few pages first");
        return null;
      }

      const title = titleFromChapters(files) || safeTitle();

      const zipFiles = [
        { name: "mimetype", bytes: encoder.encode("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          bytes: encoder.encode(
            `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="package.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n`
          )
        }
      ];
      for (const file of files.values()) {
        if (file.path === "package.opf" || /^META-INF\//i.test(file.path)) continue;
        zipFiles.push({ name: file.path, bytes: file.bytes });
      }
      const realOpf = files.get("package.opf");
      zipFiles.push({
        name: "package.opf",
        bytes: realOpf ? realOpf.bytes : encoder.encode(synthesizePackageDocument(files, title))
      });
      if (!realOpf) log("no package document on the server; synthesized one (spine in natural file order)");

      const blob = storedZip(zipFiles);
      download(blob, `${title}.epub`);
      log(`exported EPUB: ${title}.epub (${zipFiles.length} files, ${blob.size} bytes)`);
      return blob;
    } catch (error) {
      log("export failed:", error);
      return null;
    } finally {
      exporting = false;
    }
  };

  // ---- optional page walker (nice for pre-caching, no longer required) ---------

  const NEXT_ICON_NAMES = [
    "chevron_right", "chevron-right", "arrow_forward", "arrow_forward_ios",
    "navigate_next", "east", "keyboard_arrow_right"
  ];

  function nextElement(doc) {
    try {
      for (const element of doc.querySelectorAll("ktx-icon, mat-icon, [icon]")) {
        const name = quietly(() => element.getAttribute("icon")) || "";
        const text = quietly(() => (element.textContent || "").trim()) || "";
        if (!NEXT_ICON_NAMES.includes(name) && !NEXT_ICON_NAMES.includes(text)) continue;
        const rect = quietly(() => element.getBoundingClientRect());
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        return quietly(() => element.closest("button, [role='button'], a")) || element;
      }
      for (const element of doc.querySelectorAll("button[aria-label], button[title]")) {
        const label = [
          quietly(() => element.getAttribute("aria-label")),
          quietly(() => element.getAttribute("title"))
        ].filter(Boolean).join(" ");
        // Strictly page-turning labels; "forward" is a media/TTS control.
        if (!/^(next page|next|page next)\b/i.test(label)) continue;
        const rect = quietly(() => element.getBoundingClientRect());
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
        return element;
      }
    } catch (_) {}
    return null;
  }

  function advanceReader() {
    for (const doc of [document, ...quietly(() => Array.from(document.querySelectorAll("iframe, frame"))
      .map((f) => f.contentDocument).filter(Boolean)) || []]) {
      const next = nextElement(doc);
      if (next) {
        next.click();
        return true;
      }
    }
    return false;
  }

  window.__ktxStartWalk = async function ktxStartWalk() {
    const maxSteps = 6000;
    const stepDelay = 800;
    log("walker started (pre-caching pages; export works without it)");
    for (let step = 0; step < maxSteps && window.__ktxWalk; step += 1) {
      advanceReader();
      await new Promise((resolve) => setTimeout(resolve, stepDelay));
    }
    log("walker finished");
  };

  log("ready (v4, export-time harvest); window.__ktxExport() / __ktxStatus() / __ktxStartWalk()");
  log("usage: paste, reload, read a page or two, then call __ktxExport() — it fetches the rest of the book itself");
  if (window.__ktxWalk) {
    setTimeout(() => window.__ktxStartWalk(), 1500);
  }
})();
