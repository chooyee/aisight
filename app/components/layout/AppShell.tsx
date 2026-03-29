import { NavLink } from "react-router";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: "◈" },
  { to: "/chat", label: "Chat", icon: "⌘" },
  { to: "/graph", label: "Graph", icon: "⬡" },
  { to: "/entities", label: "Entities", icon: "◎" },
  { to: "/ops", label: "Ops & Config", icon: "⚙" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-[var(--color-surface-1)] border-r border-[var(--color-border)] flex flex-col">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <span className="text-sm font-semibold tracking-widest text-[var(--color-accent)] uppercase">
            AISight
          </span>
          <p className="text-xs text-white/40 mt-0.5">Central Bank Intelligence</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
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
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-[var(--color-surface)]">
        {children}
      </main>
    </div>
  );
}
