import { NavLink, Outlet } from "react-router";
import { AppShell } from "~/components/layout/AppShell";

const TABS = [
  { to: "/ops/sectors", label: "Sectors" },
  { to: "/ops/calendar", label: "Fiscal Calendars" },
  { to: "/ops/extraction", label: "Extraction Items" },
  { to: "/ops/research", label: "Research Runs" },
];

export default function Ops() {
  return (
    <AppShell>
      <div className="p-6 max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold mb-1">Ops & Configuration</h1>
        <p className="text-sm text-white/40 mb-5">
          Manage sectors, fiscal calendars, and custom extraction rules.
        </p>

        {/* Tab nav */}
        <div className="flex gap-1 border-b border-[var(--color-border)] mb-6">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
                  isActive
                    ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                    : "border-transparent text-white/50 hover:text-white"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>

        <Outlet />
      </div>
    </AppShell>
  );
}
