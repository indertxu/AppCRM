import { useEffect, useState } from "react";
import { supabase } from "../../api/supabase";
import { useAuth } from "../../api/AuthProvider";
import CalendarWidget from "./CalendarWidget";
import ManagementWidget from "./ManagementWidget";
import { SalesPipelineWidget, NeglectedClientsWidget, TeamBonusWidget } from "./HomeWidgets";
import ConsultancyHome from "./ConsultancyHome";
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

export default function HomePage() {
  const { role } = useAuth();
  const [me, setMe] = useState<{ id: string; department: string | null; role: string | null } | null>(null);
  const [hoursPerDay, setHoursPerDay] = useState(8);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;
      const [{ data: prof }, { data: bs }] = await Promise.all([
        supabase.from("profiles").select("id, department, role").eq("id", uid).maybeSingle(),
        supabase.from("billing_settings").select("hours_per_day").eq("id", "default").maybeSingle(),
      ]);
      if (!alive) return;
      setMe(prof ? { id: (prof as any).id, department: (prof as any).department, role: (prof as any).role } : { id: uid, department: null, role: role ?? null });
      setHoursPerDay(Number((bs as any)?.hours_per_day) || 8);
    })();
    return () => { alive = false; };
  }, [role]);

  // Home is decided by DEPARTMENT (a boss inside consultancy still sees the
  // consultancy home). Role only governs how much of the team they see.
  const dept = me?.department ?? null;
  const isLead = me?.role === "boss" || me?.role === "consultancy_manager";
  const isManager = role === "boss" || role === "consultancy_manager" || role === "sales_manager";

  return (
    <div className="home">
      <div className="home-flood" aria-hidden="true" />

      <header className="home-bar">
        <span className="home-logo-mini" aria-hidden="true"><NextLogo /></span>
        <div className="home-hello">
          <span className="home-eyebrow">Next Management</span>
          <h1 className="home-title">{greeting()}</h1>
        </div>
        <span className="home-date">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span>
      </header>

      {dept === "consultancy" && me ? (
        <ConsultancyHome userId={me.id} isLead={isLead} hoursPerDay={hoursPerDay} />
      ) : (
        <main className={`home-bento ${isManager ? "is-manager" : "is-basic"}`}>
          <div className="home-cell home-cell-cal"><CalendarWidget /></div>
          {isManager && (
            <>
              <div className="home-cell home-cell-mw"><ManagementWidget /></div>
              <div className="home-cell home-cell-pipe"><SalesPipelineWidget /></div>
              <div className="home-cell home-cell-neglect"><NeglectedClientsWidget /></div>
              <div className="home-cell home-cell-bonus"><TeamBonusWidget /></div>
            </>
          )}
        </main>
      )}
    </div>
  );
}