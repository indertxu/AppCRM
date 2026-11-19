/**
 * Home · AI assistant — a preview card (not switched on yet).
 *
 * Every morning it greets you with your day: what's booked, your tickets and your tasks (real figures,
 * each one opens its page). You can already type a question or pick a suggestion: it answers that it's
 * a preview. "Expand" opens its dashboard: the same conversation, next to the reports it will put
 * together on its own (weekly briefing, billing forecast, pipeline health, client pulse).
 * When the assistant is built, AiChat's ask() is the one place that calls it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CalSummary } from "./HomeCalendar";
import "./AiAssistant.css";

export interface AiCounts { open: number; late: number; today: number }
export interface AiProps { name: string | null; cal: CalSummary | null; tickets: AiCounts | null; tasks: AiCounts | null; go: (path: string) => void }

export const Spark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.5 3.5l1.7 4.8 4.8 1.7-4.8 1.7-1.7 4.8-1.7-4.8L4 10l4.8-1.7z" />
    <path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </svg>
);
const I = ({ d }: { d: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICO = {
  cal: <><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  tix: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  task: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12.2l2.4 2.4 4.6-4.9" /></>,
  week: <><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8 14h3M8 17h6" /></>,
  bill: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  pipe: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  quiet: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M17 8.5h4M17 12.5h4" /></>,
};

const SUGGEST = ["What should I do first?", "Summarise my week", "Which bills are late?", "Draft a follow-up"];
const REPORTS: { k: keyof typeof ICO; title: string; text: string; when: string }[] = [
  { k: "week", title: "Monday briefing", text: "Your week ahead: meetings, deadlines and what's running late.", when: "Mondays, 8:00" },
  { k: "bill", title: "Billing forecast", text: "What you'll bill this month, and what's at risk.", when: "Every week" },
  { k: "pipe", title: "Pipeline health", text: "Deals that slipped, stalled or need a nudge.", when: "Every week" },
  { k: "quiet", title: "Client pulse", text: "Clients going quiet and bills waiting to be paid.", when: "Every month" },
];

const greet = () => {
  const h = new Date().getHours();
  return h < 6 ? "Working late" : h < 12 ? "Good morning" : h < 19 ? "Good afternoon" : "Good evening";
};
const hrs = (m: number) => `${+(m / 60).toFixed(1)}h`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Row { k: "cal" | "tix" | "task"; title: string; sub: string; flag?: string; tone?: "late" | "soon" | "ok"; path: string }
function briefRows({ cal, tickets, tasks }: AiProps): Row[] {
  const out: Row[] = [];
  out.push(cal ? {
    k: "cal", path: "/calendar",
    title: `${hrs(cal.todayMin)} booked of ${hrs(cal.todayCap)}`,
    sub: cal.next ? `Next: ${cal.next.time} · ${cal.next.title}${cal.next.today ? "" : " (later this week)"}` : "Nothing else booked today",
    flag: cal.todayCap > 0 ? `${Math.round((cal.todayMin / cal.todayCap) * 100)}%` : undefined,
    tone: cal.todayCap > 0 && cal.todayMin > cal.todayCap ? "late" : "ok",
  } : { k: "cal", path: "/calendar", title: "Your calendar", sub: "Reading your day…" });
  const tally = (k: "tix" | "task", x: AiCounts | null, one: string, many: string, path: string): Row => (x ? {
    k, path, title: plural(x.open, one, many),
    sub: x.open === 0 ? "Nothing waiting on you" : x.late || x.today ? [x.late && `${x.late} late`, x.today && `${x.today} due today`].filter(Boolean).join(" · ") : "All on time",
    flag: x.late ? `${x.late} late` : x.today ? `${x.today} today` : undefined, tone: x.late ? "late" : x.today ? "soon" : "ok",
  } : { k, path, title: many[0].toUpperCase() + many.slice(1), sub: "Counting…" });
  out.push(tally("tix", tickets, "open ticket", "open tickets", "/tickets"));
  out.push(tally("task", tasks, "open task", "open tasks", "/tickets?kind=task"));
  return out;
}

/** The conversation: the morning brief, then what you asked. */
function AiChat(p: AiProps & { big?: boolean }) {
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<{ me: boolean; text: string }[]>([]);
  const [typing, setTyping] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  useEffect(() => { const s = scroll.current; if (s && thread.length) s.scrollTo({ top: s.scrollHeight, behavior: "smooth" }); }, [thread.length, typing]);
  const ask = (text: string) => {
    const t = text.trim();
    if (!t || typing) return;
    setThread((x) => [...x, { me: true, text: t }]);
    setQ("");
    setTyping(true);
    timer.current = window.setTimeout(() => {
      setTyping(false);
      setThread((x) => [...x, { me: false, text: `I'm not switched on yet: this is a preview. Soon I'll answer “${t}” from your calendar, tickets, deals and bills.` }]);
    }, 900);
  };
  const rows = briefRows(p);
  return (
    <div className={`ai-chat ${p.big ? "is-big" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="ai-scroll" ref={scroll}>
        <div className="ai-msg">
          <span className="ai-av"><Spark /></span>
          <div className="ai-bubble">
            <p className="ai-hi"><b>{greet()}{p.name ? `, ${p.name}` : ""}.</b> Here's your day so far:</p>
            <div className="ai-plan">
              {rows.map((r) => (
                <button type="button" key={r.k} className={`ai-row is-${r.k}`} onClick={() => p.go(r.path)} title="Open it">
                  <i className="ai-row-ico"><I d={ICO[r.k]} /></i>
                  <span className="ai-row-t"><b>{r.title}</b><small>{r.sub}</small></span>
                  {r.flag && <em className={`ai-flag is-${r.tone ?? "ok"}`}>{r.flag}</em>}
                </button>
              ))}
            </div>
            <p className="ai-note">Soon I'll put it in order for you: what to do first, what can wait and what's slipping.</p>
          </div>
        </div>
        {thread.map((m, i) => (
          <div key={i} className={`ai-msg ${m.me ? "is-me" : ""}`}>
            {!m.me && <span className="ai-av"><Spark /></span>}
            <div className="ai-bubble">{m.text}</div>
          </div>
        ))}
        {typing && (
          <div className="ai-msg">
            <span className="ai-av"><Spark /></span>
            <div className="ai-bubble ai-typing" aria-label="Thinking"><i /><i /><i /></div>
          </div>
        )}
      </div>
      {thread.length === 0 && (
        <div className="ai-sugs">
          {SUGGEST.map((s) => <button type="button" key={s} onClick={() => ask(s)}>{s}</button>)}
        </div>
      )}
      <form className="ai-ask" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <Spark />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask me anything about your work…" aria-label="Ask the assistant" />
        <button type="submit" disabled={!q.trim() || typing} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>
        </button>
      </form>
    </div>
  );
}

/** The expanded view: the conversation and the reports it will put together. */
function AiDashboard({ onClose, ...p }: AiProps & { onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="ai-dash-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onClick={(e) => e.stopPropagation()}>
      <div className="ai-dash" role="dialog" aria-label="AI assistant">
        <header className="ai-dash-h">
          <span className="ai-av is-lg"><Spark /></span>
          <span className="ai-dash-t"><b>AI assistant</b><small>A preview of what's coming: it isn't switched on yet.</small></span>
          <span className="ai-tag">Preview</span>
          <button type="button" className="ai-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>
        <div className="ai-dash-body">
          <section className="ai-dash-chat" aria-label="Your day">
            <h3>Your day</h3>
            <AiChat {...p} big />
          </section>
          <section className="ai-dash-reps" aria-label="Automatic reports">
            <h3>Automatic reports</h3>
            <p className="ai-dash-sub">Reports it will put together for you, on a schedule or whenever you ask.</p>
            <div className="ai-reps">
              {REPORTS.map((r) => (
                <article key={r.title} className="ai-rep">
                  <i className="ai-rep-ico"><I d={ICO[r.k]} /></i>
                  <b>{r.title}</b>
                  <small>{r.text}</small>
                  <span className="ai-rep-foot"><span>{r.when}</span><em>Coming soon</em></span>
                </article>
              ))}
            </div>
            <div className="ai-build" aria-disabled="true">
              <Spark />
              <span>Describe a report and I'll build it…</span>
              <em>Coming soon</em>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function AiAssistantCard(p: AiProps) {
  const [open, setOpen] = useState(false);
  return (
    <section className="cz-card ai-card" aria-label="AI assistant">
      <header className="cz-head">
        <div className="cz-titles">
          <span className="cz-eyebrow">AI assistant</span>
          <span className="ai-tag">Preview</span>
        </div>
        <button type="button" className="cz-link ai-expand" onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="Open the assistant's dashboard">
          Expand<i aria-hidden="true">↗</i>
        </button>
      </header>
      <AiChat {...p} />
      {open && <AiDashboard {...p} onClose={() => setOpen(false)} />}
    </section>
  );
}
