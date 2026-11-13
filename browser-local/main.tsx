import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLocalTrackerStorage } from "../src/browser-local/storage";
import BrowserLocalApp from "../src/browser-local/ui/BrowserLocalApp";
import "../src/browser-local/ui/browser-local.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");

const storage = createLocalTrackerStorage();
createRoot(container).render(
  <StrictMode>
    <BrowserLocalApp storage={storage} />
  </StrictMode>,
);
