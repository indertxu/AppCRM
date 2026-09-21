/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { supabase } from "../../api/supabase";
import Select from "../../framework/Select";
import {
  listPipelines, createPipeline, renamePipeline, deletePipeline,
  loadPipeline, addPhase, updatePhase, deletePhase, addLink, removeLink,
  setPhaseDepartments, setPhaseItems, setPipelineSource, syncPipelineToBlueprint, setPipelineSales,
  type Pipeline, type Phase, type PipelineLink,
} from "./pipelineApi";
import { loadBlueprintData, type Blueprint } from "./blueprintsApi";
import "./PipelinePage.css";

interface Props { onBack: () => void; }

// Fixed departments — SVG icons (centre perfectly, unlike unicode glyphs)
const DI = {
  consultancy: <path d="M12 3l9 5v8l-9 5-9-5V8z" />,
  human_resources: <><circle cx="12" cy="8" r="3.2" /><path d="M6 20a6 6 0 0 1 12 0" /></>,
  marketing: <path d="M4 9v6h3l7 4V5L7 9z M17 8a4 4 0 0 1 0 8" />,
  sales: <path d="M4 18l5-5 3 3 7-8" />,
  customer_success: <path d="M12 4l2.3 4.7 5.2.8-3.8 3.7.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 9.5l5.2-.8z" />,
  it: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  management: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
} as const;
const DEPARTMENTS = [
  { key: "consultancy", label: "Consultancy", color: "#12b57f" },
  { key: "human_resources", label: "Human Resources", color: "#e0798c" },
  { key: "marketing", label: "Marketing", color: "#e0a13c" },
  { key: "sales", label: "Sales", color: "#3c9ae0" },
  { key: "customer_success", label: "Customer Success", color: "#9b6fd0" },
  { key: "it", label: "IT", color: "#4a5568" },
  { key: "management", label: "Management", color: "#0a6f4d" },
];
const deptLabel = (k: string) => DEPARTMENTS.find((d) => d.key === k)?.label ?? k;
const deptColor = (k: string) => DEPARTMENTS.find((d) => d.key === k)?.color ?? "#5a7d6d";
const DeptIcon = ({ k }: { k: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    {DI[k as keyof typeof DI] ?? <circle cx="12" cy="12" r="4" />}
  </svg>
);

const NODE_W = 200;
const NODE_H = 92;

export default function PipelinePage({ onBack }: Props) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const refresh = async () => {
    const ps = await listPipelines().catch(() => []);
    setPipelines(ps);
    setPreviewId((cur) => cur ?? ps[0]?.id ?? null);
  };
  useEffect(() => { refresh(); }, []);

  if (openId) {
    const pipe = pipelines.find((p) => p.id === openId);
    return <PipelineEditor pipeline={pipe!} onBack={() => { setOpenId(null); refresh(); }} onRenamed={refresh} />;
  }

  const clickCard = (id: string) => {
    if (previewId === id) setOpenId(id);   // second click on the previewed one → enter
    else setPreviewId(id);                  // first click → preview
  };

  return (
    <div className="pl">
      <header className="pl-head">
        <button className="pl-back" onClick={onBack} aria-label="Back">‹</button>
        <div><h1 className="pl-title">Client Pipelines</h1></div>
        <button className="pl-new" onClick={async () => {
          const p = await createPipeline("Untitled pipeline");
          if (p) { await refresh(); setOpenId(p.id); }
        }}>+ New pipeline</button>
      </header>

      {pipelines.length === 0 ? (
        <p className="pl-empty">No pipelines yet. Create one to design the phases a client goes through.</p>
      ) : (
        <div className="pl-overview">
          <div className="pl-list">
            {pipelines.map((p) => (
              <div
                key={p.id}
                className={`pl-row ${previewId === p.id ? "is-active" : ""}`}
                onClick={() => clickCard(p.id)}
              >
                <span className="pl-row-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="5" cy="6" r="2.4" /><circle cx="5" cy="18" r="2.4" /><circle cx="19" cy="12" r="2.4" />
                    <path d="M7.4 6H12a3 3 0 0 1 3 3v.5M7.4 18H12a3 3 0 0 0 3-3v-.5" />
                  </svg>
                </span>
                <span className="pl-row-name">{p.name}</span>
                <button className="pl-row-open" onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }} title="Open editor" aria-label="Open editor">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              </div>
            ))}
          </div>

          <div className="pl-preview">
            {previewId ? (
              <PipelinePreview key={previewId} pipelineId={previewId} onOpen={() => setOpenId(previewId)} />
            ) : (
              <div className="pl-preview-empty">Select a pipeline to preview</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================ Read-only quick view (pan + zoom) ============================
function PipelinePreview({ pipelineId, onOpen }: { pipelineId: string; onOpen: () => void }) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [links, setLinks] = useState<PipelineLink[]>([]);
  const [viewX, setViewX] = useState(30);
  const [viewY, setViewY] = useState(30);
  const [zoom, setZoom] = useState(0.75);
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    loadPipeline(pipelineId).then(({ phases, links }) => {
      setPhases(phases); setLinks(links);
      // fit content roughly into view
      if (phases.length) {
        const minX = Math.min(...phases.map((p) => p.pos_x));
        const minY = Math.min(...phases.map((p) => p.pos_y));
        setViewX(40 - minX * 0.75); setViewY(40 - minY * 0.75); setZoom(0.75);
      }
    }).catch(() => {});
  }, [pipelineId]);

  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(1.6, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 0.9))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const center = (p: Phase) => ({ x: p.pos_x + NODE_W / 2, y: p.pos_y + NODE_H / 2 });

  return (
    <div
      className="pl-qv"
      ref={ref}
      onPointerDown={(e) => { pan.current = { sx: e.clientX, sy: e.clientY, vx: viewX, vy: viewY }; ref.current?.setPointerCapture(e.pointerId); }}
      onPointerMove={(e) => { if (pan.current) { setViewX(pan.current.vx + (e.clientX - pan.current.sx)); setViewY(pan.current.vy + (e.clientY - pan.current.sy)); } }}
      onPointerUp={() => { pan.current = null; }}
      onDoubleClick={onOpen}
    >
      <div className="pl-qv-world" style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}>
        <svg className="pl-lines">
          <defs>
            <marker id="pl-qv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="rgba(134,239,192,0.8)" />
            </marker>
          </defs>
          {links.map((l) => {
            const a = phases.find((p) => p.id === l.from_phase);
            const b = phases.find((p) => p.id === l.to_phase);
            if (!a || !b) return null;
            const ca = center(a), cb = center(b);
            return <line key={l.id} x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} className="pl-link-line" markerEnd="url(#pl-qv-arrow)" />;
          })}
        </svg>
        {phases.map((p) => (
          <div key={p.id} className="pl-node pl-node-ro"
            style={{ left: p.pos_x, top: p.pos_y, width: NODE_W, minHeight: NODE_H, ...(p.deptKeys[0] ? { borderColor: `${deptColor(p.deptKeys[0])}66` } : {}) }}>
            <div className="pl-node-name">{p.name || "Untitled phase"}</div>
            <div className="pl-node-depts">
              {p.deptKeys.map((k) => (
                <span key={k} className="pl-dept-badge" style={{ background: deptColor(k) }}><DeptIcon k={k} /></span>
              ))}
            </div>
            {p.items.length > 0 && <div className="pl-node-items">{p.items.length} item{p.items.length !== 1 ? "s" : ""}</div>}
          </div>
        ))}
        {phases.length === 0 && <div className="pl-qv-empty">This pipeline has no phases yet.</div>}
      </div>
      <button className="pl-qv-open" onClick={onOpen}>Open editor →</button>
    </div>
  );
}

// ============================ Editor ============================
function PipelineEditor({ pipeline, onBack, onRenamed }: { pipeline: Pipeline; onBack: () => void; onRenamed: () => void; }) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [links, setLinks] = useState<PipelineLink[]>([]);
  const [name, setName] = useState(pipeline.name);
  const [isSales, setIsSales] = useState<boolean>(pipeline.is_sales ?? false);
  const [selId, setSelId] = useState<string | null>(null);
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  const [depts, setDepts] = useState<{ key: string; label: string; color: string }[]>([]);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [allPipelines, setAllPipelines] = useState<Pipeline[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);

  // pan + zoom
  const [viewX, setViewX] = useState(40);
  const [viewY, setViewY] = useState(40);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null);
  const linking = useRef<{ from: string } | null>(null);
  const [linkGhost, setLinkGhost] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [, force] = useState(0);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const livePos = useRef<{ x: number; y: number } | null>(null);

  const reload = async () => {
    // If this pipeline came from a blueprint, sync phases (add/remove) before loading.
    if (pipeline.source_blueprint_id) {
      const bpData = await loadBlueprintData().catch(() => null);
      const bp = bpData?.blueprints.find((b) => b.id === pipeline.source_blueprint_id);
      if (bp) await syncPipelineToBlueprint(pipeline.id, bp.phases.map((p) => ({ id: p.id, name: p.name })));
    }
    const { phases, links } = await loadPipeline(pipeline.id);
    setPhases(phases); setLinks(links);
  };
  useEffect(() => {
    reload();
    supabase.from("products").select("id,name").then(({ data }: any) => setProducts(data ?? []));
    supabase.from("services").select("id,name").then(({ data }: any) => setServices(data ?? []));
    // Load the real departments placed on the org chart, keeping the shared icon/color.
    supabase.from("org_departments").select("dept_key").then(({ data }: any) => {
      const keys: string[] = (data ?? []).map((d: any) => d.dept_key);
      const list = (keys.length ? keys : DEPARTMENTS.map((d) => d.key)).map((k) => {
        const meta = DEPARTMENTS.find((d) => d.key === k);
        return { key: k, label: meta?.label ?? k, color: meta?.color ?? "#5a7d6d" };
      });
      setDepts(list);
    });
    loadBlueprintData().then((d) => setBlueprints(d.blueprints)).catch(() => {});
    listPipelines().then((ps) => setAllPipelines(ps.filter((p) => p.id !== pipeline.id))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id]);

  const toCanvas = (cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - viewX) / zoom, y: (cy - r.top - viewY) / zoom };
  };

  // ---- pan ----
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".pl-node")) return;
    if (linking.current) { linking.current = null; setLinkGhost(null); return; }
    pan.current = { sx: e.clientX, sy: e.clientY, vx: viewX, vy: viewY };
    canvasRef.current?.setPointerCapture(e.pointerId);
    setSelId(null);
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    if (linking.current) {
      const from = phases.find((p) => p.id === linking.current!.from);
      if (from) {
        const p = toCanvas(e.clientX, e.clientY);
        setLinkGhost({ x1: from.pos_x + NODE_W / 2, y1: from.pos_y + NODE_H / 2, x2: p.x, y2: p.y });
      }
    }
    if (drag.current) {
      const d = drag.current;
      if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      const p = toCanvas(e.clientX, e.clientY);
      const x = Math.round(p.x - d.dx), y = Math.round(p.y - d.dy);
      livePos.current = { x, y };
      // Move the node directly in the DOM — no React re-render, so it tracks the cursor 1:1.
      const el = nodeRefs.current[d.id];
      if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
      // Update any connected link lines live.
      const cx = x + NODE_W / 2, cy = y + NODE_H / 2;
      links.forEach((l) => {
        if (l.from_phase === d.id) {
          document.querySelectorAll<SVGLineElement>(`[data-link="${l.id}"]`).forEach((ln) => { ln.setAttribute("x1", String(cx)); ln.setAttribute("y1", String(cy)); });
        }
        if (l.to_phase === d.id) {
          document.querySelectorAll<SVGLineElement>(`[data-link="${l.id}"]`).forEach((ln) => { ln.setAttribute("x2", String(cx)); ln.setAttribute("y2", String(cy)); });
        }
      });
    }
    if (pan.current) {
      setViewX(pan.current.vx + (e.clientX - pan.current.sx));
      setViewY(pan.current.vy + (e.clientY - pan.current.sy));
    }
  };
  const onCanvasPointerUp = async () => {
    if (drag.current) {
      const d = drag.current;
      if (d.moved && livePos.current) {
        const { x, y } = livePos.current;
        setPhases((ps) => ps.map((ph) => (ph.id === d.id ? { ...ph, pos_x: x, pos_y: y } : ph)));
        await updatePhase(d.id, { pos_x: x, pos_y: y });
      } else if (!d.moved) { setSelId(d.id); }
      livePos.current = null;
      drag.current = null;
    }
    pan.current = null;
  };

  // ---- node drag ----
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (linking.current) return;
    const ph = phases.find((p) => p.id === id)!;
    const p = toCanvas(e.clientX, e.clientY);
    drag.current = { id, dx: p.x - ph.pos_x, dy: p.y - ph.pos_y, moved: false, sx: e.clientX, sy: e.clientY };
    canvasRef.current?.setPointerCapture(e.pointerId);
    force((n) => n + 1);
  };

  // ---- linking (branch) ----
  const startLink = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    linking.current = { from: id };
    force((n) => n + 1);
  };
  const finishLink = async (e: React.PointerEvent, id: string) => {
    if (!linking.current) return;
    e.stopPropagation();
    const from = linking.current.from;
    linking.current = null; setLinkGhost(null);
    if (from === id) return;
    if (links.some((l) => l.from_phase === from && l.to_phase === id)) return;
    const l = await addLink(pipeline.id, from, id);
    if (l) setLinks((ls) => [...ls, l]);
  };

  // ---- zoom ----
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setZoom((z) => {
        const nz = Math.min(1.8, Math.max(0.4, z * (e.deltaY < 0 ? 1.1 : 0.9)));
        setViewX((vx) => mx - ((mx - vx) / z) * nz);
        setViewY((vy) => my - ((my - vy) / z) * nz);
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const addPhaseAt = async () => {
    // drop near the center of the current view
    const r = canvasRef.current!.getBoundingClientRect();
    const cx = (r.width / 2 - viewX) / zoom, cy = (r.height / 2 - viewY) / zoom;
    const ph = await addPhase(pipeline.id, cx - NODE_W / 2, cy - NODE_H / 2);
    if (ph) { setPhases((p) => [...p, ph]); setSelId(ph.id); }
  };
  const removePhase = async (id: string) => {
    await deletePhase(id);
    setPhases((p) => p.filter((x) => x.id !== id));
    setLinks((ls) => ls.filter((l) => l.from_phase !== id && l.to_phase !== id));
    if (selId === id) setSelId(null);
  };

  // Generate phases from a blueprint: one node per phase, in a row, linked in sequence.
  const generateFromBlueprint = async (bpId: string) => {
    const bp = blueprints.find((b) => b.id === bpId);
    if (!bp || !bp.phases.length) return;
    const baseX = 60, baseY = 120, gap = NODE_W + 80;
    const created: Phase[] = [];
    for (let i = 0; i < bp.phases.length; i++) {
      const ph = await addPhase(pipeline.id, baseX + i * gap, baseY, bp.phases[i].id);
      if (ph) { await updatePhase(ph.id, { name: bp.phases[i].name || `Phase ${i + 1}` }); created.push({ ...ph, name: bp.phases[i].name || `Phase ${i + 1}`, source_phase_key: bp.phases[i].id }); }
    }
    const newLinks: PipelineLink[] = [];
    for (let i = 0; i < created.length - 1; i++) {
      const l = await addLink(pipeline.id, created[i].id, created[i + 1].id);
      if (l) newLinks.push(l);
    }
    await setPipelineSource(pipeline.id, bpId);  // remember origin for future sync
    setPhases((p) => [...p, ...created]);
    setLinks((ls) => [...ls, ...newLinks]);
  };
  const dropLink = async (id: string) => { await removeLink(id); setLinks((ls) => ls.filter((l) => l.id !== id)); };

  // Apply a department / item to every phase at once.
  const applyDeptToAll = async (key: string) => {
    for (const ph of phases) {
      if (ph.deptKeys.includes(key)) continue;
      await setPhaseDepartments(ph.id, [...ph.deptKeys, key]);
    }
    setPhases((ps) => ps.map((ph) => ph.deptKeys.includes(key) ? ph : { ...ph, deptKeys: [...ph.deptKeys, key] }));
  };
  const applyItemToAll = async (type: "product" | "service", id: string) => {
    for (const ph of phases) {
      if (ph.items.some((i) => i.type === type && i.id === id)) continue;
      await setPhaseItems(ph.id, [...ph.items, { type, id }]);
    }
    setPhases((ps) => ps.map((ph) => ph.items.some((i) => i.type === type && i.id === id) ? ph : { ...ph, items: [...ph.items, { type, id }] }));
  };

  const saveName = async () => { if (name.trim() && name !== pipeline.name) { await renamePipeline(pipeline.id, name.trim()); onRenamed(); } };

  const sel = selId ? phases.find((p) => p.id === selId) ?? null : null;

  const center = (p: Phase) => ({ x: p.pos_x + NODE_W / 2, y: p.pos_y + NODE_H / 2 });
  const lineFor = (l: PipelineLink) => {
    const a = phases.find((p) => p.id === l.from_phase);
    const b = phases.find((p) => p.id === l.to_phase);
    if (!a || !b) return null;
    const ca = center(a), cb = center(b);
    return { id: l.id, x1: ca.x, y1: ca.y, x2: cb.x, y2: cb.y };
  };

  return (
    <div className={`pl-editor ${sel ? "is-wide" : ""}`}>
      <header className="pl-ed-head">
        <button className="pl-back" onClick={onBack} aria-label="Back">‹</button>
        <input className="pl-name-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} />
        <button
          className={`pl-sales-toggle ${isSales ? "on" : ""}`}
          onClick={async () => { const v = !isSales; setIsSales(v); await setPipelineSales(pipeline.id, v); onRenamed(); }}
          title="Show this pipeline in the Sales tracking panel"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l3-3 3 2 5-6" /></svg>
          Sales pipeline
        </button>
        <div className="pl-ed-actions">
          {phases.length > 0 && (
            <div className="pl-menu-wrap">
              <button className="pl-btn-ghost" onClick={() => { setBulkOpen((v) => !v); setGenOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
                Apply to all
              </button>
              {bulkOpen && (
                <>
                  <div className="pl-menu-layer" onClick={() => setBulkOpen(false)} />
                  <div className="pl-menu-pop">
                    <span className="pl-menu-title">Add to every phase</span>
                    <label className="pl-menu-lbl">Department</label>
                    <Select value="" onChange={(v) => v && applyDeptToAll(v)} placeholder="Pick department"
                      options={depts.map((d) => ({ value: d.key, label: d.label }))} />
                    <label className="pl-menu-lbl">Product</label>
                    <Select value="" onChange={(v) => v && applyItemToAll("product", v)} placeholder="Pick product"
                      options={products.map((p) => ({ value: p.id, label: p.name }))} />
                    <label className="pl-menu-lbl">Service</label>
                    <Select value="" onChange={(v) => v && applyItemToAll("service", v)} placeholder="Pick service"
                      options={services.map((s) => ({ value: s.id, label: s.name }))} />
                  </div>
                </>
              )}
            </div>
          )}
          {blueprints.length > 0 && (
            <div className="pl-menu-wrap">
              <button className="pl-btn-ghost" onClick={() => { setGenOpen((v) => !v); setBulkOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4.5 13H11l-1 9 8.5-11H12z" /></svg>
                From blueprint
              </button>
              {genOpen && (
                <>
                  <div className="pl-menu-layer" onClick={() => setGenOpen(false)} />
                  <div className="pl-menu-pop">
                    <span className="pl-menu-title">Generate phases from</span>
                    {blueprints.map((b) => (
                      <button key={b.id} className="pl-menu-item" onClick={() => { generateFromBlueprint(b.id); setGenOpen(false); }}>
                        {b.name || "Untitled blueprint"}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <button className="pl-btn-primary" onClick={addPhaseAt}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add phase
          </button>
        </div>
      </header>

      <div className="pl-body">
        <div
          className="pl-canvas"
          ref={canvasRef}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
        >
          <div className="pl-zoom">
            <button onClick={() => setZoom((z) => Math.min(1.8, z * 1.15))}>+</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.max(0.4, z * 0.87))}>−</button>
            <button onClick={() => { setZoom(1); setViewX(40); setViewY(40); }}>⤢</button>
          </div>

          <div className="pl-world" style={{ transform: `translate(${viewX}px, ${viewY}px) scale(${zoom})` }}>
            <svg className="pl-lines">
              <defs>
                <marker id="pl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0L10 5L0 10z" fill="rgba(134,239,192,0.8)" />
                </marker>
              </defs>
              {links.map((l) => {
                const ln = lineFor(l);
                if (!ln) return null;
                return (
                  <g key={l.id} className="pl-link">
                    <line data-link={l.id} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} className="pl-link-line" markerEnd="url(#pl-arrow)" />
                    <line data-link={l.id} x1={ln.x1} y1={ln.y1} x2={ln.x2} y2={ln.y2} className="pl-link-hit" onClick={() => dropLink(l.id)} />
                  </g>
                );
              })}
              {linkGhost && <line x1={linkGhost.x1} y1={linkGhost.y1} x2={linkGhost.x2} y2={linkGhost.y2} className="pl-link-ghost" />}
            </svg>

            {phases.map((p) => (
              <div
                key={p.id}
                ref={(el) => { nodeRefs.current[p.id] = el; }}
                className={`pl-node ${selId === p.id ? "is-sel" : ""} ${linking.current ? "is-target" : ""}`}
                style={{ left: p.pos_x, top: p.pos_y, width: NODE_W, minHeight: NODE_H, ...(p.deptKeys[0] ? { borderColor: `${deptColor(p.deptKeys[0])}66` } : {}) }}
                onPointerDown={(e) => onNodePointerDown(e, p.id)}
                onPointerUp={(e) => finishLink(e, p.id)}
              >
                <div className="pl-node-name">{p.name || "Untitled phase"}</div>
                <div className="pl-node-depts">
                  {p.deptKeys.length === 0 ? <span className="pl-node-none">No department</span> :
                    p.deptKeys.map((k) => (
                      <span key={k} className="pl-dept-badge" style={{ background: deptColor(k) }} title={deptLabel(k)}><DeptIcon k={k} /></span>
                    ))}
                </div>
                {p.items.length > 0 && <div className="pl-node-items">{p.items.length} item{p.items.length !== 1 ? "s" : ""}</div>}
                {p.handover_to && (
                  <div className="pl-node-handover">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    {allPipelines.find((x) => x.id === p.handover_to)?.name ?? "Handover"}
                  </div>
                )}
                {p.sales_outcome && (
                  <div className={`pl-node-oc pl-node-oc-${p.sales_outcome}`}>
                    {p.sales_outcome === "win" ? "★ Win" : "✕ Loss"}
                  </div>
                )}
                {isSales && !p.sales_outcome && p.close_probability != null && (
                  <div className="pl-node-prob">{p.close_probability}%</div>
                )}
                <button className="pl-node-handle" onPointerDown={(e) => startLink(e, p.id)} title="Drag to link">→</button>
              </div>
            ))}
          </div>
        </div>

        <div className={`pl-panel-wrap ${sel ? "open" : ""}`}>
          {sel && (
            <PhasePanel
              key={sel.id}
              phase={sel}
              depts={depts}
              products={products}
              services={services}
              pipelines={allPipelines}
              isSales={isSales}
              allPhases={phases}
              onSetOutcome={async (outcome) => {
                const targetId = sel.id;
                // Only one win and one loss per pipeline: clear the previous one holding this outcome.
                setPhases((ps) => ps.map((p) => {
                  if (p.id === targetId) return { ...p, sales_outcome: outcome };
                  if (outcome && p.sales_outcome === outcome) return { ...p, sales_outcome: null };
                  return p;
                }));
                if (outcome) {
                  const prev = phases.find((p) => p.id !== targetId && p.sales_outcome === outcome);
                  if (prev) await updatePhase(prev.id, { sales_outcome: null });
                }
                await updatePhase(targetId, { sales_outcome: outcome });
              }}
              onClose={() => setSelId(null)}
              onDelete={() => removePhase(sel.id)}
              onChange={(patch) => setPhases((ps) => ps.map((p) => (p.id === sel.id ? { ...p, ...patch } : p)))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================ Phase panel ============================
function PhasePanel({ phase, depts, products, services, pipelines, isSales, allPhases, onSetOutcome, onClose, onDelete, onChange }: {
  phase: Phase;
  depts: { key: string; label: string; color: string }[];
  products: { id: string; name: string }[];
  services: { id: string; name: string }[];
  pipelines: Pipeline[];
  isSales: boolean;
  allPhases: Phase[];
  onSetOutcome: (outcome: "win" | "loss" | null) => void;
  onClose: () => void; onDelete: () => void;
  onChange: (patch: Partial<Phase>) => void;
}) {
  const [name, setName] = useState(phase.name);
  const probTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (probTimer.current) clearTimeout(probTimer.current); }, []);
  const toggleDept = async (key: string) => {
    const next = phase.deptKeys.includes(key) ? phase.deptKeys.filter((k) => k !== key) : [...phase.deptKeys, key];
    onChange({ deptKeys: next });
    await setPhaseDepartments(phase.id, next);
  };
  const addItem = async (type: "product" | "service", id: string) => {
    if (phase.items.some((i) => i.type === type && i.id === id)) return;
    const next = [...phase.items, { type, id }];
    onChange({ items: next });
    await setPhaseItems(phase.id, next);
  };
  const removeItem = async (type: "product" | "service", id: string) => {
    const next = phase.items.filter((i) => !(i.type === type && i.id === id));
    onChange({ items: next });
    await setPhaseItems(phase.id, next);
  };
  const itemName = (type: "product" | "service", id: string) =>
    (type === "product" ? products : services).find((x) => x.id === id)?.name ?? "—";

  return (
    <aside className="pl-panel">
      <div className="pl-panel-head">
        <span className="pl-eyebrow">Phase</span>
        <button className="pl-x" onClick={onClose}>×</button>
      </div>

      <div className="pl-field">
        <label>Phase name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => { onChange({ name }); updatePhase(phase.id, { name }); }}
          placeholder="e.g. Onboarding" />
      </div>

      <span className="pl-section">Departments</span>
      <div className="pl-dept-grid">
        {depts.map((d) => (
          <button key={d.key}
            className={`pl-dept-chip ${phase.deptKeys.includes(d.key) ? "on" : ""}`}
            style={phase.deptKeys.includes(d.key) ? { borderColor: d.color, background: `${d.color}18` } : undefined}
            onClick={() => toggleDept(d.key)}>
            <span className="pl-dept-swatch" style={{ background: d.color }}><DeptIcon k={d.key} /></span>
            {d.label}
          </button>
        ))}
      </div>

      <span className="pl-section">Products &amp; services</span>
      <div className="pl-items">
        {phase.items.length === 0 && <p className="pl-hint">None attached yet.</p>}
        {phase.items.map((it) => (
          <span key={`${it.type}:${it.id}`} className={`pl-item ${it.type}`}>
            <span className="pl-item-ico">
              {it.type === "product" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 7v10l9 4 9-4V7" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              )}
            </span>
            {itemName(it.type, it.id)}
            <button onClick={() => removeItem(it.type, it.id)}>×</button>
          </span>
        ))}
      </div>
      <Select value="" onChange={(v) => v && addItem("product", v)} placeholder="+ Add product"
        options={products.map((p) => ({ value: p.id, label: p.name }))} />
      <div style={{ height: 8 }} />
      <Select value="" onChange={(v) => v && addItem("service", v)} placeholder="+ Add service"
        options={services.map((s) => ({ value: s.id, label: s.name }))} />

      {isSales && (
        <>
          <span className="pl-section">Sales panel</span>
          <button
            type="button" role="switch" aria-checked={phase.sales_visible !== false}
            className={`pl-sales-row ${phase.sales_visible !== false ? "on" : ""}`}
            onClick={() => { const v = !(phase.sales_visible !== false); onChange({ sales_visible: v }); updatePhase(phase.id, { sales_visible: v }); }}
          >
            <span className="pl-sales-txt">Show this phase in sales tracking</span>
            <span className="pl-sales-sw"><span className="pl-sales-knob" /></span>
          </button>
          <span className="pl-outcome-label">Outcome when reached</span>
          <div className="pl-outcome">
            <button className={`pl-oc pl-oc-none ${!phase.sales_outcome ? "on" : ""}`} onClick={() => onSetOutcome(null)}>Normal</button>
            <button className={`pl-oc pl-oc-win ${phase.sales_outcome === "win" ? "on" : ""}`} onClick={() => onSetOutcome("win")}>Win</button>
            <button className={`pl-oc pl-oc-loss ${phase.sales_outcome === "loss" ? "on" : ""}`} onClick={() => onSetOutcome("loss")}>Loss</button>
          </div>
          {phase.sales_outcome && <span className="pl-outcome-hint">Reaching this phase marks the tracking as <b>{phase.sales_outcome === "win" ? "won" : "lost"}</b>.</span>}

          {/* Close probability — the % chance a deal in this phase will close.
              Win phases are 100% and Loss 0% by definition, so the field only
              applies to normal phases. */}
          {!phase.sales_outcome ? (
            <>
              <span className="pl-outcome-label">Close probability</span>
              <div className="pl-prob">
                <input
                  className="pl-prob-input"
                  type="number" min={0} max={100} step={5}
                  value={phase.close_probability ?? ""}
                  placeholder="—"
                  onChange={(e) => {
                    const raw = e.target.value;
                    const v = raw === "" ? null : Math.max(0, Math.min(100, Number(raw)));
                    onChange({ close_probability: v });
                    // Persist on every change so switching phases can't lose it.
                    if (probTimer.current) clearTimeout(probTimer.current);
                    probTimer.current = setTimeout(() => { updatePhase(phase.id, { close_probability: v }); }, 350);
                  }}
                  onBlur={(e) => {
                    // Flush immediately on blur too, in case the debounce is pending.
                    if (probTimer.current) clearTimeout(probTimer.current);
                    const raw = e.target.value;
                    const v = raw === "" ? null : Math.max(0, Math.min(100, Number(raw)));
                    updatePhase(phase.id, { close_probability: v });
                  }}
                />
                <span className="pl-prob-pct">%</span>
                <div className="pl-prob-track">
                  <span className="pl-prob-fill" style={{ width: `${phase.close_probability ?? 0}%` }} />
                </div>
              </div>
              <span className="pl-hint" style={{ marginTop: 4 }}>Chance a deal in this phase will close. Used to weight the sales forecast.</span>
            </>
          ) : (
            <span className="pl-hint" style={{ marginTop: 6 }}>
              {phase.sales_outcome === "win" ? "Won phases count as 100% closed." : "Lost phases count as 0%."}
            </span>
          )}
        </>
      )}

      <span className="pl-section">Handover</span>
      <Select
        value={phase.handover_to ?? ""}
        onChange={(v) => { onChange({ handover_to: v || null }); updatePhase(phase.id, { handover_to: v || null }); }}
        placeholder="— No handover —"
        options={[{ value: "", label: "— No handover —" }, ...pipelines.map((p) => ({ value: p.id, label: `→ ${p.name}` }))]}
      />
      <span className="pl-hint" style={{ marginTop: 6 }}>When this phase ends, hand the client over to another pipeline.</span>

      <button className="pl-delete" onClick={onDelete}>Delete phase</button>
    </aside>
  );
}