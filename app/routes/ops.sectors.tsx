import type { LoaderFunctionArgs, ActionFunctionArgs } from "@react-router/node";
import { useLoaderData, useFetcher } from "react-router";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { sectors } from "~/lib/db/schema";
import { useState } from "react";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(sectors).orderBy(sectors.name);
  return { sectors: rows };
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "create") {
    const name = (form.get("name") as string)?.trim();
    const keywords = (form.get("keywords") as string)
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!name) return Response.json({ error: "Name required" }, { status: 400 });
    await db.insert(sectors).values({ id: nanoid(), name, keywords: JSON.stringify(keywords ?? []) });
    return Response.json({ ok: true });
  }

  if (intent === "delete") {
    const id = form.get("id") as string;
    await db.delete(sectors).where(eq(sectors.id, id));
    return Response.json({ ok: true });
  }

  if (intent === "toggle") {
    const id = form.get("id") as string;
    const active = form.get("active") === "true";
    await db.update(sectors).set({ active: !active }).where(eq(sectors.id, id));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

export default function OprsSectors() {
  const { sectors: rows } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-white/50">{rows.length} sectors defined</p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-md hover:opacity-90"
        >
          + Add Sector
        </button>
      </div>

      {showForm && (
        <fetcher.Form method="post" className="mb-4 p-4 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg space-y-3">
          <input type="hidden" name="intent" value="create" />
          <div>
            <label className="block text-xs text-white/50 mb-1">Name</label>
            <input
              name="name"
              required
              placeholder="e.g. Banking"
              className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div>
            <label className="block text-xs text-white/50 mb-1">Keywords (comma-separated)</label>
            <input
              name="keywords"
              placeholder="Maybank, CIMB, capital adequacy"
              className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 text-sm bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">
              Save
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-white/50 hover:text-white">
              Cancel
            </button>
          </div>
        </fetcher.Form>
      )}

      <div className="space-y-2">
        {rows.map((sector) => (
          <div key={sector.id} className="flex items-center justify-between p-3 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg">
            <div>
              <p className="text-sm font-medium">{sector.name}</p>
              <p className="text-xs text-white/40 mt-0.5">
                {sector.keywords ? JSON.parse(sector.keywords).join(", ") || "No keywords" : "No keywords"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="id" value={sector.id} />
                <input type="hidden" name="active" value={String(sector.active)} />
                <button
                  type="submit"
                  className={`px-2 py-1 text-xs rounded-full border ${
                    sector.active
                      ? "border-green-500/40 text-green-400"
                      : "border-white/20 text-white/30"
                  }`}
                >
                  {sector.active ? "Active" : "Inactive"}
                </button>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={sector.id} />
                <button type="submit" className="text-xs text-white/30 hover:text-red-400 px-2 py-1">
                  ✕
                </button>
              </fetcher.Form>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
