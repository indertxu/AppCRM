import { useEffect, useState } from "react";
import { Building2, LayoutGrid, Feather, Check, Minus, Plus, UserPlus, Wand2, Search } from "lucide-react";
import { createTenant, createUser, loadRoles, setUserRole, PLAN_LABEL, type TenantPlan, type CompanyRole } from "../../api/superadminApi";
import { passwordProblem, PASSWORD_HINT, PASSWORD_RULES } from "../../login/LoginPage";
import { Modal, colorOf, initials } from "./SuperAdminHome";
import Select from "../../framework/Select";

interface Props {
  /** how many companies there are (the new one takes the next colour) */
  next: number;
  onClose: () => void;
  /** the new company's id (to open its page), or null if it isn't known */
  onCreated: (id: string | null) => void;
}

const SEAT_PICKS = [5, 10, 25, 50];

/** Enterprise (the full app) or Base (the simple one): the same sign-in, a different app after it. */
const PLANS: { key: TenantPlan; icon: typeof LayoutGrid; line: string; pages: string[] }[] = [
  { key: "enterprise", icon: LayoutGrid, line: "The full app, every module", pages: ["Deals", "Projects", "Management", "Success", "Marketing", "Reports"] },
  { key: "base", icon: Feather, line: "The essentials, kept simple", pages: ["Home", "Tasks", "Calendar", "People", "Clients"] },
];

export default function SuperAdminCreate({ next, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [maxUsers, setMaxUsers] = useState(5);
  const [plan, setPlan] = useState<TenantPlan>("enterprise");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const col = colorOf(next);

  const submit = async () => {
    if (!name.trim()) { setErr("Give the company a name."); return; }
    setBusy(true); setErr("");
    const r = await createTenant(name.trim(), maxUsers, plan);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onCreated((r.tenant?.id as string | undefined) ?? null);
  };

  return (
    <Modal icon={<Building2 size={20} strokeWidth={1.9} />} kicker="Platform console" title="New company" width={540}
      sub="Same sign-in for everyone. The plan decides which app they get."
      onClose={onClose}
      foot={<>
        <span className="sa-modal-note">Next: add its users from the company's page.</span>
        <div className="sa-modal-actions">
          <button className="sa-cancel" onClick={onClose}>Cancel</button>
          <button className={`sa-confirm ${plan === "base" ? "is-base" : ""}`} onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create company"}
          </button>
        </div>
      </>}>
      <form className="sa-nc" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {/* the company as it will show in the console */}
        <div className="sa-nc-id">
          <span className={`sa-nc-av ${name.trim() ? "" : "is-empty"}`} style={{ background: `linear-gradient(150deg, color-mix(in srgb, ${col} 65%, #fff), ${col})` }}>
            {name.trim() ? initials(name) : <Building2 size={20} strokeWidth={1.8} />}
          </span>
          <label className="sa-nc-name">
            <span>Company name</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setErr(""); }} placeholder="e.g. Acme Consulting" autoFocus autoComplete="off" spellCheck={false} />
          </label>
        </div>

        <div className="sa-nc-row">
          <span className="sa-nc-k">Seats</span>
          <div className="sa-nc-seats">
            <div className="sa-nc-picks" role="radiogroup" aria-label="Seats">
              {SEAT_PICKS.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={maxUsers === n} className={maxUsers === n ? "is-on" : ""} onClick={() => setMaxUsers(n)}>{n}</button>
              ))}
            </div>
            <div className="sa-nc-step">
              <button type="button" onClick={() => setMaxUsers((n) => Math.max(1, n - 1))} aria-label="One seat less"><Minus size={14} strokeWidth={2.4} /></button>
              <b>{maxUsers}</b>
              <button type="button" onClick={() => setMaxUsers((n) => Math.min(999, n + 1))} aria-label="One seat more"><Plus size={14} strokeWidth={2.4} /></button>
            </div>
          </div>
        </div>

        <div className="sa-nc-row is-top">
          <span className="sa-nc-k">App</span>
          <div className="sa-plan" role="radiogroup" aria-label="App">
            {PLANS.map((p) => {
              const I = p.icon, on = plan === p.key;
              return (
                <button key={p.key} type="button" role="radio" aria-checked={on} className={`sa-plan-opt is-${p.key} ${on ? "is-on" : ""}`} onClick={() => setPlan(p.key)}>
                  <span className="sa-plan-top">
                    <span className="sa-plan-ico"><I size={16} strokeWidth={2} /></span>
                    <span className="sa-plan-radio" aria-hidden="true">{on && <Check size={11} strokeWidth={3.2} />}</span>
                  </span>
                  <b>{PLAN_LABEL[p.key]}</b>
                  <small>{p.line}</small>
                  <span className="sa-plan-pages">{p.pages.map((x) => <i key={x}>{x}</i>)}</span>
                </button>
              );
            })}
          </div>
        </div>
        {err && <p className="sa-error">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ---------- a new login: from the Users page (pick the company) or from a company's page ---------- */

/** readable (no lookalikes), always with letters, a number and a symbol */
export function makePw() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (x: string) => x[Math.floor(Math.random() * x.length)];
  const body = Array.from({ length: 9 }, () => pick(abc)).join("");
  return `${body.slice(0, 5)}${pick(".-_!@")}${body.slice(5)}${pick("23456789")}${pick("abcdefghjkmnpqrstuvwxyz")}`;
}

/** The password rules, ticking as you type. */
export function PwRules({ pw }: { pw: string }) {
  return (
    <span className="sa-pw-rules">
      {PASSWORD_RULES.map((r) => {
        const ok = r.ok(pw);
        return <i key={r.label} className={ok ? "is-ok" : ""}>{ok ? <Check size={10} strokeWidth={3.2} /> : <span />}{r.label}</i>;
      })}
    </span>
  );
}

export interface LoginCompany { id: string; name: string; users: number; max: number; plan: TenantPlan; color: string; active: boolean }

/**
 * Create a login. The superadmin only creates the login (e-mail + password) in a company:
 * role and job title are set by the company itself, in its Settings.
 * With one company (`companies` of one) the picker is skipped.
 */
export function NewLoginModal({ companies, initial, onClose, onCreated }: {
  companies: LoginCompany[]; initial?: string; onClose: () => void; onCreated: (tenantId: string) => void;
}) {
  const fixed = companies.length === 1 ? companies[0] : null;
  const [tid, setTid] = useState<string>(fixed?.id ?? initial ?? "");
  const [find, setFind] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  const [level, setLevel] = useState("");
  const [roles, setRoles] = useState<CompanyRole[] | null>(null);
  // the company's roles, once it's picked
  useEffect(() => {
    setRoles(null); setLevel("");
    if (!tid) return;
    let alive = true;
    loadRoles(tid).then((r) => { if (alive) setRoles(r); }, () => { if (alive) setRoles([]); });
    return () => { alive = false; };
  }, [tid]);
  const [copied, setCopied] = useState(false);
  const co = companies.find((c) => c.id === tid) ?? null;
  const full = (c: LoginCompany) => c.users >= c.max;
  const list = companies.filter((c) => c.name.toLowerCase().includes(find.trim().toLowerCase()));

  const submit = async () => {
    if (!co) { setErr("Pick the company."); return; }
    if (full(co)) { setErr(`${co.name} has no free seat: add one on its page first.`); return; }
    if (!email.trim()) { setErr("Type their e-mail."); return; }
    const weak = passwordProblem(password);
    if (weak) { setErr(weak); return; }
    setBusy(true); setErr("");
    const r = await createUser(co.id, email.trim(), password, "", "");
    if (r?.error) { setBusy(false); setErr(r.error); return; }
    // the role, the way the company's Settings gives it (the login is made with the default one)
    const uid = (r?.user?.id as string | undefined) ?? null;
    if (level && uid) {
      const e = await setUserRole(uid, level);
      if (e) { setBusy(false); setErr(`The login was created, but the role wasn't set: ${e}`); setDone(true); return; }
    }
    setBusy(false);
    setDone(true);
  };
  const finish = () => { if (co) onCreated(co.id); else onClose(); };
  const copy = () => {
    void navigator.clipboard?.writeText(`${email.trim()}\n${password}`).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => undefined);
  };

  if (done && co) return (
    <Modal icon={<Check size={20} strokeWidth={2.4} />} kicker="Login created" title={email.trim()} width={460}
      sub={`In ${co.name}. Send them these details through a channel you trust: the password can't be read back later.`}
      onClose={finish}
      foot={<>
        <span className="sa-modal-note">They set their own password from the sign-in page whenever they like.</span>
        <div className="sa-modal-actions"><button className="sa-confirm" onClick={finish} autoFocus>Done</button></div>
      </>}>
      <button type="button" className="sa-cred" onClick={copy} title="Copy both">
        <span><small>E-mail</small><b>{email.trim()}</b></span>
        <span><small>Password</small><b className="is-pw">{password}</b></span>
        <i>{copied ? <><Check size={13} strokeWidth={2.6} /> Copied</> : "Copy both"}</i>
      </button>
      {err && <p className="sa-error">{err}</p>}
    </Modal>
  );

  return (
    <Modal icon={<UserPlus size={19} strokeWidth={1.9} />} kicker="New login" width={fixed ? 480 : 520}
      title={fixed ? `Add a user to ${fixed.name}` : "Add a user"}
      sub="E-mail, password and their role. The company can change the role later in its own Settings."
      onClose={onClose}
      foot={<>
        <span className="sa-modal-note">{co ? <>{co.name}: {Math.min(co.users + 1, co.max)} of {co.max} seats after this</> : "Pick a company to see its seats"}</span>
        <div className="sa-modal-actions">
          <button className="sa-cancel" onClick={onClose}>Cancel</button>
          <button className={`sa-confirm ${co?.plan === "base" ? "is-base" : ""}`} onClick={() => void submit()}
            disabled={busy || !co || full(co) || !email.trim() || !!passwordProblem(password)}>{busy ? "Creating…" : "Create login"}</button>
        </div>
      </>}>
      <form className="sa-mform" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {!fixed && (
          <div className="sa-mf">
            <span>Company</span>
            {companies.length > 6 && (
              <span className="sa-search sa-pick-find"><Search size={14} /><input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a company" /></span>
            )}
            <div className="sa-pick" role="radiogroup" aria-label="Company">
              {list.map((c) => {
                const on = c.id === tid, isFull = full(c);
                return (
                  <button key={c.id} type="button" role="radio" aria-checked={on} disabled={isFull || !c.active}
                    className={`sa-pick-row ${on ? "is-on" : ""}`} onClick={() => { setTid(c.id); setErr(""); }} style={{ ["--pc" as string]: c.color }}>
                    <span className="sa-pick-av">{initials(c.name)}</span>
                    <span className="sa-pick-t"><b>{c.name}</b><small>{!c.active ? "Disabled" : isFull ? "No free seat" : `${c.max - c.users} free of ${c.max} seats`}</small></span>
                    <i className={`sa-plan-pill is-${c.plan}`}>{PLAN_LABEL[c.plan]}</i>
                    <span className="sa-plan-radio" aria-hidden="true">{on && <Check size={11} strokeWidth={3.2} />}</span>
                  </button>
                );
              })}
              {!list.length && <span className="sa-pick-none">No company matches.</span>}
            </div>
          </div>
        )}
        <label className="sa-mf"><span>E-mail</span>
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setErr(""); }} placeholder="name@company.com" autoFocus={!!fixed} autoComplete="off" spellCheck={false} />
        </label>
        <label className="sa-mf"><span>Role</span>
          <span className="sa-chipsel is-full">
            <Select value={level} onChange={setLevel} disabled={!co || !roles} aria-label="Role"
              options={[{ value: "", label: !co ? "Pick the company first" : !roles ? "Loading roles…" : "Default (Consultant)" }, ...(roles ?? []).map((r) => ({ value: r.level_key, label: r.name }))]} />
          </span>
        </label>
        <label className="sa-mf"><span>Password</span>
          <span className="sa-mf-row">
            <input value={password} onChange={(e) => { setPassword(e.target.value); setErr(""); }} placeholder="8+ letters, numbers, symbol" title={PASSWORD_HINT} autoComplete="new-password" spellCheck={false} />
            <button type="button" className="sa-mf-btn" onClick={() => setPassword(makePw())}><Wand2 size={14} strokeWidth={2} /> Generate</button>
          </span>
          <PwRules pw={password} />
        </label>
        {err && <p className="sa-error">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
