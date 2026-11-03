"use client";

import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * The app shell renders the add-application panel above each page's content.
 * Pages render their title through PageHeader, which portals it into this slot
 * above the panel so the title always comes first. Without a slot (for example
 * a page rendered on its own) the header renders in place.
 */
export const PageHeaderSlotContext = createContext<HTMLElement | null>(null);

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
}

export default function PageHeader({ eyebrow, title, subtitle }: PageHeaderProps) {
  const slot = useContext(PageHeaderSlotContext);
  const header = (
    <header className="page-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="page-title">{title}</h1>
      {subtitle && <p className="page-subtitle">{subtitle}</p>}
    </header>
  );
  return slot ? createPortal(header, slot) : header;
}
