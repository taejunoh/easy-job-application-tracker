"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/applications", label: "Applications" },
  { href: "/settings", label: "Settings" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!menuOpen) return;
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => document.removeEventListener("keydown", handleDocumentKeyDown);
  }, [menuOpen]);

  return (
    <aside className="w-56 min-h-screen bg-gray-900 border-r border-gray-800 flex flex-col p-4 sidebar-rail">
      <div className="sidebar-brand-row">
        <div className="text-lg font-bold text-blue-400 sidebar-brand">JobTracker</div>
        <button
          ref={triggerRef}
          type="button"
          className="icon-button mobile-menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span aria-hidden="true">☰</span>
        </button>
      </div>
      <nav
        id="primary-navigation"
        className={`flex flex-col gap-1 sidebar-nav ${menuOpen ? "is-open" : "is-collapsed"}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeMenu();
        }}
      >
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
              className={`px-3 py-2 rounded text-sm ${
                isActive
                  ? "bg-gray-800 text-white sidebar-link-active"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
