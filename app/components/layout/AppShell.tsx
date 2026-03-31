import { useState } from "react";
import { NavLink } from "react-router";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: "◈" },
  { to: "/chat", label: "Chat", icon: "⌘" },
  { to: "/graph", label: "Graph", icon: "⬡" },
  { to: "/entities", label: "Entities", icon: "◎" },
  { to: "/ops", label: "Ops & Config", icon: "⚙" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const sidebarContent = (
    <>
      <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
        <div>
          <span className="text-sm font-semibold tracking-widest text-[var(--color-accent)] uppercase">
            AISight
          </span>
          <p className="text-xs text-white/40 mt-0.5">Central Bank Intelligence</p>
        </div>
        {/* Close button — mobile only */}
        <button
          className="md:hidden p-1 text-white/40 hover:text-white"
          onClick={() => setMobileOpen(false)}
          aria-label="Close menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="4" x2="16" y2="16" />
            <line x1="16" y1="4" x2="4" y2="16" />
          </svg>
        </button>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                  : "text-white/60 hover:text-white hover:bg-white/5"
              }`
            }
          >
            <span className="w-4 text-center">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-[var(--color-border)] text-xs text-white/30">
        v0.1.0
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-screen">
      {/* Desktop sidebar — hidden on mobile */}
      <aside className="hidden md:flex w-56 shrink-0 bg-[var(--color-surface-1)] border-r border-[var(--color-border)] flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[var(--color-surface-1)] border-r border-[var(--color-border)] flex flex-col transform transition-transform duration-200 ease-in-out md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-[var(--color-surface)]">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1 text-white/60 hover:text-white"
            aria-label="Open menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="17" y2="6" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="14" x2="17" y2="14" />
            </svg>
          </button>
          <span className="text-sm font-semibold tracking-widest text-[var(--color-accent)] uppercase">
            AISight
          </span>
        </div>

        {children}
      </main>
    </div>
  );
}
