import "./wdyr";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useFeedbackPersistence } from "./hooks/use-feedback-persistence";
import { ErrorBoundary } from "./components/error-boundary";
import { mark } from "./lib/startup-metrics";

mark("script-eval");

// The save participant survives an App ErrorBoundary fallback.
function NativeFeedbackPersistence() {
  useFeedbackPersistence();
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <NativeFeedbackPersistence />
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
