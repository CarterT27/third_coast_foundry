// One upload slot (resume / transcript / LinkedIn): pick a PDF, extract its text,
// send it to the API. Owns its own spinner and error so slots don't block each other.
import { useId, useState, type ChangeEvent } from "react";
import { MAX_DOCUMENT_CHARS, type DocumentSummary, type UploadKind } from "../../shared/schemas";
import { uploadDocument } from "../lib/api";
import { extractPdfText } from "../lib/pdf";

type Props = {
  kind: UploadKind;
  label: string;
  hint?: string;
  document?: DocumentSummary;
  onUploaded: () => void;
};

// pdf.js errors carry a `name` like "PasswordException"; anything else is shown
// with its message so the cause can be reported (e.g. an unsupported browser).
function readErrorMessage(err: unknown): string {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  if (name === "PasswordException") return "This PDF is password-protected. Remove the password and upload it again.";
  if (name === "InvalidPDFException") return "This file doesn't look like a valid PDF. Try re-exporting it and uploading again.";
  const detail = err instanceof Error ? err.message : String(err);
  return `We couldn't read this PDF (${detail}). Try re-exporting it, or use a different browser such as Chrome.`;
}

export function UploadSlot({ kind, label, hint, document, onUploaded }: Props) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;

    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }

    setBusy(true);
    try {
      let text: string;
      try {
        text = await extractPdfText(file);
      } catch (err) {
        console.error("Could not read PDF", err);
        setError(readErrorMessage(err));
        return;
      }
      if (!text) {
        setError("This looks like a scanned PDF with no selectable text. Please upload a text-based PDF.");
        return;
      }
      await uploadDocument({ kind, filename: file.name, sizeBytes: file.size, text: text.slice(0, MAX_DOCUMENT_CHARS) });
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`slot${document ? " slot--done" : ""}`}>
      <div className="slot__info">
        <span className="slot__label">{label}</span>
        {document ? (
          <span className="slot__file">✓ {document.filename}</span>
        ) : (
          hint && <span className="slot__hint">{hint}</span>
        )}
        {error && <span className="error slot__error">{error}</span>}
      </div>
      <input id={inputId} className="slot__input" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={handleFile} />
      <label htmlFor={inputId} className={`button button--secondary${busy ? " button--busy" : ""}`} aria-disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Uploading…
          </>
        ) : document ? (
          "Replace"
        ) : (
          "Choose PDF"
        )}
      </label>
    </div>
  );
}
