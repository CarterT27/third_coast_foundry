// PDF → plain text, in the browser, so the Worker never parses files.
// pdf.js is large, so it's loaded on first use instead of with the page.

type TextItems = Awaited<
  ReturnType<import("pdfjs-dist/legacy/build/pdf.mjs").PDFPageProxy["getTextContent"]>
>["items"];

/** Returns the PDF's text, or "" for scanned/image-only PDFs. */
export async function extractPdfText(file: File): Promise<string> {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;

  const task = getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    // Not getTextContent(): it uses `for await` on a ReadableStream, which Safari lacks.
    const reader = (await pdf.getPage(n))
      .streamTextContent()
      .getReader() as ReadableStreamDefaultReader<{ items: TextItems }>;
    const items: TextItems = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) items.push(...r.value.items);
    pages.push(
      items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join(""),
    );
  }
  await task.destroy();
  return pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
}
