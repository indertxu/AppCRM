/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Home page.
 *
 *   homepage/
 *     HomePage.tsx          ← this: greeting + layout, picks the right home
 *     shared/               ← what everyone gets, in the left column
 *       HomeCalendar.tsx      next 5 working days · month · coming up
 *       HomeTodo.tsx          my to-do (tasks from Sales for now)
 *     sales/SalesHome.tsx         ← right side for the sales team
 *     consultancy/ConsultancyHome ← right side for consultancy
 *     management/ManagementHome   ← right side for the boss / managers
 *
 * Which right side you get goes by DEPARTMENT first (a boss inside
 * consultancy sees consultancy), then by role. Anyone else gets the shared
 * column on its own, spread across the page.
 */
import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import HomeCalendar from "./shared/HomeCalendar";
import HomeTodo from "./shared/HomeTodo";
import SalesHome from "./sales/SalesHome";
import ConsultancyHome from "./consultancy/ConsultancyHome";
import ManagementHome from "./management/ManagementHome";
import { applyRolePreview } from "../../framework/SuperAdmin";
import "./HomePage.css";

const greeting = () => {
  const h = new Date().getHours();
  if (h < 6) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
};

const NextLogo = () => (
  <svg viewBox="14 15 92 93" role="img" aria-label="Next">
    <g transform="matrix(1,0.5,-1,0.5,60,17)">
      <rect width="38" height="38" rx="2" fill="#86efc0" />
      <polyline points="7,30 15,19 22,24 31.7,10.1" fill="none" stroke="#0a6f4d" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points="36,4 35.1,12.5 28.2,7.7" fill="#0a6f4d" />
    </g>
    <g transform="translate(16,47) skewY(26.565)"><rect width="38" height="40" rx="2" fill="#12b57f" /><text x="19" y="30" textAnchor="middle" fill="#fff" fontFamily="Arial" fontWeight="700" fontSize="27">N</text></g>
    <g transform="translate(66,66) skewY(-26.565)"><rect width="38" height="40" rx="2" fill="#0a6f4d" /><rect x="6" y="24" width="6" height="11" rx="1.5" fill="#fff" /><rect x="16" y="16" width="6" height="19" rx="1.5" fill="#fff" /><rect x="26" y="8" width="6" height="27" rx="1.5" fill="#fff" /></g>
  </svg>
);

type Me = { id: string; department: string | null; role: string | null; firstName: string | null; isSuper: boolean };
type Area = "sales" | "consultancy" | "management" | null;

const SALES_ROLES = ["sales", "sales_manager"];
const MANAGER_ROLES = ["boss", "consultancy_manager", "sales_manager"];

function areaFor(me: Me | null, authRole: string | null): Area {
  if (!me) return null;
  const role = (me.role ?? authRole ?? "").toLowerCase();
  if (me.department === "consultancy") return "consultancy";
  if (me.department === "sales" || SALES_ROLES.includes(role)) return "sales";
  if (MANAGER_ROLES.includes(role) || me.isSuper) return "management";
  return null;
}

export default function HomePage() {
  const { role } = useAuth();
  const [uid, setUid] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Local session (no trip to the auth server, which would hold up every other query).
      const { data: s } = await supabase.auth.getSession();
      const uid = s?.session?.user?.id;
      if (!uid) return;
      setUid(uid); // the shared column only needs this — it starts loading straight away
      const [{ data: prof }, { data: bs }] = await Promise.all([
        supabase.from("profiles").select("id, department, role, first_name, is_superadmin").eq("id", uid).maybeSingle(),
        supabase.from("billing_settings").select("hours_per_day").eq("id", "default").maybeSingle(),
      ]);
      if (!alive) return;
      const p = prof ? applyRolePreview(prof as any) : null; // superadmin previewing a role
      setMe({ id: uid, department: p?.department ?? null, role: p?.role ?? role ?? null, firstName: p?.first_name ?? null, isSuper: p?.is_superadmin === true });
      setHoursPerDay(Number((bs as any)?.hours_per_day) || 8);
    })();
    return () => { alive = false; };
  }, [role]);

  const area = areaFor(me, role ?? null);
  const r = (me?.role ?? role ?? "").toLowerCase();
  const isLead = r === "boss" || r === "consultancy_manager";
  const seesSalesTeam = r === "boss" || r === "sales_manager" || !!me?.isSuper;

  return (
    <div className="home">
      <div className="home-flood" aria-hidden="true" />

      <header className="home-bar">
        <span className="home-logo-mini" aria-hidden="true"><NextLogo /></span>
        <div className="home-hello">
          <span className="home-eyebrow">Next Management</span>
          <h1 className="home-title">{greeting()}{me?.firstName ? <>, <em>{me.firstName}</em></> : ""}</h1>
        </div>
        <span className="home-date">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</span>
      </header>

      {!uid ? (
        <div className="home-grid">
          <div className="home-side"><div className="home-ghost" /><div className="home-ghost is-short" /></div>
          <div className="home-main"><div className="home-ghost" /></div>
        </div>
      ) : (
        <div className={`home-grid ${me && !area ? "is-solo" : ""}`}>
          <aside className="home-side">
            <HomeCalendar userId={uid} hoursPerDay={hoursPerDay} />
            <HomeTodo />
          </aside>
          {!me ? (
            <main className="home-main"><div className="home-ghost" /></main>
          ) : area && (
            <main className="home-main">
              {area === "sales" && <SalesHome userId={me.id} seesTeam={seesSalesTeam} />}
              {area === "consultancy" && <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay} />}
              {area === "management" && <ManagementHome />}
            </main>
          )}
        </div>
      )}
    </div>
  );
}