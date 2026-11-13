/**
 * A part of a page that broke shows what went wrong and a way back, instead of a blank screen.
 * The message is shown (and logged) so whoever sees it can pass it on.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import "./ErrorBoundary.css";

interface Props {
  /** What broke, in words ("Reports"). */
  what: string;
  children: ReactNode;
  /** Changing it clears the error (e.g. the route or the open report). */
  resetKey?: unknown;
  /** Inside a card: a small note instead of the full panel. */
  small?: boolean;
}
interface State { error: Error | null; key: unknown }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null {
    return p.resetKey !== s.key ? { key: p.resetKey, error: null } : null;
  }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[${this.props.what}]`, error, info.componentStack); }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className={`eb ${this.props.small ? "is-small" : ""}`} role="alert">
        <span className="eb-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
        </span>
        <b>{this.props.what} ran into a problem</b>
        <span>Try again; if it keeps happening, send this message to your admin:</span>
        <code>{String(e.message || e).slice(0, 400)}</code>
        <div className="eb-acts">
          <button type="button" className="eb-btn is-main" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="eb-btn" onClick={() => window.location.reload()}>Reload the page</button>
        </div>
      </div>
    );
  }
}
