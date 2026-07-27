.cw {
  --mint: #86efc0;
  --emerald: #12b57f;
  --forest: #0a6f4d;
  --ink: #0b241a;
  --muted: #5a7d6d;
  --line: rgba(10, 111, 77, 0.14);

position: fixed;
  top: 20px;
  bottom: 20px;
  left: 20px;
  z-index: 2;
  width: 340px;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 1.5rem 1.5rem 1.4rem;
  text-align: left;
  border-radius: 24px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.74);
  backdrop-filter: blur(14px);
  box-shadow: 0 30px 70px -36px rgba(10, 111, 77, 0.6);
  font-family: "Inter", system-ui, sans-serif;
  color: var(--ink);
  animation: home-rise 0.85s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.7s;
}

.cw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.2rem;
}
.cw-eyebrow {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
}
.cw-open {
  border: none;
  background: none;
  padding: 4px 0;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--emerald);
  cursor: pointer;
  transition: transform 0.15s;
}
.cw-open:hover { transform: translateX(2px); }

/* ---- Week bar chart ---- */
.cw-week {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-bottom: 1.3rem;
}
.cw-day { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.cw-day-col {
  position: relative;
  width: 100%;
  height: 78px;
  display: flex;
  align-items: flex-end;
  border-radius: 9px;
  background: rgba(10, 111, 77, 0.06);
  overflow: hidden;
}
.cw-day-bar {
  position: relative;
  width: 100%;
  min-height: 3px;
  border-radius: 9px;
  background: rgba(18, 181, 127, 0.3);
  display: flex;
  align-items: flex-end;
  transition: height 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}
.cw-day-done {
  width: 100%;
  border-radius: 9px;
  background: linear-gradient(180deg, #12b57f, #86efc0);
  transition: height 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}
.cw-day-goal {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: repeating-linear-gradient(90deg, rgba(10,111,77,0.35) 0 3px, transparent 3px 6px);
}
.cw-day-val {
  font-family: "Space Grotesk", sans-serif;
  font-size: 11px;
  font-weight: 600;
  color: var(--forest);
  line-height: 1;
}
.cw-day-dow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.cw-day.is-today .cw-day-dow {
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: linear-gradient(120deg, var(--mint), var(--emerald));
  color: #04120d;
}

/* ---- Weekly total ---- */
.cw-figure { display: flex; align-items: baseline; gap: 7px; margin-bottom: 11px; }
.cw-figure strong {
  font-family: "Space Grotesk", sans-serif;
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
  color: var(--forest);
}
.cw-figure strong.is-under { color: #d98324; }
.cw-figure em {
  font-style: normal;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}

.cw-track {
  position: relative;
  height: 9px;
  border-radius: 999px;
  background: rgba(10, 111, 77, 0.09);
  overflow: hidden;
  margin-bottom: 9px;
}
.cw-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: rgba(18, 181, 127, 0.3);
  transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}
.cw-fill.is-done {
  background: linear-gradient(90deg, #86efc0, #12b57f);
  box-shadow: 0 0 12px -2px rgba(18, 181, 127, 0.8);
}
.cw-legend { display: flex; gap: 14px; font-size: 11px; color: var(--muted); }
.cw-legend span { display: flex; align-items: center; gap: 6px; }
.cw-legend i { width: 8px; height: 8px; border-radius: 50%; }
.cw-dot-done { background: linear-gradient(120deg, #86efc0, #12b57f); }
.cw-dot-plan { background: rgba(18, 181, 127, 0.3); }

.cw-sep { height: 1px; background: var(--line); margin: 1.2rem 0 1rem; }

/* ---- Today ---- */
.cw-today-label {
  display: block;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.cw-empty { font-size: 13px; color: var(--muted); }

.cw-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 3px;
}
.cw-list::-webkit-scrollbar { width: 6px; }
.cw-list::-webkit-scrollbar-thumb { background: rgba(18, 181, 127, 0.28); border-radius: 999px; }
.cw-list::-webkit-scrollbar-track { background: transparent; }

.cw-item {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 9px 11px;
  border-radius: 12px;
  background: rgba(18, 181, 127, 0.07);
}
.cw-item.is-confirmed { opacity: 0.6; }
.cw-item-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.cw-item-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cw-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cw-item-time { font-size: 11px; color: var(--muted); }
.cw-item-bill {
  font-size: 11px;
  font-weight: 700;
  color: var(--forest);
  flex-shrink: 0;
}

@media (max-width: 900px) {
  .cw { width: min(340px, 90vw); }
}


/* When the dock is pinned, shift the widget right so it doesn't sit under the dock. */
.dock-pinned .cw { left: 108px; }
@media (max-width: 700px) {
  .dock-pinned .cw { left: 100px; }
}