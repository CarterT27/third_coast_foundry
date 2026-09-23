// PDF → plain text, in the browser, so the Worker never parses files.
// pdf.js is large, so it's loaded on first use instead of with the page.

/** Returns the PDF's text, or "" for scanned/image-only PDFs. */
export async function extractPdfText(file: File): Promise<string> {
  const [{ getDocument, GlobalWorkerOptions }, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerUrl;

  const task = getDocument({ data: await file.arrayBuffer() });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join(""),
    );
  }
  await task.destroy();
  return pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
}
