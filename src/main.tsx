import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./components/api/AuthProvider";
import "./index.css";
import App from "./App";

// One number format everywhere in the app: dots for thousands, a comma for decimals (1.234.567 · 1.234,5),
// whatever the browser's language or the locale a screen asks for.
const nativeToLocale = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (this: number, _locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
  return nativeToLocale.call(this, "de-DE", options);
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);