/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /f/<token> — a Marketing form, open to anyone (no sign-in).
 *
 * The link can carry: e=<e-mail> (from an e-mail campaign: the answers land on
 * that contact), q=<question id>&a=<answer> (a one-click answer from the e-mail:
 * already picked) and any parameter a hidden question reads (utm_source…).
 * Sending calls mk_form_submit, which saves the response and fills in the CRM.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../../api/supabase";
import { FormView, checkAnswers, type Answer, type FormLike, type FormField } from "./formsKit";
import "./FormView.css";

type Load = { k: "loading" } | { k: "missing" } | { k: "closed"; name: string; accent?: string } | { k: "form"; form: FormLike & { id: string } };

export default function FormPublicPage() {
  const { token = "" } = useParams();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [load, setLoad] = useState<Load>({ k: "loading" });
  const [vals, setVals] = useState<Record<string, Answer>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Form";
    let alive = true;
    supabase.rpc("mk_form_public", { p_token: token }).then(({ data, error }: any) => {
      if (!alive) return;
      if (error || !data) { setLoad({ k: "missing" }); return; }
      if (data.closed) { setLoad({ k: "closed", name: data.settings?.title || data.name, accent: data.settings?.accent }); return; }
      const form = { id: data.id, name: data.name, fields: (data.fields ?? []) as FormField[], settings: data.settings ?? {}, company: data.company ?? null };
      document.title = form.settings.title || form.name;
      // what the link already says: hidden values, and the answer picked in the e-mail
      const pre: Record<string, Answer> = {};
      form.fields.forEach((f) => {
        if (f.type === "hidden" && f.param) { const v = params.get(f.param); if (v) pre[f.id] = v; }
      });
      const q = params.get("q"), a = params.get("a");
      const qf = q ? form.fields.find((f) => f.id === q) : undefined;
      if (qf && a != null) pre[qf.id] = qf.type === "rating" || qf.type === "nps" || qf.type === "scale" ? Number(a) : a;
      const e = params.get("e");
      const ef = form.fields.find((f) => f.type === "email" || f.map === "contact.email");
      if (e && ef && !pre[ef.id]) pre[ef.id] = e.replace(/ /g, "+");
      setVals(pre);
      setLoad({ k: "form", form });
    });
    return () => { alive = false; };
  }, [token, params]);

  const send = async () => {
    if (load.k !== "form") return;
    const err = checkAnswers(load.form.fields, vals);
    setErrors(err);
    if (Object.keys(err).length) {
      const first = load.form.fields.find((f) => err[f.id]);
      if (first) document.querySelector(`[data-fid="${first.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setBusy(true); setFail(null);
    const meta: Record<string, string> = { source: params.get("e") ? "email" : "link" };
    const e = params.get("e"); if (e) meta.e = e.replace(/ /g, "+");
    ["utm_source", "utm_medium", "utm_campaign"].forEach((k) => { const v = params.get(k); if (v) meta[k] = v; });
    if (document.referrer) meta.referrer = document.referrer.slice(0, 300);
    const { data, error }: any = await supabase.rpc("mk_form_submit", { p_token: token, p_answers: vals, p_meta: meta });
    setBusy(false);
    if (error || !data?.ok) { setFail(data?.error || "We couldn't send it — please try again in a moment."); return; }
    if (data.redirect && /^https?:\/\//i.test(data.redirect)) { window.location.href = data.redirect; return; }
    setDone(data.thanks || "Thank you — we got your answers.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const accent = load.k === "form" ? load.form.settings.accent : load.k === "closed" ? load.accent : undefined;
  return (
    <div className="fvp" style={{ ["--fv-accent" as string]: accent || "#0f8a5f" } as CSSProperties}>
      {load.k === "loading" && <div className="fvp-msg"><span className="fvp-spin" /></div>}
      {load.k === "missing" && <Msg title="This form isn't available" text="The link may be wrong, or the form isn't open yet." />}
      {load.k === "closed" && <Msg title={load.name} text="This form is closed and no longer takes answers. Thank you for your interest." />}
      {load.k === "form" && (done ? (
        <Msg ok title={done} text={load.form.company ? `— ${load.form.company}` : ""} />
      ) : (
        <>
          <FormView form={load.form} values={vals} errors={errors} busy={busy} onSubmit={() => void send()}
            onChange={(id, v) => { setVals((x) => ({ ...x, [id]: v })); if (errors[id]) setErrors((x) => { const y = { ...x }; delete y[id]; return y; }); }} />
          {fail && <div className="fvp-fail" role="alert">{fail}</div>}
        </>
      ))}
    </div>
  );
}

function Msg({ title, text, ok = false }: { title: string; text: string; ok?: boolean }) {
  return (
    <div className="fvp-msg">
      <div className="fvp-card">
        <span className={`fvp-ico ${ok ? "is-ok" : ""}`}>
          {ok ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="3" /><path d="M8 8.5h8M8 12.5h8M8 16.5h5" /></svg>}
        </span>
        <h1 translate="no">{title}</h1>
        {text && <p translate="no">{text}</p>}
      </div>
    </div>
  );
}
