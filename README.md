# Kortext Extractor

Browser console scripts for saving a personal backup of a book you have access to in the Kortext web reader, as an EPUB or a PDF.

## Files

- `kortext-extract.js` - captures the book and exports it as an `.epub`
- `kortext-extract-pdf.js` - add-on that exports a PDF instead (needs `kortext-extract.js` loaded first)

## EPUB

1. Open the book in the Kortext reader.
2. Open DevTools (F12) and go to the Console tab.
3. Paste the contents of `kortext-extract.js` and press Enter.
4. Turn a page or two. This lets the script pick up the reader's login headers; without them chapters fail to download (the export warns you if it hasn't seen them yet).
5. Run:

   ```js
   await __ktxExport()
   ```

   It fetches the whole book (about 15s for a 2000-file textbook) and downloads `<title>.epub` to your Downloads folder.

## PDF

1. Do steps 1-4 above.
2. Paste the contents of `kortext-extract-pdf.js` and press Enter.
3. Run:

   ```js
   await __ktxExportPdf()
   ```

4. When the print dialog opens, set the destination to "Save as PDF".

## Other commands

| Command | What it does |
| --- | --- |
| `__ktxStatus()` | shows what has been captured so far |
| `__ktxWalk = false` | stops the automatic page turning |
| `__ktxStartWalk()` | starts the page turning again |

## Notes

- About 1.5s after pasting, the script starts turning pages by itself. The export doesn't need this, so turn it off with `__ktxWalk = false` if it gets in the way.
- Don't reload the page after pasting. A reload clears the script and you'll have to paste it again.
- If the book is a single PDF on Kortext's side, `__ktxExport()` downloads that PDF directly.
- If the print dialog doesn't appear, the assembled book is still available: open `__ktxPdfDocUrl` in a new tab and print from there.
- Only use this on books you have legitimate access to, for your own use.
