import CalendarWidget from "./CalendarWidget";
import "./HomePage.css";

export default function HomePage() {
  return (
    <div className="home">
      {/* Mint flood that matches the login exit, then irises away to reveal the page */}
      <div className="home-flood" aria-hidden="true" />

<CalendarWidget />

      <div className="home-content">
        <span className="home-logo" aria-hidden="true">
          <svg viewBox="14 15 92 93" role="img" aria-label="Next logo">
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
            <g transform="translate(66,66) skewY(-26.565)">
              <rect width="38" height="40" rx="2" fill="#0a6f4d" />
              <rect x="6" y="24" width="6" height="11" rx="1.5" fill="#ffffff" />
              <rect x="16" y="16" width="6" height="19" rx="1.5" fill="#ffffff" />
              <rect x="26" y="8" width="6" height="27" rx="1.5" fill="#ffffff" />
            </g>
          </svg>
        </span>

        <span className="home-eyebrow">Next Management</span>
        <h1 className="home-title">Welcome back</h1>
<p className="home-sub">Your workspace is ready.</p>

        <div className="home-hint">
          <span className="home-hint-arrow" aria-hidden="true" />
          Hover the bottom edge for the menu
        </div>
      </div>
    </div>
  );
}