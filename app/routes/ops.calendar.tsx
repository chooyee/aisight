import type { LoaderFunctionArgs, ActionFunctionArgs } from "@react-router/node";
import { useLoaderData, useFetcher } from "react-router";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { fiscalCalendars } from "~/lib/db/schema";
import { useState } from "react";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(fiscalCalendars).orderBy(fiscalCalendars.entityName);
  return { calendars: rows };
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "create") {
    const entityName = (form.get("entityName") as string)?.trim();
    const yearStartMonth = Number(form.get("yearStartMonth") ?? 1);
    const quarterStartMonths = (form.get("quarterStartMonths") as string)
      ?.split(",")
      .map((n) => Number(n.trim()))
      .filter((n) => n >= 1 && n <= 12);
    if (!entityName) return Response.json({ error: "Entity name required" }, { status: 400 });
    await db.insert(fiscalCalendars).values({
      id: nanoid(),
      entityName,
      yearStartMonth,
      quarterStartMonths: JSON.stringify(quarterStartMonths.length ? quarterStartMonths : [1, 4, 7, 10]),
    });
    return Response.json({ ok: true });
  }

  if (intent === "delete") {
    await db.delete(fiscalCalendars).where(eq(fiscalCalendars.id, form.get("id") as string));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

export default function OpsCalendar() {
  const { calendars } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-white/50">{calendars.length} fiscal calendars defined</p>
        <button onClick={() => setShowForm((v) => !v)} className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">
          + Add Calendar
        </button>
      </div>

      {showForm && (
        <fetcher.Form method="post" className="mb-4 p-4 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg space-y-3">
          <input type="hidden" name="intent" value="create" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/50 mb-1">Entity Name</label>
              <input name="entityName" required placeholder="e.g. Maybank" className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]" />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Fiscal Year Start Month (1-12)</label>
              <input name="yearStartMonth" type="number" min={1} max={12} defaultValue={1} className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-white/50 mb-1">Quarter Start Months (comma-separated, e.g. 1,4,7,10)</label>
            <input name="quarterStartMonths" placeholder="1,4,7,10" defaultValue="1,4,7,10" className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 text-sm bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">Save</button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-white/50 hover:text-white">Cancel</button>
          </div>
        </fetcher.Form>
      )}

      <div className="space-y-2">
        {calendars.map((cal) => {
          const qMonths = JSON.parse(cal.quarterStartMonths) as number[];
          const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          return (
            <div key={cal.id} className="flex items-center justify-between p-3 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg">
              <div>
                <p className="text-sm font-medium">{cal.entityName}</p>
                <p className="text-xs text-white/40 mt-0.5">
                  FY starts {monthNames[cal.yearStartMonth - 1]} · Q1={monthNames[qMonths[0] - 1]}, Q2={monthNames[qMonths[1] - 1]}, Q3={monthNames[qMonths[2] - 1]}, Q4={monthNames[qMonths[3] - 1]}
                </p>
              </div>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={cal.id} />
                <button type="submit" className="text-xs text-white/30 hover:text-red-400 px-2 py-1">✕</button>
              </fetcher.Form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
