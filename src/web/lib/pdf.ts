// PDF → plain text, in the browser, so the Worker never parses files.
// pdf.js is large, so it's loaded on first use instead of with the page.
import { MAX_DOCUMENT_CHARS } from "../../shared/schemas";

type TextItems = Awaited<
  ReturnType<import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy["getTextContent"]>
>["items"];

/**
 * Returns the PDF's text, or "" for scanned/image-only PDFs. Stops reading pages once the
 * text passes MAX_DOCUMENT_CHARS (the most the server keeps), so a huge PDF can't freeze the tab.
 */
export async function extractPdfText(file: File): Promise<string> {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;

  const task = getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const pages: string[] = [];
  let chars = 0;
  for (let n = 1; n <= pdf.numPages && chars <= MAX_DOCUMENT_CHARS; n++) {
    // Not getTextContent(): it uses `for await` on a ReadableStream, which Safari lacks.
    const reader = (await pdf.getPage(n))
      .streamTextContent()
      .getReader() as ReadableStreamDefaultReader<{ items: TextItems }>;
    const items: TextItems = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) items.push(...r.value.items);
    const page = items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("");
    pages.push(page);
    chars += page.length;
  }
  await task.destroy();
  return pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
}
