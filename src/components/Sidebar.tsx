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
    <header className="sidebar-rail">
      <div className="sidebar-brand-row">
        <div className="sidebar-brand"><span aria-hidden="true">J/</span>JobTracker</div>
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
        className={`sidebar-nav ${menuOpen ? "is-open" : "is-collapsed"}`}
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
              className={isActive ? "sidebar-link-active" : undefined}
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
    </header>
  );
}
