/* =====================================================================
   ENTERPRISE · Billing › Workflows (adopted from Base, src/base/pages/billing/flows, 2026-11-23) — a PDF shown as paper (pdf.js draws each page
   on a canvas): no browser viewer chrome, fits the width it's given, and the
   previous pages stay on screen while the next version is drawn.
   ===================================================================== */
import { useEffect, useRef, useState } from "react";

let pdfjsP: Promise<any> | null = null;
function pdfjs(): Promise<any> {
  if (!pdfjsP) pdfjsP = (async () => {
    const lib: any = await import("pdfjs-dist");
    if (!lib.GlobalWorkerOptions.workerSrc) {
      const w: any = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      lib.GlobalWorkerOptions.workerSrc = w.default ?? w;
    }
    return lib;
  })();
  return pdfjsP;
}

export default function PdfPaper({ bytes, busy }: { bytes: Uint8Array | null; busy?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<{ src: string; ratio: number }[]>([]);
  const [width, setWidth] = useState(0);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el); setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!bytes || !width) return;
    let alive = true;
    (async () => {
      try {
        const lib = await pdfjs();
        const task = lib.getDocument({ data: bytes.slice() });
        const doc = await task.promise;
        const out: { src: string; ratio: number }[] = [];
        const px = Math.min(1400, Math.max(600, width)) * Math.min(2, window.devicePixelRatio || 1);
        for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
          const pg = await doc.getPage(i);
          const v1 = pg.getViewport({ scale: 1 });
          const vp = pg.getViewport({ scale: px / v1.width });
          const cv = document.createElement("canvas");
          cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          await pg.render({ canvasContext: cv.getContext("2d")!, viewport: vp, canvas: cv }).promise;
          out.push({ src: cv.toDataURL("image/png"), ratio: v1.height / v1.width });
        }
        try { void task.destroy?.(); } catch { /* gone */ }
        if (alive) { setPages(out); setErr(false); }
      } catch (e) { console.warn("[pdf preview]", e); if (alive) setErr(true); }
    })();
    return () => { alive = false; };
  }, [bytes, width]);

  return (
    <div className={`bf-paper ${busy ? "is-busy" : ""}`} ref={box}>
      {pages.map((p, i) => (
        <figure key={i} className="bf-sheet" style={{ aspectRatio: `1 / ${p.ratio}` }}>
          <img src={p.src} alt={`Page ${i + 1}`} draggable={false} />
          {pages.length > 1 && <figcaption>{i + 1} / {pages.length}</figcaption>}
        </figure>
      ))}
      {!pages.length && !err && <figure className="bf-sheet is-ghost"><i /><i /><i /><i /><i /></figure>}
      {err && <p className="bf-pv-err">Couldn't draw the preview — download the PDF to see it.</p>}
    </div>
  );
}
