import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getDb } from "~/lib/db/client";
import { extractionItems } from "~/lib/db/schema";
import { useState } from "react";

export async function loader(_: LoaderFunctionArgs) {
  const db = getDb();
  const rows = await db.select().from(extractionItems).orderBy(extractionItems.label);
  return { items: rows };
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "create") {
    const label = (form.get("label") as string)?.trim();
    const category = (form.get("category") as string)?.trim();
    const prompt = (form.get("prompt") as string)?.trim();
    if (!label || !prompt) return Response.json({ error: "Label and prompt required" }, { status: 400 });
    await db.insert(extractionItems).values({ id: nanoid(), label, category: category || null, prompt, active: true });
    return Response.json({ ok: true });
  }

  if (intent === "delete") {
    await db.delete(extractionItems).where(eq(extractionItems.id, form.get("id") as string));
    return Response.json({ ok: true });
  }

  if (intent === "toggle") {
    const id = form.get("id") as string;
    const active = form.get("active") === "true";
    await db.update(extractionItems).set({ active: !active }).where(eq(extractionItems.id, id));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

// Default extraction items to seed on first use
const DEFAULTS = [
  { label: "Capital Stress", category: "Basel Pillar 1", prompt: "Determine if the article provides evidence that the entity is facing capital stress, including mentions of CET1 ratio, RWCR, capital buffer breaches, or regulatory capital directives." },
  { label: "Asset Quality Deterioration", category: "Basel Pillar 1", prompt: "Determine if the article mentions deteriorating asset quality, including NPL ratio increases, loan impairment charges, credit losses, or restructured loans." },
  { label: "Regulatory Action", category: "Supervisory", prompt: "Determine if a regulator (BNM, SC, HKMA, MAS, etc.) has taken formal action against the entity, including fines, directives, enforcement orders, or license conditions." },
  { label: "M&A Activity", category: "Corporate", prompt: "Determine if the entity is involved in a merger, acquisition, divestiture, or strategic partnership announcement." },
];

export default function OpsExtraction() {
  const { items } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-white/50">{items.length} extraction items</p>
        <button onClick={() => setShowForm((v) => !v)} className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">
          + Add Item
        </button>
      </div>

      {items.length === 0 && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300/80">
          No extraction items yet. Seed defaults:
          {DEFAULTS.map((d) => (
            <fetcher.Form key={d.label} method="post" className="inline">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="label" value={d.label} />
              <input type="hidden" name="category" value={d.category} />
              <input type="hidden" name="prompt" value={d.prompt} />
              <button type="submit" className="ml-2 underline hover:text-amber-200">{d.label}</button>
            </fetcher.Form>
          ))}
        </div>
      )}

      {showForm && (
        <fetcher.Form method="post" className="mb-4 p-4 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg space-y-3">
          <input type="hidden" name="intent" value="create" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-white/50 mb-1">Label</label>
              <input name="label" required placeholder="e.g. Capital Stress" className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]" />
            </div>
            <div>
              <label className="block text-xs text-white/50 mb-1">Category</label>
              <input name="category" placeholder="e.g. Basel Pillar 1" className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)]" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-white/50 mb-1">Extraction Prompt</label>
            <textarea name="prompt" required rows={3} placeholder="Describe what to look for in the article…" className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-md text-white focus:outline-none focus:border-[var(--color-accent)] resize-none" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 text-sm bg-[var(--color-accent)] text-white rounded-md hover:opacity-90">Save</button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-white/50 hover:text-white">Cancel</button>
          </div>
        </fetcher.Form>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="p-3 bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{item.label}</p>
                  {item.category && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-[var(--color-surface-2)] text-white/50 border border-[var(--color-border)]">
                      {item.category}
                    </span>
                  )}
                </div>
                <p className="text-xs text-white/40 mt-1 line-clamp-2">{item.prompt}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="toggle" />
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="active" value={String(item.active)} />
                  <button type="submit" className={`px-2 py-1 text-xs rounded-full border ${item.active ? "border-green-500/40 text-green-400" : "border-white/20 text-white/30"}`}>
                    {item.active ? "On" : "Off"}
                  </button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={item.id} />
                  <button type="submit" className="text-xs text-white/30 hover:text-red-400 px-2 py-1">✕</button>
                </fetcher.Form>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
