"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/applications", label: "Applications" },
  { href: "/settings", label: "Settings" },
];

/** Clears the browser session cookie via the existing DELETE /api/auth/session route. */
export async function endSession(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/auth/session", { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError("");
    if (await endSession()) {
      router.replace("/connect");
      return;
    }
    setSignOutError("Sign out failed. Try again.");
    setSigningOut(false);
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
      <div className={`sidebar-footer ${menuOpen ? "is-open" : "is-collapsed"}`}>
        <button
          type="button"
          className="sidebar-signout"
          disabled={signingOut}
          onClick={handleSignOut}
        >
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
        {signOutError && (
          <p role="alert" className="sidebar-signout-error">{signOutError}</p>
        )}
      </div>
    </aside>
  );
}
