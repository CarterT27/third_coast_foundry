// OWNER: low-experience teammate
// Build the upload step. Do not change the Props type.
import type { DocumentSummary } from "../../shared/schemas";

type Props = {
  documents: DocumentSummary[]; // already uploaded (one per kind)
  onChange: () => void; // call after a successful upload to reload page state
  onContinue: () => void; // call when the user is done uploading
};

/**
 * TODO:
 * - One slot per kind: Resume, Transcript, LinkedIn profile (with a hint: on LinkedIn,
 *   "More → Save to PDF"). Show ✓ + filename when that kind is in `documents`.
 * - On file pick: `extractPdfText(file)` from lib/pdf, then
 *   `uploadDocument({ kind, filename, sizeBytes: file.size, text })` from lib/api,
 *   then `onChange()`.
 * - Show a spinner per slot while uploading, and a friendly error if the PDF has no
 *   text ("This looks like a scanned PDF…") or the request fails.
 * - Keep the Continue button: enabled once at least one document is uploaded.
 */
export function Upload({ documents, onContinue }: Props) {
  return (
    <div className="stack">
      <p className="muted">TODO: upload slots for resume, transcript and LinkedIn PDF.</p>
      <button className="button" disabled={documents.length === 0} onClick={onContinue}>
        Continue to interview
      </button>
    </div>
  );
}
