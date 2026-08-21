/* eslint-disable @typescript-eslint/no-explicit-any */
import { useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

export interface MentionPerson {
  id: string;              // "employee:<id>" or "contact:<id>"
  name: string;
  kind: "employee" | "contact";
}

interface Props {
  value: string;                            // plain text (mentions serialized as "@[name](id)")
  onChange: (v: string) => void;
  people: MentionPerson[];
  onMention: (p: MentionPerson) => void;
  placeholder?: string;
  multiline?: boolean;
  onEnter?: () => void;
  className?: string;
}

const norm = (s: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// A pill node is a non-editable span carrying data-mid (the person id) and data-name.
function makePill(p: MentionPerson): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `mi-pill ${p.kind === "employee" ? "mi-pill-int" : "mi-pill-ext"}`;
  span.contentEditable = "false";
  span.dataset.mid = p.id;
  span.dataset.name = p.name;
  span.textContent = p.name;
  return span;
}

// Serialize the editor's DOM into plain text with mentions as "@[name](id)".
function serialize(root: HTMLElement): string {
  let out = "";
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      if (node.classList.contains("mi-pill")) {
        out += `@[${node.dataset.name}](${node.dataset.mid})`;
      } else if (node.tagName === "BR") {
        out += "\n";
      } else {
        out += node.textContent ?? "";
      }
    }
  });
  return out;
}

export default function MentionInput({ value, onChange, people, onMention, placeholder, multiline, onEnter, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean }>({ left: 0, top: 0, up: false });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(!value);

  // Push current DOM state up as serialized text.
  const emit = useCallback(() => {
    if (!ref.current) return;
    onChange(serialize(ref.current));
    setEmpty(ref.current.textContent?.trim() === "" && !ref.current.querySelector(".mi-pill"));
  }, [onChange]);

  // Find the "@query" the caret is currently in (within the active text node).
  const readTrigger = (): { node: Text; at: number; q: string } | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent ?? "";
    const caret = range.startOffset;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        const before = i === 0 ? " " : text[i - 1];
        if (i === 0 || /\s/.test(before)) return { node: node as Text, at: i, q: text.slice(i + 1, caret) };
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  };

  const onInput = () => {
    emit();
    const trig = readTrigger();
    if (trig) {
      setQuery(trig.q); setActive(0);
      // position the portal popover near the caret / editor
      const rect = ref.current?.getBoundingClientRect();
      if (rect) {
        const estH = 300; // max popover height guess
        const spaceBelow = window.innerHeight - rect.bottom;
        const up = spaceBelow < estH && rect.top > spaceBelow;
        setPos({ left: rect.left, top: up ? rect.top : rect.bottom, up });
      }
      setMenu(true);
    }
    else { setMenu(false); setQuery(""); }
  };

  const filtered = menu ? people.filter((p) => norm(p.name).includes(norm(query))).slice(0, 8) : [];

  const insertPill = (p: MentionPerson) => {
    const trig = readTrigger();
    if (!trig || !ref.current) return;
    const { node, at, q } = trig;
    // Split the text node: keep text before "@", drop "@query", insert pill + trailing space.
    const full = node.textContent ?? "";
    const before = full.slice(0, at);
    const after = full.slice(at + 1 + q.length);
    const parent = node.parentNode!;
    const pill = makePill(p);
    const space = document.createTextNode("\u00a0");
    const beforeNode = document.createTextNode(before);
    const afterNode = document.createTextNode(after);
    parent.insertBefore(beforeNode, node);
    parent.insertBefore(pill, node);
    parent.insertBefore(space, node);
    parent.insertBefore(afterNode, node);
    parent.removeChild(node);
    // caret right after the inserted space
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(space, space.length);
    range.collapse(true);
    sel?.removeAllRanges(); sel?.addRange(range);
    setMenu(false); setQuery("");
    onMention(p);
    emit();
  };

  const onKeyDown = (e: any) => {
    if (menu && filtered.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % filtered.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + filtered.length) % filtered.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertPill(filtered[active]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMenu(false); return; }
    }
    if (e.key === "Enter") {
      if (!multiline) { e.preventDefault(); onEnter?.(); return; }
    }
  };

  // Close menu on outside click.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(t as HTMLElement).closest?.(".mi-pop")) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  // When parent clears value (after submit), wipe the editor.
  useEffect(() => {
    if (!ref.current) return;
    if (value === "" && (ref.current.textContent || ref.current.querySelector(".mi-pill"))) {
      ref.current.innerHTML = "";
      setEmpty(true);
    }
  }, [value]);

  return (
    <div className="mi-wrap">
      <div
        ref={ref}
        className={`mi-editor ${multiline ? "mi-multi" : "mi-single"} ${className ?? ""} ${empty ? "mi-empty" : ""}`}
        contentEditable
        role="textbox"
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        suppressContentEditableWarning
      />
      {menu && filtered.length > 0 && createPortal(
        <div className="mi-pop" style={{ position: "fixed", left: pos.left, top: pos.up ? undefined : pos.top + 4, bottom: pos.up ? window.innerHeight - pos.top + 4 : undefined }}>
          {filtered.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`mi-opt ${i === active ? "is-active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); insertPill(p); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`mi-av ${p.kind === "employee" ? "mi-av-int" : "mi-av-ext"}`}>{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="mi-name">{p.name}</span>
              <span className="mi-kind">{p.kind === "employee" ? "Team" : "Contact"}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}