// OWNER: Carter
// Build the interview step. Do not change the Props type.
import { Button } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AppState, ChatMessage } from "../../shared/schemas";
import { finishInterview, sendInterviewMessage } from "../lib/api";

type Props = {
  interview: AppState["interview"]; // saved messages + whether it's finished
  onChange: () => void; // call after finishing to reload page state
};

const MIN_ANSWERS_TO_FINISH = 3; // user replies before "Finish interview" unlocks
const MAX_MESSAGES = 60; // server rejects longer conversations (InterviewBody)
const MAX_MESSAGE_CHARS = 4000; // server rejects longer messages (ChatMessage)

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Chat with the interviewer. The server saves the conversation after every turn, so
 * local state here is only the in-progress view: this component unmounts whenever
 * the step collapses and re-seeds from `interview.messages` when it reopens.
 */
export function Interview({ interview, onChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(interview.messages);
  const [reply, setReply] = useState<string | null>(null); // streaming reply; null when idle
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const opened = useRef(false);
  const replied = useRef(false); // refocus the composer only after a reply, not on mount

  const streaming = reply !== null;
  const busy = streaming || finishing;
  // The last send failed before the interviewer answered: offer a retry instead of new input.
  const needsReply = messages.length === 0 || messages[messages.length - 1].role === "user";
  const full = messages.length >= MAX_MESSAGES - 1;
  const answers = messages.filter((m) => m.role === "user").length;

  const send = useCallback(async (conversation: ChatMessage[]) => {
    setMessages(conversation);
    setReply("");
    setError(null);
    let text = "";
    try {
      await sendInterviewMessage(conversation, (token) => {
        text += token;
        setReply(text);
      });
      setMessages([...conversation, { role: "assistant", content: text }]);
      replied.current = true;
    } catch (err) {
      setError(errorMessage(err, "The interviewer couldn't reply."));
    } finally {
      setReply(null);
    }
  }, []);

  // Open the conversation once if nothing has been said yet.
  useEffect(() => {
    if (opened.current || interview.messages.length > 0) return;
    opened.current = true;
    void send([]);
  }, [interview.messages.length, send]);

  // Keep the newest message in view as it streams in.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, reply]);

  // The textarea loses focus while disabled; hand it back once the reply lands.
  useEffect(() => {
    if (!streaming && replied.current) inputRef.current?.focus();
  }, [streaming]);

  const submit = () => {
    const content = draft.trim();
    if (!content || busy || needsReply || full) return;
    setDraft("");
    void send([...messages, { role: "user", content }]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await finishInterview(messages);
      onChange();
    } catch (err) {
      setError(errorMessage(err, "Couldn't finish the interview."));
      setFinishing(false);
    }
  };

  return (
    <div className="stack">
      <ScrollArea.Root className="chat">
        <ScrollArea.Viewport ref={viewportRef} className="chat__viewport">
          <ScrollArea.Content>
            <ol className="chat__messages" role="log" aria-live="polite" aria-busy={streaming}>
              {messages.map((m, i) => (
                <li key={i} className={`bubble bubble--${m.role}`}>
                  {m.content}
                </li>
              ))}
              {streaming && (
                <li className="bubble bubble--assistant">
                  {reply || (
                    <span className="typing" aria-label="Interviewer is typing">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </li>
              )}
            </ol>
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="chat__scrollbar">
          <ScrollArea.Thumb className="chat__thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {error && (
        <div className="chat__error">
          <p className="error">{error}</p>
          {needsReply && (
            <Button className="button button--secondary" disabled={busy} onClick={() => void send(messages)}>
              Try again
            </Button>
          )}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field.Root className="composer__field" disabled={busy || needsReply || full}>
          <Field.Label className="visually-hidden">Your answer</Field.Label>
          <Field.Control
            render={<textarea ref={inputRef} rows={2} />}
            className="composer__input"
            placeholder={full ? "That's plenty to go on. Finish the interview below." : "Type your answer…"}
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            onValueChange={setDraft}
            onKeyDown={onKeyDown}
          />
        </Field.Root>
        <Button type="submit" className="button" disabled={busy || needsReply || full || !draft.trim()}>
          Send
        </Button>
      </form>

      <div className="chat__footer">
        <p className="muted">
          {answers < MIN_ANSWERS_TO_FINISH
            ? "Answer a few questions, then finish whenever you're ready."
            : "Finish once you've covered what matters. You can come back and edit later."}
        </p>
        <Button
          className={`button button--secondary${finishing ? " button--busy" : ""}`}
          disabled={busy || answers < MIN_ANSWERS_TO_FINISH}
          onClick={() => void finish()}
        >
          {finishing && <span className="spinner" />}
          Finish interview
        </Button>
      </div>
    </div>
  );
}
