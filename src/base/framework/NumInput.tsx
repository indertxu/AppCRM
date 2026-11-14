import { forwardRef, useState, type InputHTMLAttributes } from "react";

/**
 * A number field that lets you type what you mean.
 *
 * A plain controlled <input type="number"> fights the keyboard: a field that shows 0 as empty
 * (value={n === 0 ? "" : n}, value={n || ""}) wipes the "0" you type before "0.5", and one that
 * turns its text into a number and back loses the "." of "0." or the last "0" of "1.50".
 * While the field has the focus, NumInput shows exactly what was typed and still hands every
 * change to onChange as usual; it only shows the parent's value again when that value really
 * differs (the parent clamped or rounded it) and when the field loses the focus.
 *
 * Drop-in for <input>: same props (type="number" as before, or a text field with inputMode="decimal",
 * which also takes a comma as the decimal point and steps with ↑ / ↓).
 */
const num = (s: unknown): number => {
  const t = String(s ?? "").trim().replace(",", ".");
  return t === "" ? 0 : Number(t);
};
const shownOf = (v: unknown): string => (v == null ? "" : String(v));

export const NumInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function NumInput(
  { type, value, onChange, onFocus, onBlur, onKeyDown, ...rest },
  ref,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const controlled = value !== undefined;

  // what was typed stays while it means the same number as the parent's value (or isn't a number yet: "", "-", ".")
  const keep = draft != null && (draft.trim() === "" || !Number.isFinite(num(draft)) || num(draft) === num(value));
  const shown = controlled ? (keep ? draft! : shownOf(value)) : undefined;

  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      inputMode={rest.inputMode ?? "decimal"}
      {...(controlled ? { value: shown } : {})}
      onFocus={(e) => { if (controlled) setDraft(shownOf(value)); onFocus?.(e); }}
      onBlur={(e) => { setDraft(null); onBlur?.(e); }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        // "-" or "." alone: not a number yet — wait for the next key
        if (raw.trim() !== "" && !Number.isFinite(num(raw))) return;
        if (!raw.includes(",")) { onChange?.(e); return; }
        // "0,75" (a text field): the parent reads "0.75"
        const el = e.target;
        const target = new Proxy(el, {
          get: (t, k) => {
            if (k === "value") return raw.replace(/,/g, ".");
            const v = Reflect.get(t, k, t);
            return typeof v === "function" ? v.bind(t) : v;
          },
        });
        onChange?.({ ...e, target, currentTarget: target } as typeof e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || type === "number" || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        // a text field steps like a number field
        e.preventDefault();
        const el = e.currentTarget;
        const step = Number(rest.step) || 1;
        let next = num(el.value) + (e.key === "ArrowUp" ? step : -step);
        if (rest.min != null && rest.min !== "" && next < Number(rest.min)) next = Number(rest.min);
        if (rest.max != null && rest.max !== "" && next > Number(rest.max)) next = Number(rest.max);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, String(+next.toFixed(6)));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }}
    />
  );
});

export default NumInput;
