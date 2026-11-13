import { useId, useLayoutEffect, useRef, useState } from "react";
import { extractJobDetails, GEMINI_POSTING_MAX_LENGTH } from "../ai/gemini";

type ExtractedFields = Awaited<ReturnType<typeof extractJobDetails>>;

const MAX_RESULT_LENGTH = 4_096;
const MAX_FIELD_LENGTH = 256;

function readPastedFields(text: string): ExtractedFields {
  if (text.length > MAX_RESULT_LENGTH) throw new Error();
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();

  const readField = (name: "company" | "jobTitle") => {
    if (!Object.hasOwn(value, name)) return null;
    const field = (value as Record<string, unknown>)[name];
    if (field === null) return null;
    if (typeof field !== "string") throw new Error();
    return field;
  };

  return { company: readField("company"), jobTitle: readField("jobTitle") };
}

function ExtractPanel({ mode, id, onApply }: {
  mode: "gemini" | "paste";
  id: string;
  onApply: (fields: ExtractedFields) => void;
}) {
  const keyInput = useRef<HTMLInputElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExtractedFields | null>(null);

  useLayoutEffect(() => {
    const key = keyInput.current;
    return () => {
      if (key) key.value = "";
      request.current?.abort();
    };
  }, []);

  function resetReview() {
    setError("");
    setResult(null);
  }

  function review(fields: ExtractedFields) {
    if (Object.values(fields).some((field) => field && (field.length > MAX_FIELD_LENGTH || /[\r\n]/.test(field)))) {
      setError("Company and job title must each be a single line of up to 256 characters.");
      return;
    }
    const company = fields.company?.trim() || null;
    const jobTitle = fields.jobTitle?.trim() || null;
    if (!company && !jobTitle) {
      setError("No company or job title found. You can enter them in the application form.");
      return;
    }
    setResult({ company, jobTitle });
  }

  async function sendToGemini() {
    if (request.current || !keyInput.current) return;
    const apiKey = keyInput.current.value.trim();
    keyInput.current.value = "";
    const postingText = sourceInput.current?.value.trim() ?? "";
    resetReview();
    if (!apiKey || !postingText) {
      setError("Enter a Gemini API key and paste the public job posting.");
      return;
    }
    if (postingText.length > GEMINI_POSTING_MAX_LENGTH) {
      setError("The job posting must be 8,000 characters or fewer.");
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const fields = await extractJobDetails(apiKey, postingText, controller.signal);
      if (!controller.signal.aborted) review(fields);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error && failure.message === "Remove the API key from the job posting text."
          ? "Remove the API key from the job posting text before sending."
          : "Gemini extraction failed. Check your API key and quota, then try again.");
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  function reviewPastedResult() {
    resetReview();
    try {
      review(readPastedFields(sourceInput.current?.value ?? ""));
    } catch {
      setError("Paste valid JSON with company and jobTitle as single-line strings of up to 256 characters or null.");
    }
  }

  const usingGemini = mode === "gemini";
  return (
    <div id={id} className="bl-ai-fields">
      {usingGemini ? (
        <>
          <p className="bl-muted">Sending shares the pasted posting text and API key with Google. Google may use content from its free tier to improve its services. Your Google account may incur API charges. Keys entered in a browser can be exposed. Keep personal or confidential information out of the posting text.</p>
          <label>Gemini API key
            <input ref={keyInput} type="password" autoComplete="off" spellCheck={false} maxLength={256} disabled={busy}
              aria-describedby={`${id}-key-note`} />
          </label>
          <p id={`${id}-key-note`} className="bl-muted">The app clears your key without saving it. Enter it again for each request.</p>
          <label>Job posting text
            <textarea ref={sourceInput} rows={4} maxLength={GEMINI_POSTING_MAX_LENGTH} disabled={busy} onChange={resetReview} />
          </label>
          <div>
            <button type="button" className="bl-button" onClick={sendToGemini} disabled={busy}>
              Send to Gemini
            </button>
          </div>
          {busy && <p className="bl-muted" role="status">Extracting job details…</p>}
        </>
      ) : (
        <>
          <p className="bl-muted">Ask your AI to extract the company and job title from the public posting and return only JSON in this format. Use null for unknown fields.</p>
          <code>{'{"company": "Company name", "jobTitle": "Job title"}'}</code>
          <label>AI result JSON
            <textarea ref={sourceInput} rows={3} maxLength={MAX_RESULT_LENGTH} onChange={resetReview} />
          </label>
          <div>
            <button type="button" className="bl-button" onClick={reviewPastedResult}>Review pasted result</button>
          </div>
        </>
      )}
      {error && <p className="bl-error" role="alert">{error}</p>}
      {result && (
        <div className="bl-ai-result">
          <p>Review these fields before applying. Applying replaces the corresponding fields in the application form.</p>
          <dl>
            {result.company && <><dt>Company</dt><dd>{result.company}</dd></>}
            {result.jobTitle && <><dt>Job title</dt><dd>{result.jobTitle}</dd></>}
          </dl>
          <button type="button" className="bl-button" onClick={() => onApply(result)}>Apply extracted fields</button>
        </div>
      )}
    </div>
  );
}

export default function GeminiExtract({ onApply }: { onApply: (fields: ExtractedFields) => void }) {
  const id = useId();
  const [mode, setMode] = useState<"gemini" | "paste" | null>(null);

  return (
    <section className="bl-ai" aria-label="Optional job details extraction">
      <div className="bl-actions">
        <button type="button" className="bl-button" aria-expanded={mode === "gemini"} aria-controls={mode === "gemini" ? id : undefined}
          onClick={() => setMode(mode === "gemini" ? null : "gemini")}>Extract with Gemini (optional)</button>
        <button type="button" className="bl-button" aria-expanded={mode === "paste"} aria-controls={mode === "paste" ? id : undefined}
          onClick={() => setMode(mode === "paste" ? null : "paste")}>Use another AI (optional)</button>
      </div>
      {mode && <ExtractPanel key={mode} id={id} mode={mode} onApply={(fields) => {
        onApply(fields);
        setMode(null);
      }} />}
    </section>
  );
}
