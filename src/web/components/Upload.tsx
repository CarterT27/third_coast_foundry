// OWNER: Ania
// Build the upload step. Do not change the Props type.
import type { DocumentSummary, UploadKind } from "../../shared/schemas";
import { UploadSlot } from "./UploadSlot";

type Props = {
  documents: DocumentSummary[]; // already uploaded (one per kind)
  onChange: () => void; // call after a successful upload to reload page state
  onContinue: () => void; // call when the user is done uploading
};

const SLOTS: { kind: UploadKind; label: string; hint?: string }[] = [
  { kind: "resume", label: "Resume" },
  { kind: "transcript", label: "Transcript" },
  { kind: "linkedin", label: "LinkedIn profile", hint: "On your LinkedIn profile, click More → Save to PDF." },
];

export function Upload({ documents, onChange, onContinue }: Props) {
  return (
    <div className="stack">
      <p className="muted">Upload any of these as PDFs. The more we know, the better your matches.</p>
      <div className="slots">
        {SLOTS.map((slot) => (
          <UploadSlot
            key={slot.kind}
            {...slot}
            document={documents.find((d) => d.kind === slot.kind)}
            onUploaded={onChange}
          />
        ))}
      </div>
      <button className="button" disabled={documents.length === 0} onClick={onContinue}>
        Continue to interview
      </button>
    </div>
  );
}
