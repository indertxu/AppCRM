import {
  useRef,
  useState,
  useEffect,
  useCallback,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { supabase, setRememberMe } from "../api/supabase";
import "./LoginPage.css";

interface Ripple {
  id: number;
  x: number;
  y: number;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const sceneRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const rippleId = useRef(0);

  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [remember, setRemember] = useState(false);

  // Cursor tracking -> CSS custom properties (no re-render, runs on rAF)
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const onMove = (e: PointerEvent) => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        const { innerWidth: w, innerHeight: h } = window;
        const nx = e.clientX / w;
        const ny = e.clientY / h;
        scene.style.setProperty("--mx", `${e.clientX}px`);
        scene.style.setProperty("--my", `${e.clientY}px`);
        scene.style.setProperty("--px", `${(nx - 0.5) * 2}`);
        scene.style.setProperty("--py", `${(ny - 0.5) * 2}`);
        rafRef.current = null;
      });
    };

    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const spawnRipple = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const id = rippleId.current++;
    setRipples((r) => [...r, { id, x: e.clientX, y: e.clientY }]);
    window.setTimeout(() => {
      setRipples((r) => r.filter((rp) => rp.id !== id));
    }, 1100);
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Persist the session only if "Keep me signed in" is checked
    setRememberMe(remember);

    const { error } = await supabase.auth.signInWithPassword({
      email: username, // using the username field as email for now
      password,
    });

    setLoading(false);

    if (error) {
      setError("Wrong email or password. Try again.");
      return;
    }

    // Success -> play the launch flood, then navigate once it covers the screen
    setLaunching(true);
    window.setTimeout(() => navigate("/home"), 780);
  };

  return (
    <div className="np-scene" ref={sceneRef} onPointerDown={spawnRipple}>
      <div className="np-grid" aria-hidden="true" />
      <div className="np-aurora" aria-hidden="true" />
      <div className="np-vignette" aria-hidden="true" />

      {ripples.map((r) => (
        <span
          key={r.id}
          className="np-ripple"
          style={{ left: r.x, top: r.y }}
          aria-hidden="true"
        />
      ))}

      <main
        className={`np-card ${launching ? "launching" : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="np-card-glow" aria-hidden="true" />

        <div className="np-brand">
          <span className="np-logo" aria-hidden="true">
            <svg viewBox="14 15 92 93" role="img" aria-label="Next logo">
              {/* Each face: outer group animates, inner group holds the cube geometry */}
              <g className="np-face np-face-top">
                <g transform="matrix(1,0.5,-1,0.5,60,17)">
                  <rect width="38" height="38" rx="2" fill="#86efc0" />
                  <polyline
                    points="7,30 15,19 22,24 31.7,10.1"
                    fill="none"
                    stroke="#0a6f4d"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <polygon points="36,4 35.1,12.5 28.2,7.7" fill="#0a6f4d" />
                </g>
              </g>
              <g className="np-face np-face-left">
                <g transform="translate(16,47) skewY(26.565)">
                  <rect width="38" height="40" rx="2" fill="#12b57f" />
                  <text
                    x="19"
                    y="30"
                    textAnchor="middle"
                    fill="#ffffff"
                    fontFamily="Arial, Helvetica, sans-serif"
                    fontWeight="700"
                    fontSize="27"
                  >
                    N
                  </text>
                </g>
              </g>
              <g className="np-face np-face-right">
                <g transform="translate(66,66) skewY(-26.565)">
                  <rect width="38" height="40" rx="2" fill="#0a6f4d" />
                  <rect x="6" y="24" width="6" height="11" rx="1.5" fill="#ffffff" />
                  <rect x="16" y="16" width="6" height="19" rx="1.5" fill="#ffffff" />
                  <rect x="26" y="8" width="6" height="27" rx="1.5" fill="#ffffff" />
                </g>
              </g>
            </svg>
          </span>

          <div className="np-wordmark">
            <span className="np-eyebrow">Management</span>
            <h1 className="np-title">Next</h1>
          </div>
        </div>

        <p className="np-lede">Sign in to your workspace</p>

        <form className="np-form" onSubmit={onSubmit}>
          <div className="np-field">
            <input
              id="np-username"
              className="np-input"
              type="text"
              autoComplete="username"
              placeholder=" "
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <label htmlFor="np-username" className="np-label">
              Email
            </label>
            <span className="np-field-line" aria-hidden="true" />
          </div>

          <div className="np-field">
            <input
              id="np-password"
              className="np-input"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder=" "
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <label htmlFor="np-password" className="np-label">
              Password
            </label>
            <button
              type="button"
              className="np-reveal"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
            <span className="np-field-line" aria-hidden="true" />
          </div>

          <div className="np-row">
            <label className="np-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Keep me signed in</span>
            </label>
            <a className="np-link" href="#forgot">
              Forgot password?
            </a>
          </div>

          {error && <p className="np-error">{error}</p>}

          <button type="submit" className="np-submit" disabled={loading}>
            <span>{loading ? "Signing in\u2026" : "Sign in"}</span>
            <span className="np-submit-sheen" aria-hidden="true" />
          </button>
        </form>

        <p className="np-foot">
          New here? <a className="np-link" href="#signup">Create an account</a>
        </p>
      </main>

      {launching && <div className="np-launch" aria-hidden="true" />}
    </div>
  );
}