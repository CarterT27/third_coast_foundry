// OWNER: high-experience teammate
// Build the interview step. Do not change the Props type.
import type { AppState } from "../../shared/schemas";

type Props = {
  interview: AppState["interview"]; // saved messages + whether it's finished
  onChange: () => void; // call after finishing to reload page state
};

/**
 * TODO:
 * - Chat UI seeded from `interview.messages`. If there are none, immediately call
 *   `sendInterviewMessage([], onToken)` so the interviewer opens the conversation.
 * - On send: append the user message, call `sendInterviewMessage(messages, onToken)`
 *   from lib/api and render the reply as tokens stream in. Disable input meanwhile.
 * - "Finish interview" button (enabled after a few exchanges) →
 *   `finishInterview(messages)` then `onChange()`.
 * - This component unmounts when the step collapses: anything that must survive
 *   goes through the API (the server saves messages after each turn), not useState.
 * - When re-opened via Edit after finishing, the user can keep chatting and finish again.
 */
export function Interview(_props: Props) {
  return <p className="muted">TODO: chat interview.</p>;
}
