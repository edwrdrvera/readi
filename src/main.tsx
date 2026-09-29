import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { runSelfTestIfEnabled } from "./selftest";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void runSelfTestIfEnabled();
